/**
 * 通知設定(NOTIFY-PLAN §6.9):gw.notify_setting 一個鍵一筆,值為 JSON 文字;未設定的鍵用預設值。
 * 只有 notify.settings.write(超級管理員)可修改;BFF 與 worker 讀取後快取 60 秒。
 */
import type { GwDatabase } from '../../db/client.js';
import { notifySetting } from '../../db/schema/index.js';

export interface NotifySettings {
  /** 公告保留年數;null = 永久(預設) */
  retentionYears: number | null;
  /** 發布畫面的預設到期天數;null = 不到期 */
  defaultExpireDays: number | null;
  /** 已到期公告仍可在「公告查詢」查到(關閉時只有發布人與 .all 看得到) */
  archiveShowsExpired: boolean;
  /** 單次公告 Email 收件人上限 */
  maxEmailRecipients: number;
  /** 單張圖片上限(bytes) */
  maxImageBytes: number;
  /** 公告全文連結(Email、托盤、Windows 通知點擊);{id} 代入公告 ID;站內路徑 */
  viewUrl: string;
}

export const DEFAULT_SETTINGS: NotifySettings = {
  retentionYears: null,
  defaultExpireDays: null,
  archiveShowsExpired: true,
  maxEmailRecipients: 5000,
  maxImageBytes: 2 * 1024 * 1024,
  viewUrl: '/it/notify/archive?id={id}',
};

type Rule = { nullable?: boolean; min?: number; max?: number; type: 'int' | 'bool' | 'path' };
export const SETTING_RULES: Record<keyof NotifySettings, Rule> = {
  retentionYears: { type: 'int', nullable: true, min: 1, max: 100 },
  defaultExpireDays: { type: 'int', nullable: true, min: 1, max: 3650 },
  archiveShowsExpired: { type: 'bool' },
  maxEmailRecipients: { type: 'int', min: 1, max: 20_000 },
  maxImageBytes: { type: 'int', min: 100 * 1024, max: 5 * 1024 * 1024 },
  viewUrl: { type: 'path' },
};

export const isSettingKey = (k: string): k is keyof NotifySettings => Object.hasOwn(SETTING_RULES, k);

/** 驗證單一設定值;回傳錯誤訊息或 null */
export function validateSetting(key: keyof NotifySettings, value: unknown): string | null {
  const r = SETTING_RULES[key];
  if (value === null) return r.nullable ? null : '不可為空';
  if (r.type === 'bool') return typeof value === 'boolean' ? null : '需為 true / false';
  if (r.type === 'path')
    return typeof value === 'string' && value.length <= 300 && /^\/(?!\/)[^\s"'<>]*\{id\}[^\s"'<>]*$/.test(value) ? null : '需為站內路徑(/ 開頭)且含 {id}';
  if (typeof value !== 'number' || !Number.isInteger(value)) return '需為整數';
  if (r.min !== undefined && value < r.min) return `不可小於 ${r.min}`;
  if (r.max !== undefined && value > r.max) return `不可大於 ${r.max}`;
  return null;
}

/** 資料庫的值合併預設值;格式錯誤或不合法的值忽略(用預設) */
export function mergeSettings(rows: { settingKey: string; settingValue: string }[]): NotifySettings {
  const out: NotifySettings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (!isSettingKey(r.settingKey)) continue;
    try {
      const v: unknown = JSON.parse(r.settingValue);
      if (validateSetting(r.settingKey, v) === null) (out as unknown as Record<string, unknown>)[r.settingKey] = v;
    } catch {
      /* 忽略 */
    }
  }
  return out;
}

/** 保留期限的截止時間:publish_at 早於此時間的公告會被清除 */
export const retentionCutoff = (years: number, now = new Date()) => {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
};

export const viewUrlOf = (s: NotifySettings, id: number) => s.viewUrl.replace('{id}', String(id));

const TTL_MS = 60_000;

export class SettingsStore {
  private cache: { at: number; value: NotifySettings } | null = null;

  constructor(private readonly db: GwDatabase) {}

  async get(): Promise<NotifySettings> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.value;
    const value = mergeSettings(await this.db.select({ settingKey: notifySetting.settingKey, settingValue: notifySetting.settingValue }).from(notifySetting));
    this.cache = { at: Date.now(), value };
    return value;
  }

  invalidate() {
    this.cache = null;
  }
}
