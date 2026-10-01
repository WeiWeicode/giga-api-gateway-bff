/**
 * docs/Gherkin/auth/self-registration.feature(W3-5.8a)、auth/password-reset.feature(W3-5.8b)
 * 假工號在 LOS / BPM 查無 → 待審核 → IT 核准;忘記密碼的重設連結取自測試區佇列工作(Email 改寄 MAIL_REDIRECT_TO)。
 * 有 Email / 無 Email(到職日)的註冊需要真實員工資料,不在 E2E 範圍。
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupE2E, cli, closeAll, EMP_PREFIX, login, PASSWORD, query, redisCli, redisDelPattern, Session, sleep, waitFor } from './gw.js';

const EMP = `${EMP_PREFIX}B1`;
const NEW_PW = 'E2eReset2026';

beforeAll(cleanupE2E);
afterAll(async () => {
  await cleanupE2E();
  await closeAll();
});

const register = (body: Record<string, unknown>) => new Session().post('/api/auth/register', body);
const forgot = (employeeNo: string, noRetry = false) => new Session().post('/api/auth/password/forgot', { employeeNo }, { noRetry });

describe('自行註冊', () => {
  it('AD 已有帳號的工號 → REGISTRATION_NOT_ALLOWED(訊息不說明原因)', async () => {
    await redisDelPattern('gw:reg:*');
    const res = await register({ employeeNo: 'S112009', name: '任意' });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: 'REGISTRATION_NOT_ALLOWED', message: '無法註冊,請聯絡 IT' });
  });

  it('LOS / BPM 都查無 → 待審核;自填 Email 不被採用', async () => {
    const res = await register({ employeeNo: EMP, name: 'E2E 註冊', email: 'attacker@example.com' });
    expect(res.status).toBe(202);
    expect(res.json.code).toBe('REGISTRATION_PENDING_APPROVAL');
    const [u] = await query(
      'SELECT u.email, c.status, c.registered_via FROM gw.[user] u JOIN gw.local_credential c ON c.user_id = u.user_id WHERE u.employee_no = @e',
      { e: EMP },
    );
    expect(u).toMatchObject({ email: null, status: 'pending_approval', registered_via: 'self_approved' });
  });

  it('待審核者不可再申請、不可登入', async () => {
    expect((await register({ employeeNo: EMP, name: 'E2E 註冊' })).json.code).toBe('REGISTRATION_NOT_ALLOWED');
    expect((await login(EMP)).res.json.code).toBe('ACCOUNT_NOT_REGISTERED');
  });

  it('IT 核准後以一次性啟用連結設定密碼;連結再次使用 → TOKEN_USED', async () => {
    const { link } = await cli('local:approve', '--emp', EMP);
    const token = new URL(link).searchParams.get('token')!;
    const s = new Session();
    expect((await s.post('/api/auth/register/verify', { token, password: 'short' })).json.code).toBe('PASSWORD_POLICY_VIOLATION');
    expect((await s.post('/api/auth/register/verify', { token, password: PASSWORD })).status).toBe(200);
    expect((await s.post('/api/auth/register/verify', { token, password: PASSWORD })).json.code).toBe('TOKEN_USED');
    expect((await login(EMP)).res.status).toBe(200);
  });
});

describe('忘記 / 重設密碼', () => {
  let resetToken = '';

  it('有帳號、查無帳號、AD 帳號三者回應相同(202 VERIFICATION_SENT)', async () => {
    await query("UPDATE gw.[user] SET email = 'e2e-reset@example.com' WHERE employee_no = @e", { e: EMP });
    await redisDelPattern('gw:reg:*');
    const mine = await forgot(EMP);
    const none = await forgot(`${EMP_PREFIX}NONE`);
    const ad = await forgot('S112009');
    for (const r of [mine, none, ad]) {
      expect(r.status).toBe(202);
      expect(r.json.code).toBe('VERIFICATION_SENT');
      expect(r.json.message).toBe(mine.json.message);
    }
    expect(mine.json.message).toContain('AD');
  });

  it('只對有 Email 的本機帳號寄出 30 分鐘的重設連結', async () => {
    const [u] = await query<{ id: number }>('SELECT user_id AS id FROM gw.[user] WHERE employee_no = @e', { e: EMP });
    const log = await waitFor(async () => {
      const [l] = await query<{ log_id: string; status: string }>(
        "SELECT TOP 1 log_id, status FROM gw.notify_log WHERE template_code = 'AUTH_PASSWORD_RESET' AND recipient_user_id = @id ORDER BY log_id DESC",
        { id: u!.id },
      );
      return l?.status === 'sent' && l;
    });
    const [none] = await query("SELECT COUNT(*) AS n FROM gw.notify_log WHERE template_code = 'AUTH_PASSWORD_RESET' AND requested_by LIKE @p", {
      p: `%${EMP_PREFIX}NONE`,
    });
    expect(none.n).toBe(0);
    // 連結以 Email 送出;E2E 從測試區佇列工作取得
    const job = JSON.parse(await redisCli('HGET', `bull:notify:nt-${log.log_id}`, 'data')) as { data: { link: string; expiresMinutes: number } };
    expect(job.data.expiresMinutes).toBe(30);
    expect(job.data.link).toMatch(/\/reset-password\?token=/);
    resetToken = new URL(job.data.link).searchParams.get('token')!;
  });

  it('新密碼不可與舊密碼相同;重設成功後撤銷所有登入,連結只能用一次', async () => {
    const other = await login(EMP);
    expect((await new Session().post('/api/auth/password/reset', { token: resetToken, password: PASSWORD })).json.code).toBe('PASSWORD_REUSED');
    expect((await new Session().post('/api/auth/password/reset', { token: resetToken, password: NEW_PW })).status).toBe(200);
    expect((await other.s.post('/api/auth/refresh')).json.code).toBe('REFRESH_TOKEN_INVALID');
    expect((await new Session().post('/api/auth/password/reset', { token: resetToken, password: 'E2eOther2026' })).json.code).toBe('TOKEN_USED');
    expect((await login(EMP, NEW_PW)).res.status).toBe(200);
  });

  it('過期的連結 → TOKEN_EXPIRED;不存在的連結 → TOKEN_INVALID', async () => {
    const token = randomBytes(32).toString('base64url');
    const [u] = await query<{ id: number }>('SELECT user_id AS id FROM gw.[user] WHERE employee_no = @e', { e: EMP });
    await query(
      "INSERT INTO gw.local_account_token (user_id, purpose, token_hash, expires_at) VALUES (@id, 'reset_password', @h, DATEADD(minute, -1, SYSUTCDATETIME()))",
      {
        id: u!.id,
        h: createHash('sha256').update(token).digest('hex'),
      },
    );
    expect((await new Session().post('/api/auth/password/reset', { token, password: 'E2eLate2026x' })).json.code).toBe('TOKEN_EXPIRED');
    expect((await new Session().post('/api/auth/password/reset', { token: `x${token}`, password: 'E2eLate2026x' })).json.code).toBe('TOKEN_INVALID');
  });

  it('註冊與忘記密碼同一來源每小時 10 次,超過回 429', async () => {
    await redisDelPattern('gw:reg:*');
    await forgot(`${EMP_PREFIX}RL0`);
    const key = (await redisCli('--scan', '--pattern', 'gw:reg:ip:*')).split('\n')[0]!;
    expect(key).toMatch(/^gw:reg:ip:/);
    await redisCli('SET', key, '10', 'EX', '3600');
    // Nginx 也會對同一路徑限流(回應相同),以 BFF 計數器是否增加判斷請求確實到達 BFF
    for (let i = 0; ; i++) {
      const res = await forgot(`${EMP_PREFIX}RL1`, true);
      if ((await redisCli('GET', key)) === '11') {
        expect(res.status).toBe(429);
        expect(res.json.code).toBe('RATE_LIMITED');
        break;
      }
      if (i > 10) throw new Error('請求一直被 Nginx 限流');
      await sleep(13_000);
    }
    await redisDelPattern('gw:reg:*');
  });
});
