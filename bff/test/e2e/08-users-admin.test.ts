/**
 * 使用者、公司與本機帳號管理 API(P2-3):docs/Gherkin/admin/user-admin.feature
 * 假工號 Z99E2E 開頭、角色 e2e-、公司名稱 E2E 開頭,結束時由 cleanupE2E 刪除;不修改真實公司與使用者。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyCall, cleanupE2E, cliApply, closeAll, createApiKey, createLocalUser, EMP_PREFIX, login, query, redisDelPattern, Session } from './gw.js';

const EMP = `${EMP_PREFIX}U1`;
const EMP_PENDING = `${EMP_PREFIX}U2`;
let admin: ReturnType<typeof apiKeyCall>;
let companyId = 0;

const detail = async (ref = EMP) => (await admin('GET', `/api/admin/users/${ref}`)).json;

beforeAll(async () => {
  await cleanupE2E();
  await cliApply(
    [
      'permissions:',
      '  - { code: e2ez.users.read, name: E2E 使用者管理測試 }',
      'roles:',
      '  - code: e2e-low',
      '    name: E2E 一般角色',
      '    permissions: [e2ez.users.read]',
      '  - code: e2e-high',
      '    name: E2E 高權限角色',
      '    permissions: [gw.admin.rbac.write]',
    ].join('\n'),
  );
  admin = apiKeyCall(
    await createApiKey('e2e-users', [
      'gw.admin.user.read',
      'gw.admin.user.write',
      'gw.admin.company.read',
      'gw.admin.company.write',
      'gw.admin.local.read',
      'gw.admin.local.write',
      'e2ez.users.read',
    ]),
  );
  await createLocalUser(EMP);
});
afterAll(async () => {
  await cleanupE2E();
  await closeAll();
});

describe('使用者', () => {
  it('未登入 401;清單可依工號搜尋,明細含本機帳號狀態與 rowVer', async () => {
    expect((await new Session().get('/api/admin/users')).status).toBe(401);
    const list = await admin('GET', `/api/admin/users?q=${EMP}`);
    expect(list.json.items).toEqual([expect.objectContaining({ employeeNo: EMP, localStatus: 'active', isDisabled: false })]);
    const d = await detail();
    expect(d).toMatchObject({ employeeNo: EMP, roles: [], localAccount: { status: 'active' } });
    expect(d.rowVer).toMatch(/^[0-9a-f]{16}$/);
  });

  it('不可指派含有自己沒有的權限的角色(403)', async () => {
    const res = await admin('PATCH', `/api/admin/users/${EMP}`, { rowVer: (await detail()).rowVer, roles: [{ code: 'e2e-high' }] });
    expect(res.status).toBe(403);
    expect(res.json.details).toEqual([{ field: 'roles', message: 'gw.admin.rbac.write' }]);
  });

  it('個別指派角色:已登入者須 Refresh,換發後帶新角色;舊 rowVer 409', async () => {
    const { s } = await login(EMP);
    const before = await detail();
    const validTo = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await admin('PATCH', `/api/admin/users/${EMP}`, { rowVer: before.rowVer, roles: [{ code: 'e2e-low', validTo, reason: 'E2E' }] });
    expect(res.status).toBe(200);
    expect(res.json.roles).toEqual([expect.objectContaining({ code: 'e2e-low', reason: 'E2E' })]);
    expect((await s.get('/api/auth/me')).status).toBe(401);
    expect((await s.post('/api/auth/refresh')).status).toBe(200);
    expect((await s.get('/api/auth/me')).json.roles).toContain('e2e-low');
    const stale = await admin('PATCH', `/api/admin/users/${EMP}`, { rowVer: before.rowVer, roles: [] });
    expect(stale.json.code).toBe('VERSION_CONFLICT');
  });

  it('強制登出:Refresh Token 失效', async () => {
    const { s } = await login(EMP);
    const res = await admin('POST', `/api/admin/users/${EMP}/revoke-sessions`);
    expect(res.json.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await s.get('/api/auth/me')).status).toBe(401);
    expect((await s.post('/api/auth/refresh')).json.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('停用使用者後不可登入;恢復後可登入', async () => {
    const off = await admin('PATCH', `/api/admin/users/${EMP}`, { rowVer: (await detail()).rowVer, isDisabled: true });
    expect(off.json.isDisabled).toBe(true);
    expect((await login(EMP)).res.json.code).toBe('ACCOUNT_DISABLED');
    await admin('PATCH', `/api/admin/users/${EMP}`, { rowVer: (await detail()).rowVer, isDisabled: false });
    expect((await login(EMP)).res.status).toBe(200);
  });
});

describe('公司', () => {
  beforeAll(async () => {
    const [c] = await query<{ id: number }>(
      "INSERT INTO gw.company (comp_name, created_by, updated_by) OUTPUT inserted.company_id AS id VALUES (N'E2E測試公司', 'e2e', 'e2e')",
    );
    companyId = c!.id;
    await query(
      'INSERT INTO gw.user_company (user_id, company_id, via_employee_no, is_primary) SELECT user_id, @c, employee_no, 1 FROM gw.[user] WHERE employee_no = @e',
      { c: companyId, e: EMP },
    );
  });

  const company = async () => (await admin('GET', '/api/admin/companies')).json.items.find((c: { companyId: number }) => c.companyId === companyId);

  it('清單含可用網域代碼、成員數', async () => {
    const res = await admin('GET', '/api/admin/companies');
    expect(res.json.domainCodes.length).toBeGreaterThan(0);
    expect(await company()).toMatchObject({ compName: 'E2E測試公司', adDomains: [], roles: [], users: 1 });
  });

  it('網域:不存在的代碼 400;設定後依順序回傳', async () => {
    const domains: string[] = (await admin('GET', '/api/admin/companies')).json.domainCodes;
    const bad = await admin('PUT', `/api/admin/companies/${companyId}/ad-domains`, { rowVer: (await company()).rowVer, domains: ['e2e-no-such'] });
    expect(bad.status).toBe(400);
    const res = await admin('PUT', `/api/admin/companies/${companyId}/ad-domains`, { rowVer: (await company()).rowVer, domains: [...domains].reverse() });
    expect(res.json.adDomains).toEqual([...domains].reverse());
    // 測試帳號沒有 AD 帳號:清除網域,避免登入改試 AD
    await admin('PUT', `/api/admin/companies/${companyId}/ad-domains`, { rowVer: res.json.rowVer, domains: [] });
  });

  it('公司預設角色:成員權限版本遞增,換發後帶公司角色;舊 rowVer 409', async () => {
    // 先移除個別指派,確認角色來自公司
    await admin('PATCH', `/api/admin/users/${EMP}`, { rowVer: (await detail()).rowVer, roles: [] });
    const { s } = await login(EMP);
    const before = await company();
    const res = await admin('PUT', `/api/admin/companies/${companyId}/roles`, { rowVer: before.rowVer, roles: ['e2e-low'] });
    expect(res.json.roles).toEqual([{ code: 'e2e-low', name: 'E2E 一般角色' }]);
    expect((await s.get('/api/auth/me')).status).toBe(401);
    expect((await s.post('/api/auth/refresh')).status).toBe(200);
    expect((await s.get('/api/auth/me')).json.roles).toContain('e2e-low');
    expect((await admin('PUT', `/api/admin/companies/${companyId}/roles`, { rowVer: before.rowVer, roles: [] })).json.code).toBe('VERSION_CONFLICT');
  });
});

describe('本機帳號', () => {
  it('清單可依狀態篩選', async () => {
    const res = await admin('GET', `/api/admin/local-accounts?status=active,locked&q=${EMP}`);
    expect(res.json.items).toEqual([expect.objectContaining({ employeeNo: EMP, status: 'active', registeredVia: 'self_approved' })]);
  });

  it('IT 代建:LOS / BPM 查無的工號 400', async () => {
    const res = await admin('POST', '/api/admin/local-accounts', { employeeNo: `${EMP_PREFIX}U9` });
    expect(res.status).toBe(400);
    expect(res.json.message).toContain('查無資料');
  });

  it('核准待審核:回傳啟用連結,以連結設定密碼後可登入', async () => {
    await redisDelPattern('gw:reg:*');
    expect((await new Session().post('/api/auth/register', { employeeNo: EMP_PENDING, name: 'E2E 待審核' })).json.code).toBe('REGISTRATION_PENDING_APPROVAL');
    const pending = await admin('GET', `/api/admin/local-accounts?status=pending_approval&q=${EMP_PENDING}`);
    expect(pending.json.items).toHaveLength(1);
    const res = await admin('POST', `/api/admin/local-accounts/${EMP_PENDING}/approve`);
    expect(res.json).toMatchObject({ employeeNo: EMP_PENDING, expiresInHours: 72 });
    const token = new URL(res.json.link).searchParams.get('token')!;
    expect((await new Session().post('/api/auth/register/verify', { token, password: 'E2eTest2026' })).status).toBe(200);
    expect((await admin('POST', `/api/admin/local-accounts/${EMP_PENDING}/approve`)).status).toBe(400);
  });

  it('IT 重設密碼:臨時密碼登入須先變更密碼', async () => {
    const res = await admin('POST', `/api/admin/local-accounts/${EMP}/reset-password`);
    expect(res.json.mustChangePassword).toBe(true);
    expect((await login(EMP, res.json.temporaryPassword)).res.json.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('解除鎖定', async () => {
    await query(
      "UPDATE c SET status = 'locked', failed_count = 10 FROM gw.local_credential c JOIN gw.[user] u ON u.user_id = c.user_id WHERE u.employee_no = @e",
      {
        e: EMP,
      },
    );
    await admin('POST', `/api/admin/local-accounts/${EMP}/unlock`);
    expect((await detail()).localAccount).toMatchObject({ status: 'active', failedCount: 0 });
  });

  it('停用本機帳號後不可登入', async () => {
    const res = await admin('POST', `/api/admin/local-accounts/${EMP}/disable`);
    expect(res.status).toBe(200);
    expect((await detail()).localAccount.status).toBe('disabled');
    expect((await login(EMP)).res.status).toBe(401);
    expect((await admin('POST', `/api/admin/local-accounts/${EMP}/disable`)).status).toBe(400);
  });

  it('稽核紀錄的操作人為 API Key', async () => {
    const logs = await query<{ action: string }>(
      "SELECT DISTINCT action FROM gw.audit_log WHERE actor_name = 'client:e2e-users' AND occurred_at > DATEADD(MINUTE, -15, SYSUTCDATETIME())",
    );
    expect(logs.map((l) => l.action).sort()).toEqual(
      ['company.ad_domains', 'company.roles', 'local.approve', 'local.disable', 'local.reset', 'local.unlock', 'user.revoke_sessions', 'user.update'].sort(),
    );
  });
});
