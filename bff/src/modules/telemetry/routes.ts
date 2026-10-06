/**
 * 前端健康度回報(MONITORING-PLAN D5、D12):POST /api/telemetry/web
 *
 * 瀏覽器不能持有 giga-observe 的 API Key,web-kit 以 navigator.sendBeacon 送到這裡,BFF 補上來源 IP、使用者後轉送
 * giga-observe POST /api/v1/ingest/web-events(scope ingest-web)。
 *
 *   - 登入前的頁面也能送(登入頁、忘記密碼),未登入事件標示 anonymous;不檢查 CSRF(sendBeacon 無法帶標頭,只寫監控資料)
 *   - 依來源 IP 限流(每分鐘 TELEMETRY_PER_MIN 次請求),單次最多 50 筆、64 KB
 *   - 立即回 202,轉送在背景進行;監控停用或 giga-observe 無法連線時直接丟棄,不影響前端
 */
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../../config.js';
import { GwError } from '../../errors.js';

export const TELEMETRY_PATH = '/api/telemetry/web';
const TELEMETRY_PER_MIN = 120;
const MAX_EVENTS = 50;
const APP_CODE = /^[a-z][a-z0-9-]{1,40}$/;
const TYPES = new Set(['error', 'api', 'vital', 'view']);

interface WebEvent {
  app?: unknown;
  type?: unknown;
  ts?: unknown;
  [k: string]: unknown;
}

/** sendBeacon 以 text/plain 或 application/json 送出;兩種都接受 */
function parseBody(body: unknown): WebEvent[] {
  let data: unknown = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      throw new GwError('VALIDATION_FAILED', 'body 不是合法的 JSON');
    }
  }
  const events = (data as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) throw new GwError('VALIDATION_FAILED', 'events 必須為陣列');
  return events
    .slice(0, MAX_EVENTS)
    .filter((e): e is WebEvent => !!e && typeof e === 'object' && typeof e.app === 'string' && APP_CODE.test(e.app) && TYPES.has(e.type as string));
}

const telemetry: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  const m = config.monitor;
  const enabled = (m.enabled ?? config.gwEnv !== 'dev') && !!m.url && !!m.webApiKey;
  const endpoint = enabled ? `${m.url!.replace(/\/$/, '')}/api/v1/ingest/web-events` : null;

  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));

  app.post(TELEMETRY_PATH, { bodyLimit: 64 * 1024, logLevel: 'warn', schema: { hide: true } }, async (req, reply) => {
    // 依來源 IP 限流;Redis 不可用時放行(監控資料不重要到要擋)
    try {
      const key = `gw:telemetry:${req.ip}:${Math.floor(Date.now() / 60_000)}`;
      const n = await app.redis.incr(key);
      if (n === 1) await app.redis.expire(key, 120);
      if (n > TELEMETRY_PER_MIN) throw new GwError('RATE_LIMITED');
    } catch (err) {
      if (err instanceof GwError) throw err;
    }

    const events = parseBody(req.body);
    if (!endpoint || !events.length) return reply.code(204).send();

    const p = await req.principal().catch(() => null);
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null;
    const enriched = events.map((e) => ({
      ...e,
      ts: typeof e.ts === 'string' ? e.ts : new Date().toISOString(),
      ip: req.ip,
      ua,
      userId: p?.claims.emp ?? null,
      anonymous: !p,
    }));

    // 背景轉送,不等待:監控不能拖慢前端
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': m.webApiKey!, 'x-request-id': req.id },
      body: JSON.stringify({ events: enriched }),
      signal: AbortSignal.timeout(2000),
    })
      .then(async (res) => {
        await res.body?.cancel().catch(() => undefined);
        if (!res.ok) req.log.debug({ status: res.status }, '前端事件轉送 giga-observe 失敗');
      })
      .catch((err: Error) => req.log.debug({ err: err.message }, '前端事件轉送 giga-observe 失敗'));

    return reply.code(202).send({ accepted: enriched.length });
  });
};

export default telemetry;
