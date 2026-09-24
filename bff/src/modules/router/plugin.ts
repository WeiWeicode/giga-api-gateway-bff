/**
 * 動態路由(PRD §8.4、ARCHITECTURE.md D1):所有未被程式內建路由處理的 /api/* 請求,依路由表處理。
 *
 *   比對(記憶體路由樹)→ auth_mode / 權限 → 限流 → GET 快取 → proxy / aggregate / mock → 回應標頭清理 → 稽核
 */
import type { IncomingHttpHeaders } from 'node:http';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { apiAccessLog } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { identityOf, type Principal } from '../auth/plugin.js';
import { allowRequest, cacheKey, getCached, setCached } from './guards.js';
import type { SnapshotRoute, SnapshotStep } from './snapshot.js';
import { RouteSync } from './sync.js';
import { RouteTable } from './table.js';
import { UpstreamClient } from './upstream.js';

declare module 'fastify' {
  interface FastifyInstance {
    routeTable: RouteTable;
    routeSync: RouteSync;
    upstreams: UpstreamClient;
  }
}

/** 不轉給上游的請求標頭:hop-by-hop、Cookie、CSRF,以及任何 X-Internal-* / X-User-* / X-Auth-*(防偽造) */
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'cookie',
  'x-csrf-token',
  'x-api-key',
  'x-real-ip',
  // 上游不壓縮(回應可能被快取);對瀏覽器的壓縮由 Nginx gzip 處理
  'accept-encoding',
]);
const DROP_REQUEST_PREFIX = ['x-internal-', 'x-user-', 'x-auth-', 'x-forwarded-'];
/** 不回給瀏覽器的上游回應標頭(PRD §7.1、BACKEND-GUIDE §5.2) */
const DROP_RESPONSE = new Set([
  'set-cookie',
  'x-powered-by',
  'server',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'trailer',
  'upgrade',
  'content-length',
  'x-request-id',
]);
const DROP_RESPONSE_PREFIX = ['access-control-'];

function upstreamRequestHeaders(req: FastifyRequest, route: SnapshotRoute, forwardCookies: boolean, internalToken: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || DROP_REQUEST.has(k) || DROP_REQUEST_PREFIX.some((p) => k.startsWith(p))) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (forwardCookies && req.headers.cookie) {
    // 即使允許透傳 Cookie,也絕不把 Gateway 的 gn_* Token 帶給上游
    const kept = req.headers.cookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith('gn_'));
    if (kept.length) out.cookie = kept.join('; ');
  }
  out['x-request-id'] = req.id;
  out['x-forwarded-for'] = req.ips?.join(', ') ?? req.ip;
  out['x-forwarded-proto'] = 'https';
  if (internalToken) out['x-internal-token'] = internalToken;
  Object.assign(out, route.requestHeadersAdd ?? {});
  return out;
}

function cleanResponseHeaders(h: IncomingHttpHeaders, route: SnapshotRoute): Record<string, string | string[]> {
  const extra = new Set((route.responseHeadersRemove ?? []).map((x) => x.toLowerCase()));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || DROP_RESPONSE.has(k) || extra.has(k) || DROP_RESPONSE_PREFIX.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

/** 上游路徑:upstream_path 以參數代入;未設定時去除 /api/{system} 前綴(DATABASE.md §2) */
export function rewritePath(route: SnapshotRoute, reqPath: string, params: Record<string, string>): string {
  if (!route.upstreamPath) return reqPath.replace(new RegExp(`^/api/${route.systemCode}(?=/|$)`), '') || '/';
  return route.upstreamPath.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name] ?? '')).replace(/\*$/, () => params['*'] ?? '');
}

/** 聚合步驟路徑範本:{{params.id}}、{{query.x}}、{{user.emp}}、{{steps.todos.field}} */
export function renderTemplate(tpl: string, ctx: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, expr: string) => {
    let v: unknown = ctx;
    for (const part of expr.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    return encodeURIComponent(v === undefined || v === null ? '' : String(v));
  });
}

