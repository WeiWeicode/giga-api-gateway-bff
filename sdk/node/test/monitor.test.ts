/**
 * 監控模組自我檢查:npm test
 *   - 遮罩、body 摘要 / 截斷(與 giga-observe DB_SCHEMA §4 一致)
 *   - setupGateway:紀錄內容(traceId、pathTemplate、userId、錯誤完整 body)、忽略健康檢查
 *   - 鐵則:giga-observe 斷線、逾時、回 5xx 時,被監控服務不受影響
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupGateway } from '../src/fastify.js';
import { loadMonitorEnv, maskDeep, Monitor, prepareBody, type MonitorLog } from '../src/monitor.js';
import type { GatewayEnv } from '../src/env.js';

const gwEnv: GatewayEnv = {
  gwEnv: 'dev',
  serviceCode: 'node-sample',
  project: 'node-backend',
  gatewayUrl: null,
  jwksUrl: 'http://127.0.0.1:1/.well-known/jwks.json',
  apiKey: null,
  advertiseUrl: null,
  autoRegister: false,
};

/** 假的 giga-observe:記錄收到的批次;mode 控制回應 */
function fakeObserve() {
  const logs: MonitorLog[] = [];
  const heartbeats: unknown[] = [];
  const state = { mode: 'ok' as 'ok' | 'fail' | 'hang', keys: [] as string[] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.keys.push(String(req.headers['x-api-key']));
      if (state.mode === 'hang') return; // 不回應,讓 SDK 逾時
      if (state.mode === 'fail') return res.writeHead(503).end();
      const json = JSON.parse(body || '{}');
      if (req.url === '/api/v1/ingest/logs') logs.push(...json.logs);
      else heartbeats.push(json);
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"success":true}');
    });
  });
  return { server, logs, heartbeats, state };
}

describe('maskDeep / prepareBody', () => {
  it('遮罩敏感欄位(含巢狀、大小寫、-_ 變體),處理循環參考與 toJSON', () => {
    const o: Record<string, unknown> = { user: 'a', Password: 'x', nested: { api_key: 'k', 'X-Auth-Token': 't', ok: 1 }, when: new Date(0) };
    o.self = o;
    const m = maskDeep(o, ['empNo']) as Record<string, unknown>;
    assert.equal(m.Password, '***');
    assert.deepEqual(m.nested, { api_key: '***', 'X-Auth-Token': '***', ok: 1 });
    assert.equal(m.when, '1970-01-01T00:00:00.000Z');
    assert.equal(m.self, '[circular]');
    assert.equal((maskDeep({ empNo: 'S1' }, ['empNo']) as Record<string, unknown>).empNo, '***');
  });

  it('成功只存前 1 KB 摘要,錯誤存完整(32 KB 截斷);multipart 只記大小', () => {
    const big = 'x'.repeat(5000);
    const ok = prepareBody(big, false, { bodySummaryBytes: 1024, bodyMaxBytes: 32768 });
    assert.equal((ok.body as string).length, 1024);
    assert.equal(ok.bodyTruncated, true);
    assert.equal(ok.bodySize, 5000);
    const err = prepareBody(big, true, { bodySummaryBytes: 1024, bodyMaxBytes: 32768 });
    assert.equal(err.body, big);
    assert.equal(err.bodyTruncated, false);
    assert.equal(prepareBody({ a: 1 }, false, { bodySummaryBytes: 1024, bodyMaxBytes: 32768 }, 'multipart/form-data; boundary=x').body, '[multipart]');
    assert.equal(prepareBody(undefined, false, { bodySummaryBytes: 1, bodyMaxBytes: 1 }).body, null);
  });
});

