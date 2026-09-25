/** IT 新員工上手導覽:API 上架預覽(唯讀,dev / test 限定) */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLoginFails, closeAll, login, query, type Session } from './gw.js';

const SPEC = {
  'x-gateway': { upstream: 'core-fms', system: 'fms' },
  'x-permissions': [{ code: 'fms.invoice.read', name: '發票查詢' }],
  paths: {
    '/v1/invoices/{id}': { get: { operationId: 'fms.invoice.get', summary: '查詢發票', 'x-permission': 'fms.invoice.read' } },
  },
};

let admin: Session;
beforeAll(async () => {
  for (const e of ['S100001', 'S112009']) await clearLoginFails(e);
  admin = (await login('S100001')).s;
});
afterAll(closeAll);

describe('OpenAPI 匯入預覽', () => {
  it('新服務:全部為新增,列出會寫入的資料表,且不寫入資料庫', async () => {
    const res = await admin.post('/api/admin/demo/openapi-preview', { spec: SPEC, target: 'http://fms-host:51230' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ canCommit: true, upstream: { code: 'core-fms', exists: false }, summary: { total: 1, create: 1 } });
    expect(res.json.items[0]).toMatchObject({ routeCode: 'fms.invoice.get', publicPath: '/api/fms/invoices/:id', upstreamPath: '/v1/invoices/:id' });
    expect(res.json.writes.map((w: { table: string }) => w.table)).toContain('api_route');
    expect(await query("SELECT * FROM gw.api_route WHERE route_code LIKE 'fms.%'")).toHaveLength(0);
    expect(await query("SELECT * FROM gw.upstream WHERE code = 'core-fms'")).toHaveLength(0);
  });

  it('缺少 x-permission 列為錯誤列;port 不在 51200–51300 時不可提交', async () => {
    const spec = { ...SPEC, paths: { ...SPEC.paths, '/v1/bad': { get: { operationId: 'fms.bad.get', summary: 'x' } } } };
    const res = await admin.post('/api/admin/demo/openapi-preview', { spec, target: 'http://fms-host:8080' });
    expect(res.json.canCommit).toBe(false);
    expect(res.json.summary.error).toBe(1);
    expect(res.json.items.find((i: { routeCode: string }) => i.routeCode === 'fms.bad.get').action).toBe('error');
    expect(res.json.errors[0].message).toMatch(/UPSTREAM_PORT_OUT_OF_RANGE/);
  });

  it('既有路由:相同為不變、改名為更新', async () => {
    const spec = {
      'x-gateway': { upstream: 'go-mes', system: 'mes' },
      'x-permissions': [{ code: 'mes.workorder.read', name: '工單查詢' }],
      paths: {
        '/v1/work-orders/{id}': {
          get: { operationId: 'mes.workorder.get', summary: '查詢工單', 'x-permission': 'mes.workorder.read', 'x-cache-ttl': 30, 'x-cache-scope': 'shared' },
        },
        '/v1/work-orders': { get: { operationId: 'mes.workorder.list', summary: '改名', 'x-permission': 'mes.workorder.read' } },
      },
    };
    const res = await admin.post('/api/admin/demo/openapi-preview', { spec, target: 'http://mock-mes:51210' });
    const byCode = Object.fromEntries(res.json.items.map((i: { routeCode: string }) => [i.routeCode, i]));
    expect(byCode['mes.workorder.get'].action).toBe('unchanged');
    expect(byCode['mes.workorder.list']).toMatchObject({ action: 'update', changedFields: ['name'] });
  });
});

describe('手動新增預覽與權限反查', () => {
  it('路徑衝突與上游位址', async () => {
    const base = {
      routeCode: 'fms.budget.get',
      name: 'x',
      systemCode: 'mes',
      method: 'GET',
      routeType: 'proxy',
      upstreamCode: 'go-mes',
      authMode: 'authenticated',
    };
    const conflict = await admin.post('/api/admin/demo/route-preview', { ...base, publicPath: '/api/mes/work-orders/:id' });
    expect(conflict.json.ok).toBe(false);
    expect(conflict.json.errors.join()).toMatch(/ROUTE_PATH_CONFLICT.*mes\.workorder\.get/);
    const ok = await admin.post('/api/admin/demo/route-preview', { ...base, publicPath: '/api/mes/budgets/:year', upstreamPath: '/v1/budgets/:year' });
    expect(ok.json).toMatchObject({ ok: true, flow: { upstream: 'GET http://mock-mes:51210/v1/budgets/:year' } });
  });

  it('反查擁有權限的角色、AD 群組與公司', async () => {
    const res = await admin.get('/api/admin/demo/who-can-access?permission=mes.workorder.read');
    const roles = Object.fromEntries(res.json.roles.map((r: { code: string }) => [r.code, r]));
    expect(roles['mes-operator'].adGroups).toContain('CN=GN-MES-Operators,OU=Groups,DC=gsc,DC=com,DC=tw');
    expect(roles['hv-employee'].companies).toContain('禾迅');
    expect((await admin.get('/api/admin/demo/who-can-access?permission=fms.invoice.read')).json.exists).toBe(false);
  });

  it('沒有管理權限者 403', async () => {
    const { s } = await login('S112009');
    expect((await s.get('/api/admin/demo/catalog')).status).toBe(403);
    expect((await s.post('/api/admin/demo/openapi-preview', { spec: SPEC, target: 'http://fms-host:51230' })).status).toBe(403);
  });
});
