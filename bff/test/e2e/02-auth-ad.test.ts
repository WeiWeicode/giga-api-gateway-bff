/** docs/Gherkin/auth/ad-login.feature、local-account.feature(登入方式判斷)(W3-4.2、W3-4.3、W3-4.6c) */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLoginFails, closeAll, login, query, redis } from './gw.js';

beforeAll(async () => {
  for (const emp of ['S112009', 'S112020', 'S112030', 'S112031', 'S199901', 'S199902', 'GV112001', 'V100001', 'S112010', 'S112011']) await clearLoginFails(emp);
});
afterAll(closeAll);

const lastAuthLog = async (username: string) =>
  (
    await query<{ event: string; reason: string; auth_method: string | null }>(
      'SELECT TOP 1 event, reason, auth_method FROM gw.auth_log WHERE username = @u ORDER BY log_id DESC',
      { u: username },
    )
  )[0];

describe('AD 多網域登入', () => {
  it('只輸入工號時依公司網域順序驗證(碩禾 → gsc)', async () => {
    const { res } = await login('S112009');
    expect(res.status).toBe(200);
    expect(res.json.user).toMatchObject({ employeeNo: 'S112009', authType: 'ad', adDomain: 'gsc' });
    expect(res.setCookies.map((c) => c.split('=')[0])).toEqual(expect.arrayContaining(['gn_at', 'gn_rt', 'gn_csrf']));
    const [u] = await query('SELECT ad_domain, auth_type, upn, ad_object_guid FROM gw.[user] WHERE employee_no = @e', { e: 'S112009' });
    expect(u).toMatchObject({ ad_domain: 'gsc', auth_type: 'ad', upn: 'S112009@gsc.com.tw' });
    expect(u.ad_object_guid).toMatch(/^[0-9A-F-]{36}$/i);
  });

  it('舊網域驗證失敗時改試新網域(S112031:gsc 密碼不符 → gsmc 成功)', async () => {
    const { res } = await login('S112031');
    expect(res.status).toBe(200);
    expect(res.json.user.adDomain).toBe('gsmc');
  });

  it('查無工號的所屬公司時嘗試全部網域(S112030 只在 gsmc)', async () => {
    const { res } = await login('S112030');
    expect(res.status).toBe(200);
    expect(res.json.user.adDomain).toBe('gsmc');
  });

  it.each([
    ['GSC\\S112009', 'gsc'],
    ['S112030@gsmc.com.tw', 'gsmc'],
  ])('帶網域的帳號直接到指定網域驗證:%s → %s', async (username, domain) => {
    const { res } = await login(username);
    expect(res.status).toBe(200);
    expect(res.json.user.adDomain).toBe(domain);
  });

  it('帶網域但帳號不在該網域時不改試其他網域', async () => {
    const { res } = await login('GSC\\S112030');
    expect(res.status).toBe(401);
  });

  it('密碼錯誤時回應不透露細節,並寫入 auth_log', async () => {
    const { res } = await login('S112020', 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ code: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' });
    expect(await lastAuthLog('S112020')).toMatchObject({ event: 'login_fail' });
  });

  it('同帳號 15 分鐘內失敗 5 次即暫停嘗試(即使密碼正確)', async () => {
    await clearLoginFails('S112020');
    for (let i = 0; i < 5; i++) expect((await login('S112020', 'wrong')).res.status).toBe(401);
    const { res } = await login('S112020');
    expect(res.status).toBe(429);
    expect(res.json.code).toBe('LOGIN_THROTTLED');
    expect(await lastAuthLog('S112020')).toMatchObject({ event: 'login_fail', reason: 'throttled' });
    expect(Number(await redis().get('gw:login:fail:S112020'))).toBe(5);
    expect(await redis().ttl('gw:login:fail:S112020')).toBeGreaterThan(800);
    await clearLoginFails('S112020');
  });

  it('AD 帳號停用 → ACCOUNT_DISABLED;密碼過期 → AD_PASSWORD_EXPIRED', async () => {
    const d = await login('S199901');
    expect(d.res.status).toBe(403);
    expect(d.res.json.code).toBe('ACCOUNT_DISABLED');
    const e = await login('S199902');
    expect(e.res.status).toBe(401);
    expect(e.res.json.code).toBe('AD_PASSWORD_EXPIRED');
  });

  it('登入時同步 AD 巢狀群組並對應角色(S100001 經 GN-MES-Leads 巢狀屬於 GN-MES-Operators)', async () => {
    const { res } = await login('S100001');
    expect(res.status).toBe(200);
    expect(res.json.roles).toEqual(expect.arrayContaining(['employee', 'mes-operator', 'gw-it-admin', 'it-endpoint']));
    expect(res.json.permissions).toContain('mes.workorder.read');
    const [u] = await query<{ ad_groups: string }>('SELECT ad_groups FROM gw.[user] WHERE employee_no = @e', { e: 'S100001' });
    expect(JSON.parse(u!.ad_groups)).toContain('CN=GN-MES-Operators,OU=Groups,DC=gsc,DC=com,DC=tw');
  });

  it('人事資料取自 BPM / LOS(BPM 優先、LOS 補充),不取自 AD', async () => {
    const { res } = await login('S112009');
    // BPM 部門 S1800(LOS 為 S1700);BPM 職稱為空 → 取 LOS「工程師」
    expect(res.json.user).toMatchObject({ deptCode: 'S1800', department: '資訊部', title: '工程師' });
    // 兼任帳號 US112009(禾迅)併入本人
    expect(res.json.companies).toEqual(expect.arrayContaining(['碩禾', '禾迅']));
    const rows = await query(
      'SELECT uc.via_employee_no, uc.is_virtual, c.comp_name FROM gw.user_company uc JOIN gw.company c ON c.company_id = uc.company_id JOIN gw.[user] u ON u.user_id = uc.user_id WHERE u.employee_no = @e',
      {
        e: 'S112009',
      },
    );
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ via_employee_no: 'US112009', is_virtual: true, comp_name: '禾迅' })]));
  });

  it('人員同步尚未涵蓋時即時補查 BPM(S112010 只在 BPM)', async () => {
    const { res } = await login('S112010');
    expect(res.status).toBe(200);
    const [u] = await query('SELECT profile_source, dept_code FROM gw.[user] WHERE employee_no = @e', { e: 'S112010' });
    expect(u).toMatchObject({ profile_source: 'bpm', dept_code: 'S1800' });
  });

  it('BPM / LOS 都查無時仍以 AD 資料登入(profile_source = ad_only)', async () => {
    const { res } = await login('S112011');
    expect(res.status).toBe(200);
    const [u] = await query('SELECT profile_source, display_name FROM gw.[user] WHERE employee_no = @e', { e: 'S112011' });
    expect(u).toMatchObject({ profile_source: 'ad_only', display_name: '外包人員' });
  });
});

describe('登入方式判斷', () => {
  it('兼任帳號不可單獨登入 → INVALID_CREDENTIALS', async () => {
    const { res } = await login('GV112001');
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('INVALID_CREDENTIALS');
  });

  it('無網域公司的員工尚未註冊 → ACCOUNT_NOT_REGISTERED,且不向 AD 送出驗證', async () => {
    const { res } = await login('V100001');
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('ACCOUNT_NOT_REGISTERED');
    expect((await lastAuthLog('V100001'))!.reason).toContain('company has no domain');
  });

  it('工號格式異常的輸入直接拒絕', async () => {
    const { res } = await login("S1%' OR 1=1 --");
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('INVALID_CREDENTIALS');
  });
});
