/**
 * docs/Gherkin/router/service-registration.feature(W3-5.7a、BACKEND-GUIDE §7.5)
 * 註冊只寫草稿、不發佈;測試上游 e2e-sample / 系統 e2ez,結束時刪除。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyCall, cleanupE2E, cli, closeAll, createApiKey, createLocalUser, EMP_PREFIX, login, query, Session } from './gw.js';

const GHERKIN = '場景: 查詢存在的項目\n  當 呼叫 GET /api/e2ez/items/1\n  那麼 回應 200';
const SPEC = {
  openapi: '3.0.3',
  info: { title: 'E2E Sample', version: '1.0.0' },
  'x-gateway': { upstream: 'e2e-sample', system: 'e2ez', project: 'E2ESample' },
  'x-permissions': [{ code: 'e2ez.item.read', name: 'E2E 項目查詢' }],
  paths: {
    '/v1/items': { get: { operationId: 'e2ez.item.list', summary: '項目清單', description: 'E2E 列出所有項目', 'x-permission': 'e2ez.item.read' } },
    '/v1/items/{id}': {
      get: { operationId: 'e2ez.item.get', summary: '查詢項目', description: 'E2E 依 ID 查詢單一項目', 'x-permission': 'e2ez.item.read', 'x-gherkin': GHERKIN },
    },
  },
};
const TARGET = 'http://e2e-sample-1:51299';
const EMP = `${EMP_PREFIX}E1`;
let key = '';
let svc: ReturnType<typeof apiKeyCall>;
const register = (body: unknown, k = key) => apiKeyCall(k)('POST', '/api/admin/registrations', body);

beforeAll(async () => {
  await cleanupE2E();
  key = await createApiKey('e2e-sample', ['gw.admin.route.register', 'gw.admin.route.read']);
  svc = apiKeyCall(key);
});
afterAll(async () => {
  await cleanupE2E();
  await closeAll();
});

describe('POST /api/admin/registrations', () => {
  it('沒有或錯誤的 X-Api-Key 回 401', async () => {
    expect((await new Session().post('/api/admin/registrations', { spec: SPEC, target: TARGET })).json.code).toBe('UNAUTHENTICATED');
    expect((await register({ spec: SPEC, target: TARGET }, key.slice(0, 8) + 'x'.repeat(32))).status).toBe(401);
  });

  it('寫入草稿(含說明與 Gherkin),不發佈', async () => {
    const res = await register({ spec: SPEC, target: TARGET });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      upstream: 'e2e-sample',
      created: 2,
      updated: 0,
      addedTargets: 1,
      createdPermissions: 1,
      pendingPublish: true,
      environment: 'test',
    });
    const rows = await query(
      "SELECT route_code, status, description, gherkin, source FROM gw.api_route WHERE route_code LIKE 'e2ez.item.%' ORDER BY route_code",
    );
    expect(rows).toEqual([
      { route_code: 'e2ez.item.get', status: 'draft', description: 'E2E 依 ID 查詢單一項目', gherkin: GHERKIN, source: 'openapi' },
      { route_code: 'e2ez.item.list', status: 'draft', description: 'E2E 列出所有項目', gherkin: null, source: 'openapi' },
    ]);
    await createLocalUser(EMP);
    expect((await (await login(EMP)).s.get('/api/e2ez/items')).json.code).toBe('ROUTE_NOT_FOUND');
  });

  it('重複註冊不變;另一台主機註冊只補上位址', async () => {
    expect((await register({ spec: SPEC, target: TARGET })).json).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 2,
      addedTargets: 0,
      pendingPublish: false,
    });
    expect((await register({ spec: SPEC, target: 'http://e2e-sample-2:51299' })).json.addedTargets).toBe(1);
    const targets = await query(
      "SELECT t.base_url, t.environment FROM gw.upstream_target t JOIN gw.upstream u ON u.upstream_id = t.upstream_id WHERE u.code = 'e2e-sample' ORDER BY t.base_url",
    );
    expect(targets).toEqual([
      { base_url: 'http://e2e-sample-1:51299', environment: 'test' },
      { base_url: 'http://e2e-sample-2:51299', environment: 'test' },
    ]);
  });

  it('只能註冊 API Key 所屬的服務;格式錯誤與 port 超出範圍回 IMPORT_HAS_ERRORS', async () => {
    const other = await register({ spec: { ...SPEC, 'x-gateway': { upstream: 'e2e-other', system: 'e2ez' } }, target: TARGET });
    expect(other.json.code).toBe('IMPORT_HAS_ERRORS');
    expect(JSON.stringify(other.json.details)).toMatch(/x-gateway\.upstream 必須是 e2e-sample/);
    const project = await register({ spec: { ...SPEC, 'x-gateway': { ...SPEC['x-gateway'], project: '../etc' } }, target: TARGET });
    expect(JSON.stringify(project.json.details)).toMatch(/x-gateway\.project/);
    const port = await register({ spec: SPEC, target: 'http://e2e-sample-1:8080' });
    expect(JSON.stringify(port.json.details)).toMatch(/UPSTREAM_PORT_OUT_OF_RANGE/);
    const kind = await register({ spec: { ...SPEC, 'x-permissions': [{ code: 'e2ez.item.read', name: 'x', kind: 'page' }] }, target: TARGET });
    expect(JSON.stringify(kind.json.details)).toMatch(/kind 需為/);
  });
});

describe('GET /api/admin/routes/catalog', () => {
  it('以 API Key 查詢:含草稿、說明、Gherkin 與開發專案', async () => {
    const res = await svc('GET', '/api/admin/routes/catalog?q=' + encodeURIComponent('E2E 依 ID'));
    expect(res.json.items).toEqual([
      expect.objectContaining({ routeCode: 'e2ez.item.get', status: 'draft', upstream: 'e2e-sample', project: 'E2ESample', gherkin: GHERKIN }),
    ]);
    expect((await svc('GET', '/api/admin/routes/catalog?q=E2ESample')).json.items.map((i: { routeCode: string }) => i.routeCode)).toEqual([
      'e2ez.item.get',
      'e2ez.item.list',
    ]);
    expect((await svc('GET', '/api/admin/routes/catalog?system=e2ez&status=published')).json.items).toEqual([]);
  });

  it('登入者需要 gw.admin.route.read', async () => {
    expect((await (await login(EMP)).s.get('/api/admin/routes/catalog?q=e2ez')).json.code).toBe('PERMISSION_DENIED');
  });

  it('來源 IP 不在允許清單回 403;API Key 停用後立即失效', async () => {
    const locked = (await cli('client:create', '--code', 'e2e-ip-locked', '--ips', '10.255.255.0/24')).key as string;
    expect((await apiKeyCall(locked)('GET', '/api/admin/routes/catalog?q=e2ez')).json.code).toBe('PERMISSION_DENIED');
    expect((await cli('client:disable', '--code', 'e2e-sample')).disabled).toBe(true);
    expect((await svc('GET', '/api/admin/routes/catalog?q=e2ez')).status).toBe(401);
  });
});
