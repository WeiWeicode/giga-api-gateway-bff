/** docs/Gherkin/auth/local-account.feature(W3-4.14、W3-4.15)、password-reset.feature(變更密碼) */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLoginFails, cli, closeAll, login, query, redis, Session } from './gw.js';

const EMP = 'V112001';
const PW = 'abc12345';
let activation = '';

async function resetLocalAccount() {
  const [u] = await query<{ user_id: number }>('SELECT user_id FROM gw.[user] WHERE employee_no = @e', { e: EMP });
  if (u) {
    await query('DELETE FROM gw.local_account_token WHERE user_id = @id', { id: u.user_id });
    await query('DELETE FROM gw.local_credential WHERE user_id = @id', { id: u.user_id });
  }
  await clearLoginFails(EMP);
}

beforeAll(async () => {
  await resetLocalAccount();
  activation = (await cli('local:create', '--emp', EMP, '--base-url', 'https://localhost')).activationToken;
});
afterAll(closeAll);

describe('IT 代建本機帳號', () => {
  it('代建後產生 72 小時有效的一次性啟用連結,帳號為待啟用', async () => {
    expect(activation).toMatch(/^[\w-]{40,}$/);
    const [row] = await query(
      `SELECT c.status, c.registered_via, DATEDIFF(HOUR, SYSUTCDATETIME(), t.expires_at) AS hours
       FROM gw.local_credential c JOIN gw.[user] u ON u.user_id = c.user_id
       JOIN gw.local_account_token t ON t.user_id = u.user_id AND t.used_at IS NULL WHERE u.employee_no = @e`,
      { e: EMP },
    );
    expect(row).toMatchObject({ status: 'pending_verify', registered_via: 'admin' });
    expect(row.hours).toBeGreaterThanOrEqual(71);
    // 啟用前無法登入
    expect((await login(EMP, PW)).res.json.code).toBe('ACCOUNT_NOT_REGISTERED');
  });

  it('AD 已有帳號的工號不可建立本機帳號(一個工號只有一種驗證方式)', async () => {
    await expect(cli('local:create', '--emp', 'S112009')).rejects.toThrow(/已有帳號/);
  });

  it.each([
    ['abc1234', 'min_length'],
    ['abcdefgh', 'digit'],
    ['12345678', 'letter'],
    ['xV112001y1', 'contains_employee_no'],
  ])('密碼政策:%s → 拒絕(%s)', async (pw, rule) => {
    const res = await new Session().post('/api/auth/register/verify', { token: activation, password: pw });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('PASSWORD_POLICY_VIOLATION');
    expect(res.json.details.map((d: { rule: string }) => d.rule)).toContain(rule);
  });

  it('以啟用連結設定符合政策的密碼後啟用;連結只能使用一次', async () => {
    const s = new Session();
    const ok = await s.post('/api/auth/register/verify', { token: activation, password: PW });
    expect(ok.status).toBe(200);
    const again = await s.post('/api/auth/register/verify', { token: activation, password: PW });
    expect(again.json.code).toBe('TOKEN_USED');
    expect((await s.post('/api/auth/register/verify', { token: 'x'.repeat(43), password: PW })).json.code).toBe('TOKEN_INVALID');
  });

  it('密碼只以 Argon2id 雜湊儲存', async () => {
    const [row] = await query('SELECT c.password_hash FROM gw.local_credential c JOIN gw.[user] u ON u.user_id = c.user_id WHERE u.employee_no = @e', {
      e: EMP,
    });
    expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(row.password_hash).not.toContain(PW);
  });
});

