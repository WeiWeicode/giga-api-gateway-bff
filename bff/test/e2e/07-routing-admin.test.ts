/**
 * 路由設定管理 API(P2-1)與發佈 / 回滾 API(P2-2):docs/Gherkin/router/route-admin.feature、release-publish.feature
 * 上游、政策以 e2e- 開頭,路由以 e2ez. 開頭(系統代碼 e2ez),結束時由 cleanupE2E 刪除並重新發佈。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyCall, cleanupE2E, closeAll, createApiKey, query, Session, waitFor } from './gw.js';

const PATH = '/api/e2ez/admin';
let admin: ReturnType<typeof apiKeyCall>;
let upstreamId = 0;
let upVer = '';
let policyId = 0;
let policyVer = '';
let routeId = 0;
let routeVer = '';
let firstVersion = 0;

beforeAll(async () => {
  await cleanupE2E();
  // 發佈會一併發佈所有草稿:有其他人的草稿時停止,不替別人發佈
  const [d] = await query("SELECT COUNT(*) AS n FROM gw.api_route WHERE status = 'draft' AND route_code NOT LIKE 'e2ez.%'");
  if (d.n > 0) throw new Error(`測試區有 ${d.n} 筆其他草稿,為避免一併發佈,請先處理`);
  admin = apiKeyCall(
    await createApiKey('e2e-routing', ['gw.admin.upstream.read', 'gw.admin.upstream.write', 'gw.admin.route.read', 'gw.admin.route.write', 'gw.admin.release']),
  );
});
afterAll(async () => {
  await cleanupE2E();
  const key = await createApiKey('e2e-routing-end', ['gw.admin.release']);
  await apiKeyCall(key)('POST', '/api/admin/releases', { note: 'E2E 路由管理測試移除' });
  await cleanupE2E();
  await closeAll();
});

describe('上游', () => {
  it('未登入 401;port 不在 51200–51300 回 UPSTREAM_PORT_OUT_OF_RANGE', async () => {
    expect((await new Session().get('/api/admin/upstreams')).status).toBe(401);
    const bad = await admin('POST', '/api/admin/upstreams', {
      code: 'e2e-up',
      name: 'E2E',
      systemCode: 'e2ez',
      targets: [{ baseUrl: 'http://e2e-nowhere:8080' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('UPSTREAM_PORT_OUT_OF_RANGE');
  });

  it('新增上游(本區位址);代碼重複 400', async () => {
    const res = await admin('POST', '/api/admin/upstreams', {
      code: 'e2e-up',
      name: 'E2E 上游',
      systemCode: 'e2ez',
      healthCheckPath: '/healthz',
      targets: [{ baseUrl: 'http://e2e-nowhere:51299' }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ code: 'e2e-up', environment: 'test', targets: [{ baseUrl: 'http://e2e-nowhere:51299', weight: 1 }] });
    expect(res.json.rowVer).toMatch(/^[0-9a-f]{16}$/);
    upstreamId = res.json.upstreamId;
    upVer = res.json.rowVer;
    expect((await admin('POST', '/api/admin/upstreams', { code: 'e2e-up', name: 'x', systemCode: 'e2ez' })).status).toBe(400);
  });

  it('樂觀鎖:以舊 rowVer 修改回 409 VERSION_CONFLICT', async () => {
    const ok = await admin('PATCH', `/api/admin/upstreams/${upstreamId}`, { rowVer: upVer, timeoutMs: 3000 });
    expect(ok.status).toBe(200);
    expect(ok.json.timeoutMs).toBe(3000);
    const stale = await admin('PATCH', `/api/admin/upstreams/${upstreamId}`, { rowVer: upVer, timeoutMs: 4000 });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('VERSION_CONFLICT');
    upVer = ok.json.rowVer;
  });

  it('健康檢查逐一回報位址結果(連不到 → ok=false)', async () => {
    const res = await admin('POST', `/api/admin/upstreams/${upstreamId}/health-check`);
    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([expect.objectContaining({ baseUrl: 'http://e2e-nowhere:51299', ok: false })]);
  });
});

describe('限流政策與路由', () => {
  it('新增限流政策', async () => {
    const res = await admin('POST', '/api/admin/rate-limit-policies', { code: 'e2e-rl', limitCount: 100, windowSec: 60, keyBy: 'ip' });
    expect(res.status).toBe(201);
    policyId = res.json.policyId;
    policyVer = res.json.rowVer;
  });

  it('BFF 內建系統代碼、路徑前綴不符、mock 缺回應內容 → 400', async () => {
    const base = { routeCode: 'e2ez.admin.get', name: 'E2E 管理 API 測試', method: 'GET', routeType: 'mock', authMode: 'public' };
    const reserved = await admin('POST', '/api/admin/routes', { ...base, systemCode: 'admin', publicPath: '/api/admin/x', mockResponse: {} });
    expect(reserved.json.details.map((d: { field: string }) => d.field)).toContain('systemCode');
    const prefix = await admin('POST', '/api/admin/routes', { ...base, systemCode: 'e2ez', publicPath: '/api/other/x', mockResponse: {} });
    expect(prefix.json.details.map((d: { field: string }) => d.field)).toEqual(['publicPath']);
    const noMock = await admin('POST', '/api/admin/routes', { ...base, systemCode: 'e2ez', publicPath: PATH });
    expect(noMock.json.details.map((d: { field: string }) => d.field)).toEqual(['mockResponse']);
  });

  it('新增 mock 路由為草稿;同方法同路徑 409 ROUTE_PATH_CONFLICT', async () => {
    const res = await admin('POST', '/api/admin/routes', {
      routeCode: 'e2ez.admin.get',
      name: 'E2E 管理 API 測試',
      systemCode: 'e2ez',
      method: 'GET',
      publicPath: PATH,
      routeType: 'mock',
      authMode: 'public',
      rateLimitPolicyId: policyId,
      mockResponse: { v: 1 },
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ status: 'draft', source: 'manual', rateLimitPolicy: 'e2e-rl', mockResponse: { v: 1 } });
    routeId = res.json.routeId;
    routeVer = res.json.rowVer;
    const dup = await admin('POST', '/api/admin/routes', {
      routeCode: 'e2ez.admin.dup',
      name: 'x',
      systemCode: 'e2ez',
      method: 'GET',
      publicPath: PATH,
      routeType: 'mock',
      authMode: 'public',
      mockResponse: {},
    });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('ROUTE_PATH_CONFLICT');
  });

  it('非聚合路由不可設定步驟', async () => {
    const res = await admin('PUT', `/api/admin/routes/${routeId}/steps`, {
      rowVer: routeVer,
      steps: [{ stepKey: 'a', stepOrder: 1, upstreamId, method: 'GET', pathTemplate: '/a' }],
    });
    expect(res.json.details.map((d: { field: string }) => d.field)).toContain('routeType');
  });

  it('政策仍被路由使用時不可刪除', async () => {
    const res = await admin('DELETE', `/api/admin/rate-limit-policies/${policyId}?rowVer=${policyVer}`);
    expect(res.status).toBe(400);
  });

  it('上游仍被路由使用時不可停用;停用路由後即可停用上游', async () => {
    const proxy = await admin('POST', '/api/admin/routes', {
      routeCode: 'e2ez.proxy.get',
      name: 'E2E proxy',
      systemCode: 'e2ez',
      method: 'GET',
      publicPath: '/api/e2ez/proxy',
      routeType: 'proxy',
      upstreamId,
      authMode: 'authenticated',
    });
    expect(proxy.status).toBe(201);
    const blocked = await admin('DELETE', `/api/admin/upstreams/${upstreamId}?rowVer=${upVer}`);
    expect(blocked.status).toBe(400);
    expect(blocked.json.details[0].message).toContain('e2ez.proxy.get');
    const off = await admin('DELETE', `/api/admin/routes/${proxy.json.routeId}?rowVer=${proxy.json.rowVer}`);
    expect(off.json.status).toBe('disabled');
    const res = await admin('DELETE', `/api/admin/upstreams/${upstreamId}?rowVer=${upVer}`);
    expect(res.status).toBe(200);
    expect(res.json.isEnabled).toBe(false);
  });
});

describe('發佈 / 回滾', () => {
  it('預覽列出草稿與差異;發佈後路由生效', async () => {
    const pv = await admin('GET', '/api/admin/releases/preview');
    expect(pv.json.drafts.map((d: { routeCode: string }) => d.routeCode)).toContain('e2ez.admin.get');
    expect(pv.json.diff.added).toContain('e2ez.admin.get');
    expect(pv.json.diff.added).not.toContain('e2ez.proxy.get');
    firstVersion = pv.json.currentVersion;

    const rel = await admin('POST', '/api/admin/releases', { note: 'E2E 路由管理測試' });
    expect(rel.status).toBe(200);
    expect(rel.json).toMatchObject({ version: expect.any(Number), redisSynced: true });
    expect(rel.json.version).toBeGreaterThan(firstVersion);
    await waitFor(async () => (await new Session().get(PATH)).json?.v === 1);
    expect((await admin('GET', `/api/admin/routes/${routeId}`)).json.status).toBe('published');
  });

  it('修改已發佈路由:改為草稿、線上仍是舊內容,再次發佈後生效', async () => {
    const cur = await admin('GET', `/api/admin/routes/${routeId}`);
    const res = await admin('PATCH', `/api/admin/routes/${routeId}`, { rowVer: cur.json.rowVer, mockResponse: { v: 2 } });
    expect(res.json.status).toBe('draft');
    expect((await new Session().get(PATH)).json).toEqual({ v: 1 });
    expect((await admin('GET', '/api/admin/releases/preview')).json.diff.modified).toContain('e2ez.admin.get');
    expect((await admin('POST', '/api/admin/releases', { note: 'E2E 修改' })).status).toBe(200);
    await waitFor(async () => (await new Session().get(PATH)).json?.v === 2);
  });

  it('回滾到發佈前的版本:產生新版本、rolled_back_from 記錄來源,路由移除', async () => {
    const res = await admin('POST', `/api/admin/releases/${firstVersion}/rollback`, { note: 'E2E 回滾' });
    expect(res.status).toBe(200);
    expect(res.json.rolledBackFrom).toBe(firstVersion);
    expect(res.json.diff.removed).toContain('e2ez.admin.get');
    await waitFor(async () => (await new Session().get(PATH)).json?.code === 'ROUTE_NOT_FOUND');
    const list = await admin('GET', '/api/admin/releases');
    expect(list.json.items[0]).toMatchObject({ version: res.json.version, rolledBackFrom: firstVersion });
  });

  it('稽核紀錄的操作人為 API Key', async () => {
    const logs = await query<{ action: string; actor_name: string }>(
      "SELECT action, actor_name FROM gw.audit_log WHERE actor_name = 'client:e2e-routing' AND occurred_at > DATEADD(MINUTE, -10, SYSUTCDATETIME())",
    );
    expect(new Set(logs.map((l) => l.action))).toEqual(
      new Set([
        'upstream.create',
        'upstream.update',
        'upstream.disable',
        'rate_limit.create',
        'route.create',
        'route.update',
        'route.disable',
        'release.publish',
        'release.rollback',
      ]),
    );
  });
});
