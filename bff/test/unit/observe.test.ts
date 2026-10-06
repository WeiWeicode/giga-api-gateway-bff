/**
 * W9-6:BFF 接 giga-observe 監控、前端遙測端點(MONITORING-PLAN §5.3、D5、D12)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import telemetryRoutes from '../../src/modules/telemetry/routes.js';
import observePlugin from '../../src/plugins/observe.js';

const received: { path: string; key: string; body: Record<string, unknown> }[] = [];
const observe = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url ?? '', key: String(req.headers['x-api-key']), body: JSON.parse(body || '{}') });
    res.writeHead(202, { 'content-type': 'application/json' }).end('{}');
  });
});

let app: FastifyInstance;
let counter = 0;

beforeAll(async () => {
  await new Promise<void>((r) => observe.listen(0, '127.0.0.1', r));
  const config = loadConfig({
    GW_DB_HOST: 'sql2012',
    GW_DB_NAME: 'giganexus_gw',
    GW_DB_USER: 'gw_app',
    GW_DB_PASSWORD: 'x',
    REDIS_URL: 'redis://redis:6379',
    JWT_KEYS_DIR: '/run/secrets/jwt',
    GW_ENV: 'test',
    MONITOR_URL: `http://127.0.0.1:${(observe.address() as AddressInfo).port}`,
    MONITOR_API_KEY: 'bff-ingest-key',
    MONITOR_WEB_API_KEY: 'bff-web-key',
  });
  app = Fastify({ trustProxy: true });
  // 監控需要的其他 plugin 以最小替身代替
  app.decorate('redis', { incr: async () => ++counter, expire: async () => 1, ping: async () => 'PONG' } as never);
  app.decorate('gwPool', { request: () => ({ query: async () => ({}) }) } as never);
  app.decorate('routeTable', { find: () => ({ route: { upstreamCode: 'itapp-api', routeType: 'proxy' }, params: {} }) } as never);
  app.decorateRequest('principal', async () => null);
  await app.register(observePlugin, { config });
  await app.register(telemetryRoutes, { config });
  app.post('/api/it/items', async (_req, reply) => {
    reply.header('x-route-code', 'it.item.create');
    return { ok: true };
  });
  app.get('/api/admin/boom', async () => {
    throw new Error('資料庫逾時');
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  observe.close();
});

describe('BFF 監控(W9-6)', () => {
  it('動態路由帶 routeCode / upstream;轉送用的 Buffer body 解析後遮罩', async () => {
    received.length = 0;
    await app.inject({
      method: 'POST',
      url: '/api/it/items',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-123' },
      payload: JSON.stringify({ name: 'a', password: 'p' }),
    });
    await app.monitor.flush();
    const logs = received.filter((r) => r.path === '/api/v1/ingest/logs').flatMap((r) => r.body.logs as Record<string, any>[]);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.meta).toEqual({ routeCode: 'it.item.create', upstream: 'itapp-api', routeType: 'proxy' });
    expect(logs[0]!.request.body).toEqual({ name: 'a', password: '***' });
    expect(received.find((r) => r.path === '/api/v1/ingest/logs')?.key).toBe('bff-ingest-key');
  });

  it('500 以 error 回報;遙測端點本身不記錄', async () => {
    received.length = 0;
    await app.inject({ method: 'GET', url: '/api/admin/boom' });
    await app.inject({ method: 'POST', url: '/api/telemetry/web', headers: { 'content-type': 'application/json' }, payload: { events: [] } });
    await app.monitor.flush();
    const logs = received.filter((r) => r.path === '/api/v1/ingest/logs').flatMap((r) => r.body.logs as Record<string, any>[]);
    expect(logs.map((l) => l.request.path)).toEqual(['/api/admin/boom']);
    expect(logs[0]!.level).toBe('error');
    expect(logs[0]!.error.message).toBe('資料庫逾時');
  });
});

describe('POST /api/telemetry/web(D5、D12)', () => {
  it('sendBeacon(text/plain)可送;補上 IP、匿名標記,以 ingest-web Key 轉送', async () => {
    received.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/telemetry/web',
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-forwarded-for': '10.10.112.50', 'user-agent': 'UA' },
      payload: JSON.stringify({
        events: [
          { app: 'itapp-web', type: 'error', message: 'x' },
          { app: 'BAD APP', type: 'error' },
          { app: 'itapp-web', type: 'hack' },
        ],
      }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const sent = received.find((r) => r.path === '/api/v1/ingest/web-events')!;
    expect(sent.key).toBe('bff-web-key');
    expect(sent.body.events).toMatchObject([{ app: 'itapp-web', ip: '10.10.112.50', anonymous: true, userId: null, ua: 'UA' }]);
  });

  it('不是合法 JSON → 400;同一 IP 超過每分鐘上限 → 429', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/telemetry/web', headers: { 'content-type': 'text/plain' }, payload: '{bad' })).statusCode).toBe(400);
    counter = 1000;
    const res = await app.inject({ method: 'POST', url: '/api/telemetry/web', headers: { 'content-type': 'application/json' }, payload: { events: [] } });
    expect(res.statusCode).toBe(429);
    counter = 0;
  });
});
