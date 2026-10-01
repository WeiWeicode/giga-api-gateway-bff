import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { isChannel, parseChannels, renderTemplate } from '../../src/modules/notify/template.js';

describe('renderTemplate(PRD §8.5)', () => {
  const data = { formNo: 'LV-20261201-001', applicant: { name: '王<小明>' }, count: 3 };

  it('替換變數與巢狀欄位,允許空白', () => {
    expect(renderTemplate('單號 {{formNo}},申請人 {{ applicant.name }},共 {{count}} 筆', data)).toBe('單號 LV-20261201-001,申請人 王<小明>,共 3 筆');
  });

  it('HTML 內文跳脫變數值,範本本身的 HTML 保留', () => {
    expect(renderTemplate('<b>{{applicant.name}}</b>', data, true)).toBe('<b>王&lt;小明&gt;</b>');
  });

  it('缺少的變數輸出空字串;不讀取原型鏈', () => {
    expect(renderTemplate('[{{missing}}][{{formNo.length}}][{{constructor}}]', data)).toBe('[][][]');
  });
});

describe('通道', () => {
  it('只開放 email、inapp(LINE 暫緩)', () => {
    expect(['email', 'inapp', 'line'].map(isChannel)).toEqual([true, true, false]);
  });

  it('範本預設通道為 JSON 陣列,格式錯誤視為無', () => {
    expect(parseChannels('["email","inapp"]')).toEqual(['email', 'inapp']);
    expect(parseChannels('email')).toEqual([]);
    expect(parseChannels(null)).toEqual([]);
  });
});

describe('Email 設定(DEPLOYMENT.md §5.1)', () => {
  const base = {
    GW_DB_HOST: 'h',
    GW_DB_NAME: 'd',
    GW_DB_USER: 'u',
    GW_DB_PASSWORD: 'p',
    REDIS_URL: 'redis://r',
    JWT_KEYS_DIR: '/k',
    MAIL_HOST: '10.10.130.69',
  };

  it('非正式區設定 MAIL_HOST 必須同時設定 MAIL_REDIRECT_TO', () => {
    expect(() => loadConfig({ ...base, GW_ENV: 'test' })).toThrow(/MAIL_REDIRECT_TO/);
    expect(loadConfig({ ...base, GW_ENV: 'test', MAIL_REDIRECT_TO: 'tester@example.com' }).mail).toMatchObject({ port: 25, redirectTo: 'tester@example.com' });
  });

  it('正式區不需要改寄', () => {
    expect(loadConfig({ ...base, GW_ENV: 'prod' }).mail.redirectTo).toBeUndefined();
  });
});
