/**
 * 路由試打(PRD §8.7、P2-1):POST /api/admin/routes/:id/test,權限 gw.admin.route.write,只接受登入者(以目前使用者身分試打)。
 *
 *   - 草稿也可試打(以資料庫目前設定組成路由,不需先發佈);已停用的路由不可試打
 *   - body:{ path?(實際路徑,含參數值;路由沒有參數時可省略), method?(路由方法為 * 時), query?, headers?, body? }
 *   - proxy:以本區(GW_ENV)上游位址呼叫,X-Internal-Token 為目前使用者;aggregate:依步驟順序呼叫並回傳各步驟結果;mock:回傳設定的內容
 *   - 不檢查路由權限,但回傳 wouldBeAllowed(目前使用者實際呼叫是否會被允許)
 *   - 使用獨立的上游連線池與斷路器,試打失敗不影響線上流量;試打可能有副作用(POST 等),一律寫入 gw.audit_log
 *   - 上游錯誤不以 HTTP 錯誤回應,而是放在結果的 error(管理介面直接顯示)
 */
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../../config.js';
import { apiRoute } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { identityOf } from '../auth/plugin.js';
import { renderTemplate, rewritePath } from '../router/plugin.js';
import { buildSnapshotContent, type SnapshotRoute } from '../router/snapshot.js';
import { RouteTable } from '../router/table.js';
import { UpstreamClient, type UpstreamResponse } from '../router/upstream.js';
import { writeAudit } from './audit-log.js';
import { createAuthorizer } from './authorize.js';

const PERM = 'gw.admin.route.write';
const MAX_BODY = 256 * 1024;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** 不允許由試打請求自訂的標頭 */
const BLOCKED_HEADERS = /^(host|connection|content-length|transfer-encoding|cookie|x-internal-|x-user-|x-auth-|x-forwarded-|x-api-key)/i;

interface TestBody {
  path?: string;
  method?: (typeof METHODS)[number];
  query?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface Captured {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  truncated: boolean;
}

async function capture(res: UpstreamResponse): Promise<Captured> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const c of res.body) {
    const buf = c as Buffer;
    if (size + buf.length > MAX_BODY) {
      chunks.push(buf.subarray(0, MAX_BODY - size));
      truncated = true;
      res.body.destroy();
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let body: unknown = text;
  if (!truncated && String(res.headers['content-type'] ?? '').includes('json')) {
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // 保留原文
    }
  }
  return { status: res.status, headers: res.headers, body, truncated };
}

const errorOf = (err: unknown) =>
  err instanceof GwError ? { code: err.code, message: err.message } : { code: 'UPSTREAM_ERROR', message: (err as Error).message };