describe('本機帳號登入', () => {
  it('已有本機帳號者以資料庫密碼驗證(authType = local)', async () => {
    const { res } = await login(EMP, PW);
    expect(res.status).toBe(200);
    expect(res.json.user).toMatchObject({ employeeNo: EMP, authType: 'local' });
    const [log] = await query('SELECT TOP 1 event, auth_method FROM gw.auth_log WHERE username = @e ORDER BY log_id DESC', { e: EMP });
    expect(log).toMatchObject({ event: 'login_success', auth_method: 'local' });
  });

  it('公司預設角色適用本機帳號;兼任公司的角色併入本人,內部 Token 的 cos 含兩家公司', async () => {
    const { s, res } = await login(EMP, PW);
    expect(res.json.companies).toEqual(expect.arrayContaining(['禾迅', '碩禾']));
    expect(res.json.roles).toEqual(expect.arrayContaining(['employee', 'hv-employee', 'gs-employee']));
    expect(res.json.permissions).toContain('mes.workorder.read');
    const echo = await s.get('/api/mes/debug/echo');
    expect(echo.json.user).toMatchObject({ emp: EMP, amr: 'local', upn: null, aud: 'go-mes' });
    expect(echo.json.user.cos).toEqual(expect.arrayContaining(['禾迅', '碩禾']));
  });

  it('連續 10 次失敗鎖定;鎖定後正確密碼也回 ACCOUNT_LOCKED;IT 解鎖後恢復', async () => {
    for (let i = 1; i <= 10; i++) {
      await clearLoginFails(EMP); // 模擬每次間隔超過限流視窗(15 分 5 次)
      const { res } = await login(EMP, 'wrong-pass1');
      expect(res.json.code).toBe('INVALID_CREDENTIALS');
    }
    await clearLoginFails(EMP);
    const locked = await login(EMP, PW);
    expect(locked.res.status).toBe(401);
    expect(locked.res.json.code).toBe('ACCOUNT_LOCKED');
    const [log] = await query("SELECT COUNT(*) AS n FROM gw.auth_log WHERE username = @e AND event = 'account_locked'", { e: EMP });
    expect(log.n).toBeGreaterThanOrEqual(1);

    await cli('local:unlock', '--emp', EMP);
    const ok = await login(EMP, PW);
    expect(ok.res.status).toBe(200);
    const [c] = await query('SELECT c.failed_count, c.status FROM gw.local_credential c JOIN gw.[user] u ON u.user_id = c.user_id WHERE u.employee_no = @e', {
      e: EMP,
    });
    expect(c).toMatchObject({ failed_count: 0, status: 'active' });
  });

  it('登入成功後失敗次數歸零', async () => {
    for (let i = 0; i < 3; i++) await login(EMP, 'wrong-pass1');
    await clearLoginFails(EMP);
    await login(EMP, PW);
    const [c] = await query('SELECT c.failed_count FROM gw.local_credential c JOIN gw.[user] u ON u.user_id = c.user_id WHERE u.employee_no = @e', { e: EMP });
    expect(c.failed_count).toBe(0);
  });
});

describe('變更密碼', () => {
  it('不可與前 3 次相同;變更後其他裝置被登出', async () => {
    const other = await login(EMP, PW);
    const { s } = await login(EMP, PW);
    const reuse = await s.post('/api/auth/password/change', { currentPassword: PW, newPassword: PW });
    expect(reuse.json.code).toBe('PASSWORD_REUSED');

    const changed = await s.post('/api/auth/password/change', { currentPassword: PW, newPassword: 'newPass9x' });
    expect(changed.status).toBe(200);
    // 其他裝置的 Refresh Token 已撤銷
    expect((await other.s.post('/api/auth/refresh')).json.code).toBe('REFRESH_TOKEN_INVALID');
    // 本裝置換發新工作階段
    expect((await s.get('/api/auth/me')).status).toBe(200);

    // 改回原密碼:前 3 次包含 PW → 拒絕
    expect((await s.post('/api/auth/password/change', { currentPassword: 'newPass9x', newPassword: PW })).json.code).toBe('PASSWORD_REUSED');
    const [c] = await query('SELECT c.password_history FROM gw.local_credential c JOIN gw.[user] u ON u.user_id = c.user_id WHERE u.employee_no = @e', {
      e: EMP,
    });
    expect(JSON.parse(c.password_history)).toHaveLength(1);
  });

  it('AD 帳號不可在 Gateway 變更密碼', async () => {
    const { s } = await login('S112009');
    const res = await s.post('/api/auth/password/change', { currentPassword: 'x', newPassword: 'newPass9x' });
    expect(res.status).toBe(403);
  });

  it('IT 重設後首次登入:回 PASSWORD_CHANGE_REQUIRED 與限定憑證,只能變更密碼', async () => {
    await query('UPDATE c SET must_change_password = 1 FROM gw.local_credential c JOIN gw.[user] u ON u.user_id = c.user_id WHERE u.employee_no = @e', {
      e: EMP,
    });
    const { s, res } = await login(EMP, 'newPass9x');
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(s.cookies.has('gn_at')).toBe(false);
    expect(s.cookies.get('gn_pwchg')?.attrs).toMatch(/Path=\/api\/auth\/password/);
    // 限定憑證不能呼叫其他 API
    expect((await s.get('/api/auth/me')).status).toBe(401);
    const done = await s.post('/api/auth/password/change', { newPassword: 'Final123x' });
    expect(done.status).toBe(200);
    expect(done.json.user.employeeNo).toBe(EMP);
    expect((await s.get('/api/auth/me')).status).toBe(200);
    expect(await redis().keys('gw:pwchg:*')).toHaveLength(0);
  });
});
