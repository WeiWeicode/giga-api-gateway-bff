/**
 * docs/Gherkin/auth/local-account.feature(W3-4.14)、auth/token-session.feature(W3-4.4、4.5、4.9)、auth/apps.feature(P2-3a)
 * 以假工號的本機帳號在測試區驗證登入、工作階段、me.apps 與變更密碼。
 */
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupE2E, cli, closeAll, createLocalUser, EMP_PREFIX, login, PASSWORD, query, redisDelPattern, Session } from './gw.js';

const EMP = `${EMP_PREFIX}A1`;
const PW2 = 'E2eNext2026';

beforeAll(async () => {
  await cleanupE2E();
  await createLocalUser(EMP);
});
afterAll(async () => {
  await cleanupE2E();
  await closeAll();
});

const clearFails = () => redisDelPattern(`gw:login:fail:*${EMP}`);
const cred = async () =>
  (
    await query<{ status: string; failed_count: number; password_history: string | null }>(
      'SELECT c.status, c.failed_count, c.password_history FROM gw.local_credential c JOIN gw.[user] u ON u.user_id = c.user_id WHERE u.employee_no = @e',
      { e: EMP },
    )
  )[0]!;

describe('本機帳號登入與 me', () => {
  it('以資料庫密碼登入(authType = local),me 回傳角色與應用(apps)', async () => {
    const { s, res } = await login(EMP);
    expect(res.status).toBe(200);
    const me = (await s.get('/api/auth/me')).json;
    expect(me.user).toMatchObject({ employeeNo: EMP, authType: 'local' });
    expect(me.roles).toContain('employee');
    expect(me.apps.map((a: { code: string }) => a.code)).toContain('portal');
    expect(me.apps[0]).toMatchObject({ code: 'portal', basePath: '/', icon: 'home' });
    expect(me.permissions).toContain('portal.app.access');
  });

  it('密碼錯誤與帳號不存在回同一代碼', async () => {
    await clearFails();
    expect((await login(EMP, 'Wrong12345')).res.json.code).toBe('INVALID_CREDENTIALS');
    // 不存在的工號:所屬公司無網域 → 引導註冊
    expect((await login(`${EMP_PREFIX}NONE`)).res.json.code).toMatch(/INVALID_CREDENTIALS|ACCOUNT_NOT_REGISTERED/);
    await clearFails();
  });

  it('連續 10 次失敗鎖定;鎖定後正確密碼也回 ACCOUNT_LOCKED;IT 解鎖後恢復', async () => {
    // 測試區登入有 Nginx 限流(5r/m),先把失敗次數設為 9 次,再以 1 次失敗觸發鎖定
    await query('UPDATE c SET failed_count = 9 FROM gw.local_credential c JOIN gw.[user] u ON u.user_id = c.user_id WHERE u.employee_no = @e', { e: EMP });
    await clearFails();
    expect((await login(EMP, 'Wrong12345')).res.json.code).toBe('INVALID_CREDENTIALS');
    expect((await cred()).status).toBe('locked');
    await clearFails();
    expect((await login(EMP)).res.json.code).toBe('ACCOUNT_LOCKED');
    const [log] = await query("SELECT COUNT(*) AS n FROM gw.auth_log WHERE username = @e AND event = 'account_locked'", { e: EMP });
    expect(log.n).toBeGreaterThanOrEqual(1);

    await cli('local:unlock', '--emp', EMP);
    expect((await login(EMP)).res.status).toBe(200);
    expect(await cred()).toMatchObject({ status: 'active', failed_count: 0 });
  });
});

