/** docs/Gherkin/auth/token-session.feature(W3-4.4、4.5、4.9)、rbac/permission.feature(W3-4.6–4.8) */
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLoginFails, cli, closeAll, login, mock, query, Session } from './gw.js';

beforeAll(async () => {
  for (const e of ['S112009', 'Y110001', 'S100001']) await clearLoginFails(e);
});
afterAll(closeAll);

describe('Token、Cookie 與工作階段', () => {
  it('Cookie 屬性正確', async () => {
    const { s } = await login('S112009');
    const at = s.cookies.get('gn_at')!.attrs;
    const rt = s.cookies.get('gn_rt')!.attrs;
    const csrf = s.cookies.get('gn_csrf')!.attrs;
    expect(at).toMatch(/Max-Age=900/);
    expect(at).toMatch(/Path=\/;/);
    expect(at).toMatch(/HttpOnly/);
    expect(at).toMatch(/Secure/);
    expect(at).toMatch(/SameSite=Strict/);
    expect(rt).toMatch(/Max-Age=28800/);
    expect(rt).toMatch(/Path=\/api\/auth/);
    expect(rt).toMatch(/HttpOnly/);
    expect(csrf).toMatch(/Secure/);
    expect(csrf).toMatch(/SameSite=Strict/);
    expect(csrf).not.toMatch(/HttpOnly/);
  });

  it('Access Token:ES256、kid、claims 不含權限清單', async () => {
    const { s } = await login('S112009');
    const token = s.cookies.get('gn_at')!.value;
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: 'dev-2026-02' });
    const c = decodeJwt(token);
    expect(c).toMatchObject({ iss: 'giganexus-bff', aud: 'giganexus', emp: 'S112009', amr: 'ad', dept: 'S1800' });
    expect(c.exp! - c.iat!).toBe(900);
    expect(c).not.toHaveProperty('permissions');
  });

  it('非 GET 請求缺少 CSRF 標頭時拒絕;相符時放行', async () => {
    const { s } = await login('S112009');
    const bad = await s.request('POST', '/api/mes/work-orders/1001/reports', { body: { qty: 1 }, csrf: false });
    expect(bad.status).toBe(403);
    expect(bad.json.code).toBe('CSRF_INVALID');
    const good = await s.post('/api/mes/work-orders/1001/reports', { qty: 1 });
    expect(good.status).toBe(201);
  });

  it('以 Refresh Token 換發新的 gn_at 與 gn_rt,舊的 gn_rt 失效', async () => {
    const { s } = await login('S112009');
    const oldRt = s.cookies.get('gn_rt')!.value;
    const oldAt = s.cookies.get('gn_at')!.value;
    const res = await s.post('/api/auth/refresh');
    expect(res.status).toBe(200);
    expect(s.cookies.get('gn_rt')!.value).not.toBe(oldRt);
    expect(s.cookies.get('gn_at')!.value).not.toBe(oldAt);
    // Rotation 不延長家族效期
    expect(Number(/Max-Age=(\d+)/.exec(s.cookies.get('gn_rt')!.attrs)![1])).toBeLessThanOrEqual(28800);
  });

  it('舊 Refresh Token 被重複使用時撤銷整個家族,並記錄 token_reuse_detected', async () => {
    const { s } = await login('S112009');
    const stolen = new Session();
    stolen.cookies.set('gn_rt', { ...s.cookies.get('gn_rt')! });
    stolen.cookies.set('gn_csrf', { ...s.cookies.get('gn_csrf')! });
    expect((await s.post('/api/auth/refresh')).status).toBe(200);

    const reuse = await stolen.post('/api/auth/refresh');
    expect(reuse.status).toBe(401);
    expect(reuse.json.code).toBe('REFRESH_TOKEN_INVALID');
    // 家族已撤銷:合法使用者的新 RT 也失效
    expect((await s.post('/api/auth/refresh')).json.code).toBe('REFRESH_TOKEN_INVALID');
    const [log] = await query("SELECT TOP 1 event FROM gw.auth_log WHERE event = 'token_reuse_detected' ORDER BY log_id DESC");
    expect(log).toBeDefined();
  });

  it('登出後清除所有 gn_* Cookie,登出前的 gn_at 立即失效', async () => {
    const { s } = await login('S112009');
    const replay = new Session();
    replay.cookies.set('gn_at', { ...s.cookies.get('gn_at')! });
    expect((await replay.get('/api/auth/me')).status).toBe(200);
    const out = await s.post('/api/auth/logout');
    expect(out.status).toBe(204);
    expect(out.setCookies.filter((c) => /^gn_(at|rt|csrf)=;/.test(c))).toHaveLength(3);
    expect((await replay.get('/api/auth/me')).status).toBe(401);
    expect((await replay.get('/api/mes/work-orders/1001')).status).toBe(401);
  });

  it('記住我:公司內網來源 IP 延長為 7 天', async () => {
    const { s } = await login('S112009', undefined, true);
    expect(s.cookies.get('gn_rt')!.attrs).toMatch(/Max-Age=604\d{3}/);
  });

  it('停用使用者:舊 Access Token 下一次請求即失效,Refresh 失敗;恢復後可再登入', async () => {
    const { s } = await login('Y110001');
    expect((await s.get('/api/auth/me')).status).toBe(200);
    await cli('user:disable', '--emp', 'Y110001');
    expect((await s.get('/api/auth/me')).status).toBe(401);
    expect((await s.post('/api/auth/refresh')).json.code).toBe('REFRESH_TOKEN_INVALID');
    expect((await login('Y110001')).res.json.code).toBe('ACCOUNT_DISABLED');
    await cli('user:enable', '--emp', 'Y110001');
    expect((await login('Y110001')).res.status).toBe(200);
  });

  it('轉發上游時附上短效內部 Token(ES256、aud = 上游代碼、60 秒),且不帶 Cookie', async () => {
    const { s } = await login('S112009');
    const echo = await s.get('/api/mes/debug/echo');
    const token = echo.json.headers['x-internal-token'] as string;
    expect(decodeProtectedHeader(token).alg).toBe('ES256');
    const c = decodeJwt(token);
    expect(c).toMatchObject({ aud: 'go-mes', iss: 'giganexus-bff', emp: 'S112009', amr: 'ad' });
    expect(c.exp! - c.iat!).toBe(60);
    expect(echo.json.headers.cookie).toBeUndefined();
    expect(echo.json.headers['x-csrf-token']).toBeUndefined();
  });

  it('下游可由 JWKS 取得目前與前一把簽章金鑰', async () => {
    const res = await new Session().get('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.json.keys.map((k: { kid: string }) => k.kid).sort()).toEqual(['dev-2026-01', 'dev-2026-02']);
    expect(res.json.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(res.json.keys[0]).not.toHaveProperty('d');
  });
});