const routeTest: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  const authorize = createAuthorizer(app);
  const env = config.gwEnv === 'prod' ? 'prod' : 'test';
  const client = new UpstreamClient(app.log);
  app.addHook('onClose', async () => client.close());

  app.post<{ Params: { id: number }; Body: TestBody }>(
    '/api/admin/routes/:id/test',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 1000, pattern: '^/' },
            method: { type: 'string', enum: [...METHODS] },
            query: { type: 'string', maxLength: 2000 },
            headers: { type: 'object', maxProperties: 20, additionalProperties: { type: 'string', maxLength: 1000 } },
            body: {},
          },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, PERM);
      if (actor.userId === null) throw new GwError('PERMISSION_DENIED', '試打需以使用者身分登入(以目前使用者身分呼叫上游)');
      const p = await req.requirePrincipal();
      const b = req.body ?? {};

      const [row] = await app.db.select({ routeCode: apiRoute.routeCode, status: apiRoute.status }).from(apiRoute).where(eq(apiRoute.routeId, req.params.id));
      if (!row) throw new GwError('VALIDATION_FAILED', '路由不存在', [{ field: 'id', message: String(req.params.id) }]);
      if (row.status === 'disabled') throw new GwError('VALIDATION_FAILED', '已停用的路由不可試打', [{ field: 'id', message: row.routeCode }]);
      const content = await buildSnapshotContent(app.db, env, { includeDrafts: true });
      const route = content.routes.find((r) => r.routeCode === row.routeCode);
      if (!route) throw new GwError('VALIDATION_FAILED', '路由不存在', [{ field: 'id', message: row.routeCode }]);

      const method = route.method === '*' ? (b.method ?? 'GET') : route.method;
      const path = b.path ?? route.publicPath;
      const table = new RouteTable();
      table.apply({ ...content, routes: [route], version: 1, publishedAt: new Date().toISOString() });
      const match = table.find(method, path);
      if (!match)
        throw new GwError('VALIDATION_FAILED', '路徑與路由的對外路徑不符(含參數的路由需提供實際路徑)', [
          { field: 'path', message: `${method} ${route.publicPath}` },
        ]);

      const wouldBeAllowed =
        route.authMode === 'public' || route.authMode === 'authenticated'
          ? true
          : route.authMode === 'permission'
            ? !!route.permissionCode && (await app.perms.has(p.userId, p.claims.pv, route.permissionCode))
            : false;
      const custom = Object.fromEntries(Object.entries(b.headers ?? {}).filter(([k]) => !BLOCKED_HEADERS.test(k)));
      const bodyBuf = b.body === undefined ? undefined : Buffer.from(JSON.stringify(b.body), 'utf8');
      const query = b.query ? `?${b.query.replace(/^\?/, '')}` : '';
      const started = performance.now();
      const result: Record<string, unknown> = {
        routeCode: route.routeCode,
        routeStatus: row.status,
        routeType: route.routeType,
        authMode: route.authMode,
        permissionCode: route.permissionCode,
        wouldBeAllowed,
        request: { method, path: path + query },
      };

      const tokenFor = (audience: string) => app.keys.signInternal(identityOf(p.claims), audience);

      if (route.routeType === 'mock') {
        result.response = { status: 200, headers: { 'content-type': 'application/json' }, body: route.mockResponse, truncated: false };
      } else if (route.routeType === 'proxy') {
        const up = content.upstreams.find((u) => u.code === route.upstreamCode);
        const upstreamPath = rewritePath(route as SnapshotRoute, path, match.params) + query;
        result.upstream = {
          code: route.upstreamCode,
          method: route.upstreamMethod ?? method,
          path: upstreamPath,
          targets: up?.targets.map((t) => t.baseUrl) ?? [],
        };
        try {
          if (!up || !up.targets.length) throw new GwError('UPSTREAM_UNAVAILABLE', `上游 ${route.upstreamCode ?? ''} 沒有本區(${env})位址`);
          const res = await client.request(up, {
            method: route.upstreamMethod ?? method,
            path: upstreamPath,
            headers: {
              accept: 'application/json',
              ...custom,
              ...(bodyBuf ? { 'content-type': 'application/json' } : {}),
              'x-request-id': req.id,
              'x-internal-token': await tokenFor(up.code),
              ...(route.requestHeadersAdd ?? {}),
            },
            body: bodyBuf,
            timeoutMs: route.timeoutMs ?? up.timeoutMs,
          });
          result.response = await capture(res);
        } catch (err) {
          result.error = errorOf(err);
        }
      } else {
        // aggregate:同一順序的步驟並行,依序執行;回傳各步驟結果
        const steps: Record<string, unknown>[] = [];
        const data: Record<string, unknown> = {};
        const ctx = { params: match.params, query: Object.fromEntries(new URLSearchParams(query)), user: identityOf(p.claims), steps: data };
        for (const order of [...new Set(route.steps.map((s) => s.stepOrder))].sort((x, y) => x - y)) {
          await Promise.all(
            route.steps
              .filter((s) => s.stepOrder === order)
              .map(async (s) => {
                const entry: Record<string, unknown> = { stepKey: s.stepKey, required: s.required, upstream: s.upstreamCode };
                steps.push(entry);
                if (s.permissionCode && !(await app.perms.has(p.userId, p.claims.pv, s.permissionCode))) {
                  entry.skipped = `目前使用者沒有權限 ${s.permissionCode}`;
                  return;
                }
                const up = content.upstreams.find((u) => u.code === s.upstreamCode);
                const stepPath = renderTemplate(s.pathTemplate, ctx);
                entry.request = { method: s.method, path: stepPath };
                try {
                  if (!up || !up.targets.length) throw new GwError('UPSTREAM_UNAVAILABLE', `上游 ${s.upstreamCode} 沒有本區(${env})位址`);
                  const res = await client.request(up, {
                    method: s.method,
                    path: stepPath,
                    headers: { accept: 'application/json', 'x-request-id': req.id, 'x-internal-token': await tokenFor(up.code) },
                    timeoutMs: s.timeoutMs,
                  });
                  const cap = await capture(res);
                  entry.response = cap;
                  if (cap.status < 400) data[s.stepKey] = cap.body;
                } catch (err) {
                  entry.error = errorOf(err);
                }
              }),
          );
        }
        result.steps = steps;
      }
      result.durationMs = Math.round(performance.now() - started);

      await app.db.transaction((tx) =>
        writeAudit(tx, actor, 'route.test', 'api_route', route.routeCode, null, {
          request: result.request,
          status: (result.response as Captured | undefined)?.status ?? null,
          error: (result.error as { code: string } | undefined)?.code ?? null,
        }),
      );
      return result;
    },
  );
};

export default routeTest;
