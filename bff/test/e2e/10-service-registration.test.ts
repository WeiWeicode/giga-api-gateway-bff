/** 後端自動註冊與路由查詢(BACKEND-GUIDE.md §7.5;Gherkin router/service-registration.feature) */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLoginFails, cli, closeAll, login, query, Session } from './gw.js';

const GHERKIN = '場景: 查詢存在的項目\n  當 呼叫 GET /api/smp/items/1\n  那麼 回應 200';
const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Sample', version: '1.0.0' },
  'x-gateway': { upstream: 'node-sample', system: 'smp' },
  'x-permissions': [{ code: 'smp.item.read', name: '項目查詢' }],
  paths: {
    '/v1/items': { get: { operationId: 'smp.item.list', summary: '項目清單', description: '列出所有項目', 'x-permission': 'smp.item.read' } },
    '/v1/items/{id}': {
      get: { operationId: 'smp.item.get', summary: '查詢項目', description: '依 ID 查詢單一項目', 'x-permission': 'smp.item.read', 'x-gherkin': GHERKIN },
    },
  },
};
const TARGET = 'http://sample-host-1:51290';

const svc = new Session();
let key = '';
const register = (body: unknown, apiKey = key) => svc.post('/api/admin/registrations', body, { headers: { 'x-api-key': apiKey } });
const catalog = (qs: string, apiKey = key) => svc.get(`/api/admin/routes/catalog?${qs}`, { 'x-api-key': apiKey });

async function cleanup() {
  await query("DELETE FROM gw.api_route WHERE route_code LIKE 'smp.%'");
  await query(`DELETE i FROM gw.api_import_item i JOIN gw.api_import_batch b ON b.batch_id = i.batch_id
               WHERE b.file_name = 'registration:node-sample' OR b.upstream_id IN (SELECT upstream_id FROM gw.upstream WHERE code = 'node-sample')`);
  await query(
    "DELETE FROM gw.api_import_batch WHERE file_name = 'registration:node-sample' OR upstream_id IN (SELECT upstream_id FROM gw.upstream WHERE code = 'node-sample')",
  );
  await query("DELETE FROM gw.upstream_target WHERE upstream_id IN (SELECT upstream_id FROM gw.upstream WHERE code = 'node-sample')");
  await query("DELETE FROM gw.upstream WHERE code = 'node-sample'");
  await query("DELETE FROM gw.permission WHERE code LIKE 'smp.%'");
  await query("DELETE FROM gw.api_client_permission WHERE client_id IN (SELECT client_id FROM gw.api_client WHERE code IN ('node-sample', 'e2e-ip-locked'))");
  await query("DELETE FROM gw.api_client WHERE code IN ('node-sample', 'e2e-ip-locked')");
}

beforeAll(async () => {
  await cleanup();
  key = (await cli('client:create', '--code', 'node-sample', '--name', 'Node 後端樣本')).key;
});
afterAll(async () => {
  await cleanup();
  await closeAll();
});

