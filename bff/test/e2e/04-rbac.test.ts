/**
 * docs/Gherkin/rbac/role-rules.feature、auth/apps.feature(P2-3a)、rbac/permission.feature(W3-4.6–4.8)
 * 測試角色只授予 it.app.access,指派規則只比對假部門 Z99E2E-DEPT,不影響真實使用者。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyCall, cleanupE2E, cli, cliApply, closeAll, createApiKey, createLocalUser, EMP_PREFIX, login, query, Session } from './gw.js';

const EMP = `${EMP_PREFIX}C1`;
const DEPT = `${EMP_PREFIX}-DEPT`;
const ROLE = 'e2e-rule-it';
let admin: ReturnType<typeof apiKeyCall>;
let ruleId = 0;

beforeAll(async () => {
  await cleanupE2E();
  await createLocalUser(EMP);
  // 假帳號的人事欄位(LOS / BPM 查無,直接寫入)
  await query("UPDATE gw.[user] SET dept_code = @d, job_level = '7', title = N'E2E 工程師', perm_version = perm_version + 1 WHERE employee_no = @e", {
    d: DEPT,
    e: EMP,
  });
  admin = apiKeyCall(await createApiKey('e2e-rbac', ['gw.admin.rbac.read', 'gw.admin.rbac.write', 'gw.admin.route.read']));
  await cliApply(`roles:\n  - code: ${ROLE}\n    name: E2E 規則測試\n    permissions: [it.app.access]\n`);
});
afterAll(async () => {
  await cleanupE2E();
  await closeAll();
});

const appCodes = (apps: { code: string }[]) => apps.map((a) => a.code);

describe('權限設定管理 API', () => {
  it('未登入 401;沒有 gw.admin.rbac.read 的使用者 403', async () => {
    expect((await new Session().get('/api/admin/roles')).status).toBe(401);
    const { s } = await login(EMP);
    const res = await s.get('/api/admin/roles');
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('PERMISSION_DENIED');
  });

  it('應用清單依 sort;權限樹以應用的 app 權限為根,依 sort 列出選單', async () => {
    const apps = await admin('GET', '/api/admin/apps');
    expect(appCodes(apps.json.items).slice(0, 2)).toEqual(['portal', 'it']);
    const tree = await admin('GET', '/api/admin/permissions?tree=1&app=portal');
    const root = tree.json.items[0];
    expect(root).toMatchObject({ code: 'portal.app.access', kind: 'app' });
    expect(root.children.length).toBeGreaterThanOrEqual(10);
    expect(root.children[0]).toMatchObject({ code: 'portal.home.read', kind: 'menu' });
    const leave = root.children.find((c: { code: string }) => c.code === 'portal.leave.read');
    expect(leave.children.map((c: { kind: string }) => c.kind)).toEqual(expect.arrayContaining(['tab', 'button']));
  });

  it('角色權限:gw-super-admin 不開放修改;不存在的權限代碼 400', async () => {
    expect((await admin('PUT', '/api/admin/roles/gw-super-admin/permissions', { permissions: [] })).status).toBe(403);
    const bad = await admin('PUT', `/api/admin/roles/${ROLE}/permissions`, { permissions: ['e2e.no.such'] });
    expect(bad.status).toBe(400);
    expect((await admin('GET', `/api/admin/roles/${ROLE}/permissions`)).json.permissions).toEqual(['it.app.access']);
  });

  it('規則至少要有一個條件;部門代碼須存在', async () => {
    expect((await admin('POST', `/api/admin/roles/${ROLE}/rules`, {})).json.code).toBe('VALIDATION_FAILED');
    expect((await admin('POST', `/api/admin/roles/${ROLE}/rules`, { deptCode: `${EMP_PREFIX}-NOPE` })).json.details[0].field).toBe('deptCode');
  });
});

describe('指派規則 → 權限 → me.apps', () => {
  it('新增規則(部門、職級 7)後,權限試算命中且來源為規則', async () => {
    const res = await admin('POST', `/api/admin/roles/${ROLE}/rules`, { deptCode: DEPT, jobLevels: ['7'], description: 'E2E' });
    expect(res.status).toBe(201);
    ruleId = res.json.ruleId;
    const p = await admin('POST', '/api/admin/rbac/preview', { employeeNo: EMP });
    const hit = p.json.roles.find((r: { code: string }) => r.code === ROLE);
    expect(hit).toMatchObject({ sources: ['rule'], ruleIds: [ruleId] });
    expect(appCodes(p.json.apps)).toEqual(['portal', 'it']);
    // 假設條件(不含 AD 群組)
    const hypo = await admin('POST', '/api/admin/rbac/preview', { deptCode: DEPT, jobLevel: '6' });
    expect(hypo.json.roles.map((r: { code: string }) => r.code)).not.toContain(ROLE);
  });

  it('登入後 /api/auth/me 的 apps 與試算一致(portal、it)', async () => {
    const { s } = await login(EMP);
    const me = (await s.get('/api/auth/me')).json;
    expect(appCodes(me.apps)).toEqual(['portal', 'it']);
    expect(me.roles).toContain(ROLE);
  });

  it('修改規則後所有人 perm_version 遞增:已登入者須 Refresh,換發後不再有 it', async () => {
    const { s } = await login(EMP);
    expect((await s.get('/api/auth/me')).status).toBe(200);
    const res = await admin('PATCH', `/api/admin/roles/${ROLE}/rules/${ruleId}`, { jobLevels: ['8'] });
    expect(res.json.jobLevels).toEqual(['8']);
    expect((await s.get('/api/auth/me')).status).toBe(401);
    expect((await s.post('/api/auth/refresh')).status).toBe(200);
    expect(appCodes((await s.get('/api/auth/me')).json.apps)).toEqual(['portal']);
  });

  it('刪除規則;稽核紀錄的操作人為 API Key', async () => {
    expect((await admin('DELETE', `/api/admin/roles/${ROLE}/rules/${ruleId}`)).status).toBe(204);
    expect((await admin('GET', `/api/admin/roles/${ROLE}/rules`)).json.items).toEqual([]);
    const logs = await query<{ action: string; actor_name: string }>(
      "SELECT action, actor_name FROM gw.audit_log WHERE entity_type = 'role_rule' AND entity_id = @id ORDER BY audit_id",
      {
        id: String(ruleId),
      },
    );
    expect(logs.map((l) => l.action)).toEqual(['role.rule.create', 'role.rule.update', 'role.rule.delete']);
    expect(new Set(logs.map((l) => l.actor_name))).toEqual(new Set(['client:e2e-rbac']));
  });

  it('部門樹 API 可讀(部門同步待 BPM view)', async () => {
    const res = await admin('GET', '/api/admin/departments');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.items)).toBe(true);
  });
});

describe('路由權限(E2E mock 路由)', () => {
  const PATH = '/api/e2ez/ping';

  beforeAll(async () => {
    // 發佈會一併發佈所有草稿:有其他人的草稿時停止,不替別人發佈
    const [d] = await query("SELECT COUNT(*) AS n FROM gw.api_route WHERE status = 'draft' AND route_code NOT LIKE 'e2ez.%'");
    if (d.n > 0) throw new Error(`測試區有 ${d.n} 筆其他草稿,為避免一併發佈,略過路由測試前請先處理`);
    await cliApply(
      [
        'permissions:',
        '  - { code: e2ez.route.read, name: E2E 路由測試 }',
        'routes:',
        '  - routeCode: e2ez.ping.get',
        '    name: E2E 路由測試',
        '    systemCode: e2ez',
        '    method: GET',
        `    publicPath: ${PATH}`,
        '    routeType: mock',
        '    authMode: permission',
        '    permissionCode: e2ez.route.read',
        '    mockResponse: { pong: true }',
      ].join('\n'),
    );
    await cli('publish', '--note', 'E2E 路由測試(測試結束後移除)');
  });
  afterAll(async () => {
    await query("DELETE FROM gw.api_route WHERE route_code LIKE 'e2ez.%'");
    await cli('publish', '--note', 'E2E 路由測試移除');
  });

  it('未登入 401;沒有權限 403 PERMISSION_DENIED', async () => {
    expect((await new Session().get(PATH)).json.code).toBe('UNAUTHENTICATED');
    const { s } = await login(EMP);
    const res = await s.get(PATH);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('PERMISSION_DENIED');
  });

  it('以指派規則取得權限後可呼叫(mock 回應)', async () => {
    await cliApply('roles:\n  - code: e2e-route\n    name: E2E 路由權限\n    permissions: [e2ez.route.read]\n');
    expect((await admin('POST', '/api/admin/roles/e2e-route/rules', { deptCode: DEPT })).status).toBe(201);
    const { s } = await login(EMP);
    const res = await s.get(PATH);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ pong: true });
  });
});
