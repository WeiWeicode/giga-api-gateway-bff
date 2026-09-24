import type { FastifyPluginAsync } from 'fastify';

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(p: Promise<T>, ms = CHECK_TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`逾時 ${ms} ms`)), ms).unref())]);
}

type CheckResult = { ok: true; ms: number } | { ok: false; ms: number; error: string };

async function check(fn: () => Promise<unknown>): Promise<CheckResult> {
  const start = performance.now();
  try {
    await withTimeout(fn());
    return { ok: true, ms: Math.round(performance.now() - start) };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - start), error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * PRD §8.1 / IMPL-PLAN W3-5.11:
 *   /healthz  存活檢查(行程可回應即 200)
 *   /readyz   就緒檢查:giganexus_gw 與 Redis;BPM / LOS 不列入(停機只告警,不影響服務就緒)
 */
const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  app.get('/readyz', { logLevel: 'warn' }, async (_req, reply) => {
    const [db, redis] = await Promise.all([check(() => app.gwPool.request().query('SELECT 1 AS ok')), check(() => app.redis.ping())]);
    const ready = db.ok && redis.ok;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: { giganexus_gw: db, redis },
      routes: { version: app.routeTable.version, source: app.routeSync.lastSource },
      upstreams: app.upstreams.breakerStates(),
    });
  });
};

export default healthRoutes;
