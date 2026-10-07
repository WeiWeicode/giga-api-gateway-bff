/**
 * 公告(NOTIFY-PLAN §6、W10-2):對象比對、HTML 白名單清洗(XSS)、純文字、圖片、通知設定
 */
import { describe, expect, it } from 'vitest';
import { matchAudience, normalizeAudience, withinOwnDepts, type AudienceFacts } from '../../src/modules/notify/audience.js';
import { assetIdsIn, htmlToPlainText, sanitizeAnnouncementHtml, sniffImage, summaryOf, toCidImages } from '../../src/modules/notify/html.js';
import { DEFAULT_SETTINGS, mergeSettings, retentionCutoff, validateSetting, viewUrlOf } from '../../src/modules/notify/settings.js';
import { DeptTree } from '../../src/modules/rbac/rules.js';

// 部門樹:S1000 → S1300 → S1310 → S1311;S1000 → S1600
const tree = new DeptTree([
  { deptCode: 'S1000', parentDeptCode: null },
  { deptCode: 'S1300', parentDeptCode: 'S1000' },
  { deptCode: 'S1310', parentDeptCode: 'S1300' },
  { deptCode: 'S1311', parentDeptCode: 'S1310' },
  { deptCode: 'S1600', parentDeptCode: 'S1000' },
]);

const person = (o: Partial<AudienceFacts> = {}): AudienceFacts => ({
  employeeNo: 'S900001',
  adGroups: ['CN=IT-Admins,OU=Groups,DC=gsmc,DC=local'],
  memberships: [{ companyId: 1, deptCode: 'S1311' }],
  jobLevel: '8',
  ...o,
});

describe('公告對象', () => {
  it('正規化:去重、工號轉大寫、部門預設含下層、未知職級門檻與空對象報錯', () => {
    const { audience, errors } = normalizeAudience({
      users: [' s900001 ', 'S900001'],
      depts: [{ code: 'S1300', sub: false }, { code: 'S1600' } as never],
      companies: [1, 1],
      jobTier: 'all',
    });
    expect(errors).toEqual([]);
    expect(audience).toEqual({
      users: ['S900001'],
      depts: [
        { code: 'S1300', sub: false },
        { code: 'S1600', sub: true },
      ],
      companies: [1],
    });
    expect(normalizeAudience({ all: true, jobTier: 'boss' }).errors[0]?.field).toBe('audience.jobTier');
    expect(normalizeAudience({}).errors[0]?.field).toBe('audience');
  });

  it('全公司 + 職級門檻(≈ Notes 的 .S經理級以上人員):職級空白或不足的人不符合', () => {
    const a = { all: true, jobTier: 'manager' };
    expect(matchAudience(a, person({ jobLevel: '6' }), tree)).toBe(true);
    expect(matchAudience(a, person({ jobLevel: '8' }), tree)).toBe(false);
    expect(matchAudience(a, person({ jobLevel: null }), tree)).toBe(false);
    expect(matchAudience({ all: true }, person({ jobLevel: null }), tree)).toBe(true);
  });

  it('部門含下層 / 不含下層;公司;兼任(多個所屬部門)任一符合即可', () => {
    expect(matchAudience({ depts: [{ code: 'S1300', sub: true }] }, person(), tree)).toBe(true);
    expect(matchAudience({ depts: [{ code: 'S1300', sub: false }] }, person(), tree)).toBe(false);
    expect(matchAudience({ depts: [{ code: 'S1600', sub: true }] }, person(), tree)).toBe(false);
    expect(
      matchAudience(
        { depts: [{ code: 'S1600', sub: false }] },
        person({
          memberships: [
            { companyId: 1, deptCode: 'S1311' },
            { companyId: 2, deptCode: 'S1600' },
          ],
        }),
        tree,
      ),
    ).toBe(true);
    expect(matchAudience({ companies: [2] }, person(), tree)).toBe(false);
    expect(matchAudience({ companies: [1] }, person(), tree)).toBe(true);
  });

  it('指定工號、AD 群組(完整 DN 或 CN 名稱)不受職級門檻限制', () => {
    expect(matchAudience({ users: ['S900001'], jobTier: 'division' }, person(), tree)).toBe(true);
    expect(matchAudience({ adGroups: ['it-admins'], jobTier: 'division' }, person(), tree)).toBe(true);
    expect(matchAudience({ adGroups: ['CN=IT-Admins,OU=Groups,DC=gsmc,DC=local'] }, person(), tree)).toBe(true);
    expect(matchAudience({ adGroups: ['IT'] }, person(), tree)).toBe(false);
  });

  it('沒有全公司權限時只能發給本部門(含下層);全公司、公司、群組、指定工號一律超出', () => {
    expect(withinOwnDepts({ depts: [{ code: 'S1311', sub: true }] }, ['S1310'], tree)).toBe(true);
    expect(withinOwnDepts({ depts: [{ code: 'S1300', sub: true }] }, ['S1310'], tree)).toBe(false);
    expect(withinOwnDepts({ all: true }, ['S1000'], tree)).toBe(false);
    expect(withinOwnDepts({ users: ['S900001'] }, ['S1311'], tree)).toBe(false);
    expect(withinOwnDepts({ depts: [{ code: 'S1311', sub: true }] }, [], tree)).toBe(false);
  });
});