describe('loadMonitorEnv', () => {
  it('dev 預設關閉、test 預設開啟;缺 URL 或 Key 時停用而不報錯', () => {
    assert.equal(loadMonitorEnv('dev', { MONITOR_URL: 'http://o:5132', MONITOR_API_KEY: 'k' }).enabled, false);
    assert.equal(loadMonitorEnv('dev', { MONITOR_URL: 'http://o:5132', MONITOR_API_KEY: 'k', MONITOR_ENABLED: 'true' }).enabled, true);
    assert.equal(loadMonitorEnv('test', { MONITOR_URL: 'http://o:5132/', MONITOR_API_KEY: 'k' }).endpoint, 'http://o:5132');
    assert.equal(loadMonitorEnv('test', { MONITOR_URL: 'http://o:5132' }).enabled, false);
    assert.equal(loadMonitorEnv('test', { MONITOR_URL: 'http://o:5132', MONITOR_API_KEY: 'k', MONITOR_ENABLED: 'false' }).enabled, false);
  });

  it('正式區不接受明文 MONITOR_API_KEY', () => {
    assert.throws(() => loadMonitorEnv('prod', { MONITOR_URL: 'http://o:5132', MONITOR_API_KEY: 'k' }), /MONITOR_API_KEY_FILE/);
  });
});

