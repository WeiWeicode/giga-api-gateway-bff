/**
 * 通知範本與通道(PRD §8.5):純函式,不做 I/O。
 * 範本變數 `{{name}}`、`{{a.b}}`(Handlebars 相容的子集;不支援區塊與 helper),缺少的變數輸出空字串。
 */

/** 本階段開放的通道;LINE 暫緩(PRD Q7),要求時回 CHANNEL_NOT_SUPPORTED */
export const CHANNELS = ['email', 'inapp'] as const;
export type Channel = (typeof CHANNELS)[number];

export const isChannel = (c: string): c is Channel => (CHANNELS as readonly string[]).includes(c);

/** gw.notify_template.channels:JSON 陣列(例 ["email","inapp"]);格式錯誤時視為沒有預設通道 */
export function parseChannels(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

function lookup(data: Record<string, unknown>, path: string): unknown {
  let v: unknown = data;
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** 以資料替換 `{{變數}}`;html = true 時跳脫(Email HTML 內文),主旨與站內通知為純文字不跳脫 */
export function renderTemplate(text: string, data: Record<string, unknown>, html = false): string {
  return text.replace(/\{\{\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\}\}/g, (_m, path: string) => {
    const v = lookup(data, path);
    const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return html ? escapeHtml(s) : s;
  });
}
