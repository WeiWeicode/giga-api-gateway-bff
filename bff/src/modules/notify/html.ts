/**
 * 公告 HTML 內文(NOTIFY-PLAN §6.7):白名單清洗、純文字轉換、內文圖片。純函式,不做 I/O。
 *
 *   - 標籤只留編輯器(Tiptap)會產生的結構;屬性只留連結、站內圖片、表格合併、文字顏色與對齊。
 *   - 連結只接受 https:、mailto: 與站內路徑(/ 開頭);一律加 target=_blank rel=noopener noreferrer。
 *   - 圖片只接受本平台圖片 API(/api/notify/assets/{id}),不接受外部網址(追蹤像素、內網連不到外網)。
 *   前端顯示前另以 DOMPurify 再清一次(web-kit sanitizeHtml,白名單相同)。
 */
import { convert } from 'html-to-text';
import sanitize from 'sanitize-html';

export const ASSET_PATH = '/api/notify/assets/';
const ASSET_SRC = /^\/api\/notify\/assets\/(\d{1,18})$/;
const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i];

/** 內文上限(清洗後):200 KB(nvarchar 字元數) */
export const MAX_BODY_CHARS = 200_000;
/** body_text 欄位長度 */
export const MAX_TEXT_CHARS = 4000;

const OPTIONS: sanitize.IOptions = {
  allowedTags: [
    'p',
    'br',
    'h2',
    'h3',
    'h4',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'del',
    'span',
    'mark',
    'sub',
    'sup',
    'code',
    'pre',
    'ul',
    'ol',
    'li',
    'blockquote',
    'hr',
    'a',
    'img',
    'table',
    'colgroup',
    'col',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    col: ['span'],
    ol: ['start'],
    '*': ['style'],
  },
  allowedStyles: {
    '*': { color: COLOR, 'background-color': COLOR, 'text-align': [/^(left|right|center|justify)$/] },
  },
  allowedSchemes: ['https', 'mailto'],
  allowedSchemesByTag: { img: [] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
  },
  exclusiveFilter: (frame) => frame.tag === 'img' && !ASSET_SRC.test(frame.attribs.src ?? ''),
};

/** 白名單清洗;站內連結以 / 開頭(不允許 // 協定相對網址) */
export function sanitizeAnnouncementHtml(html: string): string {
  const clean = sanitize(html, OPTIONS);
  // sanitize-html 對沒有協定的網址視為相對路徑放行:只留 / 開頭的站內路徑與白名單協定,其餘(例 javascript 被拆字、data)移除 href
  return clean.replace(/<a\b([^>]*?)\shref="([^"]*)"/g, (m, pre: string, href: string) =>
    /^(https:|mailto:|\/(?!\/))/i.test(href.replace(/&amp;/g, '&')) ? m : `<a${pre}`,
  );
}

/** 純文字版:Toast 摘要、Windows 通知、托盤、關鍵字搜尋 */
export function htmlToPlainText(html: string): string {
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'h4', options: { uppercase: false } },
      { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false } },
    ],
  });
  return text
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

/** 摘要(WebSocket、Windows 通知):純文字前 n 字,換行改空白 */
export const summaryOf = (text: string, n = 200) => {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** 內文引用的圖片 ID */
export function assetIdsIn(html: string): number[] {
  const ids = new Set<number>();
  for (const m of html.matchAll(/<img\b[^>]*\ssrc="\/api\/notify\/assets\/(\d{1,18})"/g)) ids.add(Number(m[1]));
  return [...ids];
}

/** Email 版:圖片改為 CID 內嵌附件(收件人不必登入就看得到) */
export const toCidImages = (html: string) => html.replace(/(<img\b[^>]*\ssrc=")\/api\/notify\/assets\/(\d{1,18})"/g, '$1cid:asset-$2@giganexus"');

/** 圖片格式以檔頭判斷(不信任副檔名與 Content-Type);不接受 SVG(可夾帶腳本) */
export function sniffImage(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