describe('公告 HTML 清洗(XSS)', () => {
  const clean = sanitizeAnnouncementHtml;

  it('移除腳本、事件屬性、iframe、SVG、表單與 style 標籤', () => {
    const out = clean(
      '<p onclick="x()">a<script>alert(1)</script></p><iframe src="https://x"></iframe><svg><script>1</script></svg><form><input></form><style>p{}</style><img src=x onerror=alert(1)>',
    );
    expect(out).toBe('<p>a</p>');
  });

  it('連結只留 https、mailto、站內路徑;一律另開新視窗且 noopener', () => {
    expect(clean('<a href="https://www.gigasolar.com.tw">官網</a>')).toBe(
      '<a href="https://www.gigasolar.com.tw" target="_blank" rel="noopener noreferrer">官網</a>',
    );
    expect(clean('<a href="/it/notify">站內</a>')).toContain('href="/it/notify"');
    expect(clean('<a href="mailto:it@gigasolar.com.tw">信</a>')).toContain('href="mailto:it@gigasolar.com.tw"');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java&#x09;script:alert(1)',
      'data:text/html,<b>',
      '//evil.example',
      'http://insecure',
      'relative/path',
      'vbscript:x',
    ])
      expect(clean(`<a href="${bad}">x</a>`), bad).not.toMatch(/href=/);
  });

  it('圖片只接受本平台圖片 API', () => {
    expect(clean('<img src="/api/notify/assets/12" alt="圖">')).toBe('<img src="/api/notify/assets/12" alt="圖" />');
    expect(clean('<img src="https://tracker.example/p.gif">')).toBe('');
    expect(clean('<img src="/api/notify/assets/12/../../auth/me">')).toBe('');
    expect(clean('<img src="data:image/png;base64,AAAA">')).toBe('');
  });

  it('樣式只留文字顏色、背景色與對齊;url()、expression 移除', () => {
    expect(clean('<span style="color:#dc2626;font-size:40px">紅</span>')).toBe('<span style="color:#dc2626">紅</span>');
    expect(clean('<p style="text-align:center">中</p>')).toBe('<p style="text-align:center">中</p>');
    expect(clean('<span style="background-color:url(https://x)">x</span>')).toBe('<span>x</span>');
    expect(clean('<span style="color:expression(alert(1))">x</span>')).toBe('<span>x</span>');
  });

  it('保留編輯器的結構:標題、清單、表格(含合併儲存格)、引用', () => {
    const html = '<h2>特休</h2><ul><li>一</li></ul><table><tbody><tr><td colspan="2">合併</td></tr></tbody></table><blockquote>引</blockquote>';
    expect(clean(html)).toBe(html);
  });
});

describe('純文字、摘要與 Email 圖片', () => {
  it('HTML 轉純文字:不含網址與圖片,表格保留文字', () => {
    const text = htmlToPlainText(
      '<h2>全體員工特休</h2><p>10/10 全體<strong>特休</strong>,詳見<a href="https://x">公告</a>。</p><img src="/api/notify/assets/1"><table><tr><td>日期</td><td>10/10</td></tr></table>',
    );
    expect(text).toContain('全體員工特休');
    expect(text).toContain('10/10 全體特休,詳見公告。');
    expect(text).toContain('日期');
    expect(text).not.toContain('https://x');
    expect(text).not.toContain('assets');
  });

  it('摘要截斷並合併空白', () => {
    expect(summaryOf('a\n\nb   c', 200)).toBe('a b c');
    expect(summaryOf('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('內文圖片 ID 與 CID 改寫', () => {
    const html = '<p><img src="/api/notify/assets/3" /><img src="/api/notify/assets/5" alt="b" /><img src="/api/notify/assets/3" /></p>';
    expect(assetIdsIn(html)).toEqual([3, 5]);
    expect(toCidImages(html)).toBe('<p><img src="cid:asset-3@giganexus" /><img src="cid:asset-5@giganexus" alt="b" /><img src="cid:asset-3@giganexus" /></p>');
  });

  it('圖片格式以檔頭判斷;SVG 與偽裝的檔案不接受', () => {
    expect(sniffImage(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))).toBe('image/png');
    expect(sniffImage(Buffer.from('ffd8ffe000104a4649460001', 'hex'))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<html><script>'))).toBeNull();
  });
});

describe('通知設定', () => {
  it('預設:保留永久、不到期、已到期公告可查', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ retentionYears: null, defaultExpireDays: null, archiveShowsExpired: true });
  });

  it('驗證範圍與型別', () => {
    expect(validateSetting('retentionYears', null)).toBeNull();
    expect(validateSetting('retentionYears', 0)).toMatch(/不可小於/);
    expect(validateSetting('retentionYears', 2.5)).toMatch(/整數/);
    expect(validateSetting('maxEmailRecipients', null)).toMatch(/不可為空/);
    expect(validateSetting('archiveShowsExpired', 'yes')).toMatch(/true/);
    expect(validateSetting('viewUrl', '/notices/{id}')).toBeNull();
    expect(validateSetting('viewUrl', 'https://evil.example/{id}')).not.toBeNull();
    expect(validateSetting('viewUrl', '//evil.example/{id}')).not.toBeNull();
    expect(validateSetting('viewUrl', '/notices')).not.toBeNull();
  });

  it('資料庫值合併預設值;格式錯誤或不合法的值忽略', () => {
    const s = mergeSettings([
      { settingKey: 'retentionYears', settingValue: '3' },
      { settingKey: 'maxEmailRecipients', settingValue: '"abc"' },
      { settingKey: 'archiveShowsExpired', settingValue: 'not json' },
      { settingKey: 'unknown', settingValue: '1' },
    ]);
    expect(s).toEqual({ ...DEFAULT_SETTINGS, retentionYears: 3 });
    expect(viewUrlOf(s, 42)).toBe('/it/notify/archive?id=42');
  });

  it('保留期限截止時間', () => {
    expect(retentionCutoff(2, new Date('2026-10-07T00:00:00Z')).toISOString()).toBe('2024-10-07T00:00:00.000Z');
  });
});