describe('setupGateway(Fastify)', () => {
  const observe = fakeObserve();
  let app: FastifyInstance;

  before(async () => {
    await new Promise<void>((r) => observe.server.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(observe.server.address() as AddressInfo).port}`;
    app = Fastify({ logger: false, requestIdHeader: 'x-request-id' });
    await app.register(setupGateway, {
      env: gwEnv,
      monitor: { enabled: true, endpoint, apiKey: 'ingest-key' },
      monitorOptions: { flushIntervalMs: 60_000, heartbeatSec: 0, timeoutMs: 300 },
      version: '9.9.9',
      register: false,
      meta: (_req, reply) => ({ routeCode: String(reply.getHeader('x-route-code') ?? '') || null }),
    });
    app.decorateRequest('identity', null);
    app.addHook('preHandler', async (req) => {
      (req as unknown as { identity: unknown }).identity = { sub: 'u1', emp: 'S112009' };
    });
    app.get('/healthz', async () => ({ status: 'ok' }));
    app.post('/items/:id', async (req, reply) => {
      req.monitor.action('db', 'mssql.items', 12, 'insert');
      reply.header('x-route-code', 'sample.item.create');
      return { id: (req.params as { id: string }).id, ok: true };
    });
    app.get('/boom', async () => {
      throw new Error('資料庫連線失敗');
    });
    app.get('/soft-fail', async (req) => {
      req.monitor.fail(new Error('第三方回傳格式錯誤'), '已改用預設值');
      return { degraded: true };
    });
  });

  after(async () => {
    await app.close();
    observe.server.close();
  });

  it('成功請求:traceId、pathTemplate、userId、步驟、遮罩、meta 都有;健康檢查不記錄', async () => {
    await app.inject({ method: 'GET', url: '/healthz' });
    const res = await app.inject({
      method: 'POST',
      url: '/items/42?draft=1',
      headers: { 'x-request-id': 'req-abc', 'x-forwarded-for': '10.10.112.50, 172.18.0.5', authorization: 'Bearer secret' },
      payload: { title: 't', password: 'p' },
    });
    assert.equal(res.statusCode, 200);
    await app.monitor.flush();
    assert.equal(observe.logs.length, 1);
    const log = observe.logs[0]!;
    assert.equal(log.traceId, 'req-abc');
    assert.equal(log.level, 'info');
    assert.equal(log.request.pathTemplate, '/items/:id');
    assert.equal(log.request.path, '/items/42');
    assert.equal(log.request.userId, 'S112009');
    assert.equal(log.request.ip, '10.10.112.50');
    assert.deepEqual(log.request.body, { title: 't', password: '***' });
    assert.equal((log.request.headers as Record<string, unknown>).authorization, undefined);
    assert.equal(log.actions[0]?.target, 'mssql.items');
    assert.equal(log.meta?.routeCode, 'sample.item.create');
    assert.equal(observe.state.keys.at(-1), 'ingest-key');
  });

  it('500:level error、error 名稱與訊息、回應 body 解析為物件', async () => {
    observe.logs.length = 0;
    const res = await app.inject({ method: 'GET', url: '/boom' });
    assert.equal(res.statusCode, 500);
    await app.monitor.flush();
    const log = observe.logs[0]!;
    assert.equal(log.level, 'error');
    assert.equal(log.error?.message, '資料庫連線失敗');
    assert.equal(typeof log.response.body, 'object');
  });

  it('自報錯誤:回應 200 仍以 error 回報', async () => {
    observe.logs.length = 0;
    await app.inject({ method: 'GET', url: '/soft-fail' });
    await app.monitor.flush();
    assert.equal(observe.logs[0]?.level, 'error');
    assert.match(observe.logs[0]?.error?.message ?? '', /已改用預設值/);
  });

  it('giga-observe 逾時或回 5xx:請求照常完成,紀錄留在緩衝等重送', async () => {
    observe.logs.length = 0;
    for (const mode of ['hang', 'fail'] as const) {
      observe.state.mode = mode;
      const t0 = Date.now();
      const res = await app.inject({ method: 'POST', url: '/items/1', payload: {} });
      assert.equal(res.statusCode, 200);
      assert.ok(Date.now() - t0 < 200, '請求不等待監控送出');
      await app.monitor.flush(); // 逾時 300 ms 後放棄,不拋例外
      assert.ok(app.monitor.pending >= 1);
    }
    observe.state.mode = 'ok';
    await app.monitor.flush();
    assert.equal(app.monitor.pending, 0);
    assert.equal(observe.logs.length, 2);
  });
});

describe('Monitor', () => {
  it('giga-observe 不存在(連線被拒):不拋例外、緩衝滿了丟最舊', async () => {
    const warns: string[] = [];
    const m = new Monitor({
      endpoint: 'http://127.0.0.1:1',
      apiKey: 'k',
      heartbeatSec: 0,
      bufferSize: 3,
      batchSize: 100,
      flushIntervalMs: 60_000,
      warn: (w) => warns.push(w),
    });
    for (let i = 0; i < 5; i++) m.push({ ts: String(i) } as unknown as MonitorLog);
    assert.equal(m.pending, 3);
    assert.equal(warns.length, 1);
    await m.flush();
    assert.equal(m.pending, 3);
    await m.shutdown();
  });

  it('未設定 endpoint 或 apiKey 時停用,所有方法都是 no-op', async () => {
    const m = new Monitor({ endpoint: null, apiKey: null });
    assert.equal(m.enabled, false);
    m.push({} as MonitorLog);
    assert.equal(m.pending, 0);
    await m.job('x').success();
  });

  it('排程回報:一次執行一筆,失敗為 error', async () => {
    const observe = fakeObserve();
    await new Promise<void>((r) => observe.server.listen(0, '127.0.0.1', r));
    const m = new Monitor({
      endpoint: `http://127.0.0.1:${(observe.server.address() as AddressInfo).port}`,
      apiKey: 'k',
      heartbeatSec: 0,
      flushIntervalMs: 60_000,
    });
    const job = m.job('employee-sync', { params: { token: 'x', company: '碩禾' } });
    job.action('db', 'bpm.emp', 120);
    await job.fail(new Error('BPM 連線逾時'));
    observe.server.close();
    const log = observe.logs[0]!;
    assert.equal(log.kind, 'job');
    assert.equal(log.level, 'error');
    assert.deepEqual((log.request.body as { params: unknown }).params, { token: '***', company: '碩禾' });
    await m.shutdown();
  });
});

describe('setupGateway:原始 Buffer body(BFF 轉送上游時不解析 body)', () => {
  it('JSON Buffer 解析後遮罩;非文字只記大小', async () => {
    const observe = fakeObserve();
    await new Promise<void>((r) => observe.server.listen(0, '127.0.0.1', r));
    const app = Fastify({ logger: false });
    await app.register(setupGateway, {
      monitor: { enabled: true, endpoint: `http://127.0.0.1:${(observe.server.address() as AddressInfo).port}`, apiKey: 'k' },
      monitorOptions: { flushIntervalMs: 60_000, heartbeatSec: 0 },
      register: false,
    });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    app.post('/proxy', async () => ({ ok: true }));
    await app.inject({ method: 'POST', url: '/proxy', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ user: 'a', token: 't' }) });
    await app.inject({ method: 'POST', url: '/proxy', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from([1, 2, 3]) });
    await app.monitor.flush();
    assert.deepEqual(observe.logs[0]?.request.body, { user: 'a', token: '***' });
    assert.equal(observe.logs[1]?.request.body, '[binary 3 bytes]');
    await app.close();
    observe.server.close();
  });
});