export default fp<{ config: AppConfig }>(
  async (app, { config }) => {
    const table = new RouteTable();
    const upstreams = new UpstreamClient(app.log);
    const sync = new RouteSync({
      db: app.db,
      redis: app.redis,
      table,
      log: app.log,
      snapshotFile: config.routeSnapshotFile,
      instanceId: config.instanceId,
      intervalMs: config.syncIntervalMs,
    });
    app.decorate('routeTable', table);
    app.decorate('routeSync', sync);
    app.decorate('upstreams', upstreams);
    app.addHook('onReady', async () => sync.start());
    app.addHook('onClose', async () => {
      await sync.stop();
      await upstreams.close();
    });

    async function authorize(req: FastifyRequest, route: SnapshotRoute, permission: string | null): Promise<Principal | null> {
      switch (route.authMode) {
        case 'public':
          return req.principal();
        case 'authenticated':
          return req.requirePrincipal();
        case 'permission': {
          const p = await req.requirePrincipal();
          if (!permission || !(await app.perms.has(p.userId, p.claims.pv, permission))) throw new GwError('PERMISSION_DENIED');
          return p;
        }
        default:
          // api_key(系統對系統)於第二階段 P2-5 實作
          throw new GwError('UNAUTHENTICATED');
      }
    }

    async function rateLimit(req: FastifyRequest, route: SnapshotRoute, p: Principal | null): Promise<void> {
      const policy = table.policy(route.rateLimitPolicy);
      if (!policy) return;
      const key = policy.keyBy === 'route' ? route.routeCode : policy.keyBy === 'user' && p ? `u${p.userId}` : `ip${req.ip}`;
      try {
        const ok = await allowRequest(
          app.redis,
          policy.code,
          policy.keyBy === 'route' ? key : `${route.routeCode}:${key}`,
          policy.limitCount,
          policy.windowSec,
        );
        if (!ok) throw new GwError('RATE_LIMITED');
      } catch (err) {
        if (err instanceof GwError) throw err;
        req.log.warn({ err: (err as Error).message }, 'Redis 限流不可用,放行');
      }
    }

    async function internalToken(p: Principal | null, audience: string | null): Promise<string | null> {
      return p && audience ? app.keys.signInternal(identityOf(p.claims), audience) : null;
    }

    async function proxy(req: FastifyRequest, reply: FastifyReply, route: SnapshotRoute, params: Record<string, string>, p: Principal | null) {
      const up = table.upstream(route.upstreamCode);
      if (!up) throw new GwError('UPSTREAM_UNAVAILABLE', '上游未設定');
      const [pathOnly, query] = [req.url.split('?')[0]!, req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''];
      const res = await app.upstreams.request(up, {
        method: route.upstreamMethod ?? req.method,
        path: rewritePath(route, pathOnly, params) + query,
        headers: upstreamRequestHeaders(req, route, up.forwardCookies, await internalToken(p, up.code)),
        body: req.body as Buffer | undefined,
        timeoutMs: route.timeoutMs ?? up.timeoutMs,
      });
      const headers = cleanResponseHeaders(res.headers, route);

      if (route.cacheTtlSec && route.cacheScope && req.method === 'GET' && res.status === 200) {
        const chunks: Buffer[] = [];
        for await (const c of res.body) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        const contentType = (res.headers['content-type'] as string | undefined) ?? null;
        setCached(app.redis, cacheKey(route.routeCode, req.url, route.cacheScope, p?.userId ?? null), route.cacheTtlSec, {
          status: 200,
          contentType,
          body: body.toString('base64'),
        }).catch(() => undefined);
        return reply.code(200).headers(headers).header('x-cache', 'MISS').send(body);
      }
      return reply.code(res.status).headers(headers).send(res.body);
    }

    async function aggregate(req: FastifyRequest, route: SnapshotRoute, params: Record<string, string>, p: Principal | null) {
      const result: Record<string, unknown> = {};
      const errors: { step: string; code: string }[] = [];
      const ctx = { params, query: req.query as Record<string, unknown>, user: p ? identityOf(p.claims) : {}, steps: result };
      const orders = [...new Set(route.steps.map((s) => s.stepOrder))].sort((a, b) => a - b);
      for (const order of orders) {
        const group = route.steps.filter((s) => s.stepOrder === order);
        await Promise.all(
          group.map(async (s: SnapshotStep) => {
            // 使用者無此步驟權限時略過(同一聚合 API 依權限回傳不同內容)
            if (s.permissionCode && !(p && (await app.perms.has(p.userId, p.claims.pv, s.permissionCode)))) return;
            try {
              const up = table.upstream(s.upstreamCode);
              if (!up) throw new GwError('UPSTREAM_UNAVAILABLE');
              const res = await app.upstreams.request(up, {
                method: s.method,
                path: renderTemplate(s.pathTemplate, ctx),
                headers: { accept: 'application/json', 'x-request-id': req.id, ...(p ? { 'x-internal-token': (await internalToken(p, up.code))! } : {}) },
                timeoutMs: s.timeoutMs,
              });
              const text = await res.body.text();
              if (res.status >= 400) throw new GwError('UPSTREAM_ERROR', `HTTP ${res.status}`);
              result[s.stepKey] = text ? JSON.parse(text) : null;
            } catch (err) {
              const code = err instanceof GwError ? err.code : 'UPSTREAM_ERROR';
              if (s.required) throw new GwError('UPSTREAM_ERROR', `必要步驟 ${s.stepKey} 失敗(${code})`);
              errors.push({ step: s.stepKey, code });
            }
          }),
        );
      }
      return { ...result, _meta: { errors } };
    }

    function audit(req: FastifyRequest, reply: FastifyReply, route: SnapshotRoute, p: Principal | null) {
      if (route.auditLevel === 'none') return;
      const body = route.auditLevel === 'body' && Buffer.isBuffer(req.body) ? req.body.toString('utf8').slice(0, 100_000) : null;
      app.db
        .insert(apiAccessLog)
        .values({
          requestId: req.id,
          routeCode: route.routeCode,
          userId: p?.userId ?? null,
          method: req.method,
          path: req.url.slice(0, 1000),
          status: reply.statusCode,
          durationMs: Math.round(reply.elapsedTime),
          body,
        })
        .catch((err: Error) => req.log.warn({ err: err.message }, '寫入 api_access_log 失敗'));
    }

    await app.register(async (scope) => {
      // 保留原始 body 轉給上游:所有 Content-Type 皆以 Buffer 讀取
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));

      scope.route({
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        url: '/api/*',
        handler: async (req, reply) => {
          const path = req.url.split('?')[0]!;
          const match = table.find(req.method, path);
          if (!match) throw new GwError('ROUTE_NOT_FOUND');
          const { route, params } = match;
          const p = await authorize(req, route, route.permissionCode);

          if (route.maxBodyKb && Buffer.isBuffer(req.body) && req.body.length > route.maxBodyKb * 1024) throw new GwError('PAYLOAD_TOO_LARGE');
          await rateLimit(req, route, p);
          if (route.status === 'deprecated') reply.header('deprecation', route.deprecatedAt ? new Date(route.deprecatedAt).toUTCString() : 'true');
          reply.header('x-route-code', route.routeCode);
          reply.raw.on('finish', () => audit(req, reply, route, p));

          if (route.routeType === 'mock') {
            if (config.gwEnv === 'prod') throw new GwError('ROUTE_NOT_FOUND');
            return reply.header('x-mock', '1').send(route.mockResponse ?? {});
          }
          if (route.routeType === 'aggregate') return aggregate(req, route, params, p);

          if (route.cacheTtlSec && route.cacheScope && req.method === 'GET') {
            const hit = await getCached(app.redis, cacheKey(route.routeCode, req.url, route.cacheScope, p?.userId ?? null)).catch(() => null);
            if (hit) {
              if (hit.contentType) reply.header('content-type', hit.contentType);
              return reply.code(hit.status).header('x-cache', 'HIT').send(Buffer.from(hit.body, 'base64'));
            }
          }
          return proxy(req, reply, route, params, p);
        },
      });
    });
  },
  { name: 'router', dependencies: ['db', 'redis', 'auth'] },
);