describe('POST /api/admin/registrations', () => {
  it('沒有或錯誤的 X-Api-Key 回 401', async () => {
    expect((await svc.post('/api/admin/registrations', { spec: SPEC, target: TARGET })).json.code).toBe('UNAUTHENTICATED');
    const bad = await register({ spec: SPEC, target: TARGET }, key.slice(0, 8) + 'x'.repeat(32));
    expect(bad.status).toBe(401);
  });

  it('寫入草稿(含說明與 Gherkin),不發佈', async () => {
    const res = await register({ spec: SPEC, target: TARGET });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ upstream: 'node-sample', created: 2, updated: 0, addedTargets: 1, createdPermissions: 1, pendingPublish: true });
    const rows = await query("SELECT route_code, status, description, gherkin, source FROM gw.api_route WHERE route_code LIKE 'smp.%' ORDER BY route_code");
    expect(rows).toEqual([
      { route_code: 'smp.item.get', status: 'draft', description: '依 ID 查詢單一項目', gherkin: GHERKIN, source: 'openapi' },
      { route_code: 'smp.item.list', status: 'draft', description: '列出所有項目', gherkin: null, source: 'openapi' },
    ]);
    // 未發佈:線上路由表沒有此路由
    const admin = (await login('S100001')).s;
    expect((await admin.get('/api/smp/items')).json.code).toBe('ROUTE_NOT_FOUND');
  });

  it('重複註冊不變;另一台主機註冊只補上位址,不覆蓋', async () => {
    expect((await register({ spec: SPEC, target: TARGET })).json).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 2,
      addedTargets: 0,
      pendingPublish: false,
    });
    expect((await register({ spec: SPEC, target: 'http://sample-host-2:51290' })).json.addedTargets).toBe(1);
    const targets = await query(
      "SELECT t.base_url, t.environment FROM gw.upstream_target t JOIN gw.upstream u ON u.upstream_id = t.upstream_id WHERE u.code = 'node-sample' ORDER BY t.base_url",
    );
    expect(targets).toEqual([
      { base_url: 'http://sample-host-1:51290', environment: 'test' },
      { base_url: 'http://sample-host-2:51290', environment: 'test' },
    ]);
  });

  it('只能註冊 API Key 所屬的服務,不可搶用其他上游的 route_code', async () => {
    const other = await register({ spec: { ...SPEC, 'x-gateway': { upstream: 'go-mes', system: 'smp' } }, target: TARGET });
    expect(other.status).toBe(400);
    expect(other.json.code).toBe('IMPORT_HAS_ERRORS');
    expect(JSON.stringify(other.json.details)).toMatch(/x-gateway\.upstream 必須是 node-sample/);

    const steal = {
      ...SPEC,
      'x-permissions': [{ code: 'mes.workorder.read', name: '工單查詢' }],
      paths: { '/v1/wo/{id}': { get: { operationId: 'mes.workorder.get', summary: '搶用', 'x-permission': 'mes.workorder.read' } } },
    };
    const res = await register({ spec: steal, target: TARGET });
    expect(res.json.code).toBe('IMPORT_HAS_ERRORS');
    expect(JSON.stringify(res.json.details)).toMatch(/route_code 已屬於其他上游:go-mes/);
  });

  it('port 不在 51200–51300 回 IMPORT_HAS_ERRORS', async () => {
    const res = await register({ spec: SPEC, target: 'http://sample-host-1:8080' });
    expect(res.json.code).toBe('IMPORT_HAS_ERRORS');
    expect(JSON.stringify(res.json.details)).toMatch(/UPSTREAM_PORT_OUT_OF_RANGE/);
  });

  it('來源 IP 不在 API Key 的允許清單回 403', async () => {
    const locked = (await cli('client:create', '--code', 'e2e-ip-locked', '--ips', '10.255.255.0/24')).key;
    expect((await catalog('q=smp', locked)).json.code).toBe('PERMISSION_DENIED');
  });
});

describe('GET /api/admin/routes/catalog', () => {
  it('以 API Key 查詢:含草稿、說明與 Gherkin', async () => {
    const res = await catalog('q=' + encodeURIComponent('單一項目'));
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([expect.objectContaining({ routeCode: 'smp.item.get', status: 'draft', upstream: 'node-sample', gherkin: GHERKIN })]);
    const byStatus = await catalog('system=smp&status=published');
    expect(byStatus.json.items).toEqual([]);
  });

  it('登入者需要 gw.admin.route.read', async () => {
    await clearLoginFails('S112009');
    const admin = (await login('S100001')).s;
    const res = await admin.get('/api/admin/routes/catalog?q=workorder');
    expect(res.json.items.map((i: { routeCode: string }) => i.routeCode)).toContain('mes.workorder.get');
    const op = (await login('S112009')).s;
    expect((await op.get('/api/admin/routes/catalog?q=workorder')).json.code).toBe('PERMISSION_DENIED');
  });

  it('API Key 停用後立即失效', async () => {
    expect((await cli('client:disable', '--code', 'node-sample')).disabled).toBe(true);
    expect((await catalog('q=smp')).status).toBe(401);
  });
});
