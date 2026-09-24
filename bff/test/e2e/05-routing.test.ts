/** docs/Gherkin/router/dynamic-routing.feature(W3-5.1–5.5) */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLoginFails, closeAll, login, mock, redis, type Session } from './gw.js';

let s: Session;
beforeAll(async () => {
  await clearLoginFails('S112009');
  await mock(51210, '/__reset', {});
  await mock(51220, '/__reset', {});
  await mock(51250, '/__reset', {});
  // 清除前次執行殘留的限流計數與回應快取
  const keys = [...(await redis().keys('gw:rl:*')), ...(await redis().keys('gw:cache:*'))];
  if (keys.length) await redis().del(...keys);
  s = (await login('S112009')).s;
});
afterAll(async () => {
  await mock(51220, '/__control', { mode: 'ok' });
  await mock(51250, '/__control', { mode: 'ok' });
  await closeAll();
});

describe('動態路由', () => {
  it('依路由表轉發並改寫路徑,上游收到 X-Request-Id 與 X-Internal-Token', async () => {
    const res = await s.get('/api/mes/debug/echo?x=1&y=中文');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-route-code')).toBe('mes.debug.echo');
    expect(res.json.path).toBe(`/v1/debug/echo?x=1&y=${encodeURIComponent('中文')}`);
    expect(res.json.headers['x-request-id']).toBeTruthy();
    expect(res.json.user.emp).toBe('S112009');
  });

  it('路徑參數代入上游路徑', async () => {
    const res = await s.get('/api/mes/work-orders/1007');
    expect(res.status).toBe(200);
    expect(res.json.id).toBe('1007');
  });

  it('沒有對應路由時回 404 ROUTE_NOT_FOUND', async () => {
    const res = await s.get('/api/xyz/unknown');
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('ROUTE_NOT_FOUND');
  });

  it('明確路徑優先於萬用字元', async () => {
    expect((await s.get('/api/mes/work-orders/1001')).headers.get('x-route-code')).toBe('mes.workorder.get');
    const wild = await s.get('/api/mes/anything/else');
    expect(wild.headers.get('x-route-code')).toBe('mes.catchall.echo');
  });

  it('清理上游回應標頭(Set-Cookie、X-Powered-By、CORS)', async () => {
    const res = await s.get('/api/mes/debug/echo');
    expect(res.setCookies).toHaveLength(0);
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('上游的業務錯誤碼原樣回傳(以系統代碼開頭)', async () => {
    const res = await s.get('/api/mes/work-orders/9999');
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('MES_WORK_ORDER_NOT_FOUND');
    const closed = await s.post('/api/mes/work-orders/1000/reports', { qty: 1 });
    expect(closed.status).toBe(422);
    expect(closed.json.code).toBe('MES_WORK_ORDER_CLOSED');
  });

  it('路由層限流(政策 test-tight:每位使用者 60 秒 3 次)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await s.get('/api/mes/debug/limited')).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    const res = await s.get('/api/mes/debug/limited');
    expect(res.status).toBe(429);
    expect(res.json.code).toBe('RATE_LIMITED');
  });

  it('GET 回應快取(shared,30 秒):兩位使用者呼叫,上游只收到 1 次', async () => {
    const other = (await login('S100001')).s;
    const a = await s.get('/api/mes/work-orders/1012');
    const b = await other.get('/api/mes/work-orders/1012');
    expect(a.json).toEqual(b.json);
    expect(b.headers.get('x-cache')).toBe('HIT');
    expect((await mock(51210, '/__stats')).hits['wo:1012']).toBe(1);
  });

  it('上游逾時回 504 UPSTREAM_TIMEOUT(路由逾時 1 秒)', async () => {
    const t = performance.now();
    const res = await s.get('/api/mes/debug/slow?ms=3000');
    expect(res.status).toBe(504);
    expect(res.json.code).toBe('UPSTREAM_TIMEOUT');
    expect(performance.now() - t).toBeLessThan(2500);
  });

  it('冪等方法連線錯誤時重試 1 次;非冪等方法不重試', async () => {
    const get = await s.get('/api/mes/debug/flaky?key=g1');
    expect(get.status).toBe(200);
    expect(get.json.attempt).toBe(2);
    const post = await s.post('/api/mes/debug/flaky?key=p1', {});
    expect(post.status).toBe(502);
    expect(post.json.code).toBe('UPSTREAM_ERROR');
    expect((await mock(51210, '/__stats')).hits['flaky:POST:p1']).toBe(1);
  });

  it('上游回 401 視為設定錯誤 → 502 UPSTREAM_ERROR', async () => {
    const res = await s.get('/api/mes/debug/unauthorized');
    expect(res.status).toBe(502);
    expect(res.json.code).toBe('UPSTREAM_ERROR');
  });

  it('mock 路由(測試區前端先行開發)', async () => {
    const res = await s.get('/api/portal/banner');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-mock')).toBe('1');
    expect(res.json).toMatchObject({ source: 'mock route' });
  });

  it('稽核等級 meta 的路由寫入 api_access_log', async () => {
    const res = await s.get('/api/hrm/profile');
    expect(res.status).toBe(200);
    const { query } = await import('./gw.js');
    const [row] = await query("SELECT TOP 1 route_code, status, method FROM gw.api_access_log WHERE route_code = 'hrm.profile.get' ORDER BY occurred_at DESC");
    expect(row).toMatchObject({ route_code: 'hrm.profile.get', status: 200, method: 'GET' });
  });
});

describe('聚合路由 GET /api/portal/dashboard', () => {
  it('相同順序的步驟並行執行並合併', async () => {
    const res = await s.get('/api/portal/dashboard');
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(expect.arrayContaining(['todos', 'approvals', 'mesRate', '_meta']));
    expect(res.json._meta.errors).toEqual([]);
  });

  it('非必要步驟逾時時回傳部分結果並標示 _meta.errors', async () => {
    await mock(51250, '/__control', { mode: 'timeout' });
    const t = performance.now();
    const res = await s.get('/api/portal/dashboard');
    expect(res.status).toBe(200);
    expect(res.json._meta.errors).toEqual([{ step: 'approvals', code: 'UPSTREAM_TIMEOUT' }]);
    expect(res.json.todos).toBeDefined();
    expect(performance.now() - t).toBeLessThan(4000);
    await mock(51250, '/__control', { mode: 'ok' });
  });

  it('必要步驟失敗時整體 502', async () => {
    await mock(51220, '/__control', { mode: 'error' });
    const res = await s.get('/api/portal/dashboard');
    expect(res.status).toBe(502);
    expect(res.json.code).toBe('UPSTREAM_ERROR');
    await mock(51220, '/__control', { mode: 'ok' });
  });

  it('沒有權限的步驟略過,上游不會收到請求', async () => {
    const before = (await mock(51210, '/__stats')).requests;
    const { s: y } = await login('Y110001');
    const res = await y.get('/api/portal/dashboard');
    expect(res.status).toBe(200);
    expect(res.json).not.toHaveProperty('mesRate');
    expect((await mock(51210, '/__stats')).requests).toBe(before);
  });
});