describe('Token、Cookie 與工作階段', () => {
  it('Cookie 屬性正確', async () => {
    const { s } = await login(EMP);
    const at = s.cookies.get('gn_at')!.attrs;
    const rt = s.cookies.get('gn_rt')!.attrs;
    const csrf = s.cookies.get('gn_csrf')!.attrs;
    expect(at).toMatch(/Max-Age=900/);
    expect(at).toMatch(/Path=\/(;|$)/);
    expect(at).toMatch(/HttpOnly/);
    expect(at).toMatch(/Secure/);
    expect(at).toMatch(/SameSite=Strict/);
    expect(rt).toMatch(/Path=\/api\/auth/);
    expect(rt).toMatch(/HttpOnly/);
    expect(csrf).toMatch(/Secure/);
    expect(csrf).not.toMatch(/HttpOnly/);
  });

  it('Access Token:ES256、kid、15 分鐘,claims 不含權限清單', async () => {
    const { s } = await login(EMP);
    const token = s.cookies.get('gn_at')!.value;
    const h = decodeProtectedHeader(token);
    expect(h.alg).toBe('ES256');
    expect(h.kid).toBeTruthy();
    const c = decodeJwt(token);
    expect(c).toMatchObject({ iss: 'giganexus-bff', aud: 'giganexus', emp: EMP, amr: 'local' });
    expect(c.exp! - c.iat!).toBe(900);
    expect(c).not.toHaveProperty('permissions');
  });

  it('非 GET 請求缺少 CSRF 標頭時拒絕', async () => {
    const { s } = await login(EMP);
    const bad = await s.request('POST', '/api/auth/logout', { csrf: false });
    expect(bad.status).toBe(403);
    expect(bad.json.code).toBe('CSRF_INVALID');
  });

  it('以 Refresh Token 換發新的 gn_at 與 gn_rt', async () => {
    const { s } = await login(EMP);
    const oldRt = s.cookies.get('gn_rt')!.value;
    const oldAt = s.cookies.get('gn_at')!.value;
    const res = await s.post('/api/auth/refresh');
    expect(res.status).toBe(200);
    expect(s.cookies.get('gn_rt')!.value).not.toBe(oldRt);
    expect(s.cookies.get('gn_at')!.value).not.toBe(oldAt);
  });

  it('舊 Refresh Token 被重複使用時撤銷整個家族,並記錄 token_reuse_detected', async () => {
    const [{ maxId }] = await query("SELECT ISNULL(MAX(log_id), 0) AS maxId FROM gw.auth_log WHERE event = 'token_reuse_detected'");
    const { s } = await login(EMP);
    const stolen = new Session();
    stolen.cookies.set('gn_rt', { ...s.cookies.get('gn_rt')! });
    stolen.cookies.set('gn_csrf', { ...s.cookies.get('gn_csrf')! });
    expect((await s.post('/api/auth/refresh')).status).toBe(200);
    const reuse = await stolen.post('/api/auth/refresh');
    expect(reuse.status).toBe(401);
    expect(reuse.json.code).toBe('REFRESH_TOKEN_INVALID');
    expect((await s.post('/api/auth/refresh')).json.code).toBe('REFRESH_TOKEN_INVALID');
    // 重用偵測時只知道 RT 家族,username 記為 (refresh)
    const [log] = await query("SELECT COUNT(*) AS n FROM gw.auth_log WHERE event = 'token_reuse_detected' AND log_id > @maxId", { maxId });
    expect(log.n).toBeGreaterThanOrEqual(1);
  });

  it('登出後清除 gn_* Cookie,登出前的 gn_at 立即失效', async () => {
    const { s } = await login(EMP);
    const replay = new Session();
    replay.cookies.set('gn_at', { ...s.cookies.get('gn_at')! });
    expect((await replay.get('/api/auth/me')).status).toBe(200);
    const out = await s.post('/api/auth/logout');
    expect(out.status).toBe(204);
    expect(out.setCookies.filter((c) => /^gn_(at|rt|csrf)=;/.test(c))).toHaveLength(3);
    expect((await replay.get('/api/auth/me')).status).toBe(401);
  });

  it('停用使用者:舊 Access Token 下一次請求即失效;恢復後可再登入', async () => {
    const { s } = await login(EMP);
    expect((await s.get('/api/auth/me')).status).toBe(200);
    await cli('user:disable', '--emp', EMP);
    expect((await s.get('/api/auth/me')).status).toBe(401);
    expect((await s.post('/api/auth/refresh')).json.code).toBe('REFRESH_TOKEN_INVALID');
    expect((await login(EMP)).res.json.code).toBe('ACCOUNT_DISABLED');
    await cli('user:enable', '--emp', EMP);
    expect((await login(EMP)).res.status).toBe(200);
  });

  it('JWKS 只對內網服務開放', async () => {
    // 測試區白名單(internal-services.conf)尚未填入;外部存取一律 404
    expect((await new Session().get('/.well-known/jwks.json')).status).toBe(404);
  });
});

describe('變更密碼', () => {
  it('不可與前 3 次相同;變更後其他裝置被登出', async () => {
    const other = await login(EMP);
    const { s } = await login(EMP);
    expect((await s.post('/api/auth/password/change', { currentPassword: PASSWORD, newPassword: PASSWORD })).json.code).toBe('PASSWORD_REUSED');
    const changed = await s.post('/api/auth/password/change', { currentPassword: PASSWORD, newPassword: PW2 });
    expect(changed.status).toBe(200);
    expect((await other.s.post('/api/auth/refresh')).json.code).toBe('REFRESH_TOKEN_INVALID');
    expect((await s.get('/api/auth/me')).status).toBe(200);
    expect(JSON.parse((await cred()).password_history!)).toHaveLength(1);
  });

  it('IT 重設後首次登入:PASSWORD_CHANGE_REQUIRED 與限定憑證,只能變更密碼', async () => {
    const { temporaryPassword } = await cli('local:reset', '--emp', EMP);
    const { s, res } = await login(EMP, temporaryPassword);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(s.cookies.has('gn_at')).toBe(false);
    expect(s.cookies.get('gn_pwchg')?.attrs).toMatch(/Path=\/api\/auth\/password/);
    expect((await s.get('/api/auth/me')).status).toBe(401);
    const done = await s.post('/api/auth/password/change', { newPassword: 'E2eFinal2026' });
    expect(done.status).toBe(200);
    expect(done.json.user.employeeNo).toBe(EMP);
    expect((await s.get('/api/auth/me')).status).toBe(200);
  });
});