describe('RBAC', () => {
  it.each([
    ['GET /api/portal/news', 'public', null, 200],
    ['GET /api/portal/profile', 'authenticated', null, 401],
    ['GET /api/portal/profile', 'authenticated', 'Y110001', 200],
    ['GET /api/mes/work-orders', 'permission', 'Y110001', 403],
    ['GET /api/mes/work-orders', 'permission', 'S112009', 200],
  ])('%s(%s)呼叫者 %s → %i', async (route, _mode, who, status) => {
    const s = who ? (await login(who)).s : new Session();
    expect((await s.get(route.split(' ')[1]!)).status).toBe(status);
  });

  it('無權限時回應統一格式,且請求不會轉發到上游', async () => {
    const before = (await mock(51210, '/__stats')).requests;
    const { s } = await login('Y110001');
    const res = await s.get('/api/mes/work-orders/1004');
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ code: 'PERMISSION_DENIED', message: expect.any(String), requestId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect((await mock(51210, '/__stats')).requests).toBe(before);
  });

  it('個別指派的角色過期後即失效', async () => {
    const [u] = await query<{ user_id: number }>("SELECT user_id FROM gw.[user] WHERE employee_no = 'Y110001'");
    const [r] = await query<{ role_id: number }>("SELECT role_id FROM gw.role WHERE code = 'mes-operator'");
    await query('DELETE FROM gw.user_role WHERE user_id = @u', { u: u!.user_id });
    await query(
      "INSERT INTO gw.user_role (user_id, role_id, valid_from, valid_to, reason, created_by) VALUES (@u, @r, DATEADD(DAY, -10, SYSUTCDATETIME()), DATEADD(DAY, -1, SYSUTCDATETIME()), 'e2e', 'e2e')",
      {
        u: u!.user_id,
        r: r!.role_id,
      },
    );
    await query('UPDATE gw.[user] SET perm_version = perm_version + 1 WHERE user_id = @u', { u: u!.user_id });
    const { s } = await login('Y110001');
    expect((await s.get('/api/mes/work-orders')).status).toBe(403);
    // 改為有效期間內 → 可存取
    await query('UPDATE gw.user_role SET valid_to = DATEADD(DAY, 1, SYSUTCDATETIME()) WHERE user_id = @u', { u: u!.user_id });
    await query('UPDATE gw.[user] SET perm_version = perm_version + 1 WHERE user_id = @u', { u: u!.user_id });
    const again = (await login('Y110001')).s;
    expect((await again.get('/api/mes/work-orders')).status).toBe(200);
    await query('DELETE FROM gw.user_role WHERE user_id = @u', { u: u!.user_id });
    await query('UPDATE gw.[user] SET perm_version = perm_version + 1 WHERE user_id = @u', { u: u!.user_id });
  });

  it('角色權限變更後遞增權限版本,已登入者下一次請求即要求 Refresh,Refresh 後取得新權限', async () => {
    const { s } = await login('S112009');
    const pvBefore = (await query("SELECT perm_version FROM gw.[user] WHERE employee_no = 'S112009'"))[0].perm_version;
    await query("UPDATE gw.[user] SET perm_version = perm_version + 1 WHERE employee_no = 'S112009'");
    const { redis } = await import('./gw.js');
    await redis().del(`gw:pv:${(await query("SELECT user_id FROM gw.[user] WHERE employee_no = 'S112009'"))[0].user_id}`);
    expect((await s.get('/api/mes/work-orders')).status).toBe(401);
    const refreshed = await s.post('/api/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(decodeJwt(s.cookies.get('gn_at')!.value).pv).toBe(pvBefore + 1);
    expect((await s.get('/api/mes/work-orders')).status).toBe(200);
  });

  it('權限快取命中:1000 次權限判斷的 p95(經 Nginx 的整體延遲僅供參考)', async () => {
    const { s } = await login('S112009');
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      await s.get('/api/mes/work-orders/1001');
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(`GET /api/mes/work-orders/1001(快取命中)經 Nginx p95 = ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(100);
  });
});
