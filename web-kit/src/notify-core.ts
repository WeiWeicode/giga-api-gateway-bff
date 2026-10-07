/**
 * 通知與公告的型別與純邏輯(NOTIFY-PLAN §6.5,不碰 DOM / 網路,可單元測試)。
 * 瀏覽器端(WebSocket、收件匣、桌面通知、HTML 清洗)在 notify.ts。
 */

/** 收件匣的應用代碼(/ws/notify?app=、/api/notify/feed?app=) */
export type NotifyApp = 'portal' | 'itapp';
export type NotifyLevel = 'info' | 'important' | 'urgent';
export type AnnounceChannel = 'portal' | 'itapp' | 'agent' | 'email';
export type AnnouncementStatus = 'draft' | 'scheduled' | 'published' | 'revoked';

export interface AudienceDept {
  code: string;
  sub: boolean;
}

/** 公告對象:符合 = 指定工號 ∪ AD 群組 ∪ ((全公司 ∪ 公司 ∪ 部門) ∩ 職級門檻) */
export interface Audience {
  all?: boolean;
  companies?: number[];
  depts?: AudienceDept[];
  jobTier?: string;
  adGroups?: string[];
  users?: string[];
}

/** 收件匣項目:公告或個人通知 */
export interface FeedItem {
  kind: 'announcement' | 'message';
  id: number;
  title: string;
  summary: string;
  level: string;
  linkUrl: string | null;
  at: string;
  isRead: boolean;
  requireAck?: boolean;
  publisherTitle?: string | null;
  expireAt?: string | null;
  isExpired?: boolean;
  ackAt?: string | null;
}

export interface Feed {
  total: number;
  unread: number;
  page: number;
  pageSize: number;
  items: FeedItem[];
}

export interface AnnouncementDetail {
  announcementId: number;
  title: string;
  bodyHtml: string;
  linkUrl: string | null;
  level: NotifyLevel;
  requireAck: boolean;
  publisherTitle: string | null;
  publishAt: string | null;
  expireAt: string | null;
  myReceipt: { readAt: string | null; ackAt: string | null } | null;
  /** 以下只有發布人 / 全公司權限看得到 */
  status?: AnnouncementStatus;
  audience?: Audience;
  audienceText?: string;
  channels?: AnnounceChannel[];
  targetCount?: number | null;
  createdBy?: string;
  rowVer?: string;
}

export interface AnnouncementInput {
  title: string;
  bodyHtml: string;
  level: NotifyLevel;
  audience: Audience;
  channels: AnnounceChannel[];
  linkUrl?: string | null;
  requireAck?: boolean;
  publishAt?: string | null;
  expireAt?: string | null;
  publisherTitle?: string | null;
  draft?: boolean;
  idempotencyKey?: string;
}

export interface ComposeOptions {
  channels: {
    code: AnnounceChannel;
    name: string;
    available: boolean;
    note: string | null;
  }[];
  levels: { code: NotifyLevel; name: string }[];
  jobTiers: { code: string; name: string }[];
  companies: { id: number; name: string }[];
  depts: {
    code: string;
    name: string;
    parentCode: string | null;
    companyId: number | null;
  }[];
  canPublishAll: boolean;
  ownDepts: string[];
  defaults: {
    expireDays: number | null;
    level: NotifyLevel;
    channels: AnnounceChannel[];
  };
  maxImageBytes: number;
  maxEmailRecipients: number;
  mailRatePerSec: number;
}

export interface AudiencePreview {
  allowed: boolean;
  targetCount: number;
  withEmail: number;
  withoutEmail: number;
  emailOverLimit: boolean;
  estimatedEmailMinutes: number;
  description: string;
  sample: {
    employeeNo: string;
    displayName: string;
    department: string | null;
  }[];
}

export interface AnnouncementRow {
  announcementId: number;
  title: string;
  level: NotifyLevel;
  status: AnnouncementStatus;
  audience: Audience;
  audienceText: string;
  channels: AnnounceChannel[];
  requireAck: boolean;
  publishAt: string | null;
  expireAt: string | null;
  publisherTitle: string | null;
  targetCount: number | null;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  readCount: number;
  ackCount: number;
  /** Email 寄送狀態統計(queued / sent / failed / dead / skipped) */
  email: Record<string, number> | null;
}

export interface Receipts {
  targetCount: number;
  snapshotCount: number | null;
  readCount: number;
  ackCount: number;
  total: number;
  page: number;
  pageSize: number;
  items: {
    employeeNo: string;
    displayName: string;
    department: string | null;
    email: string | null;
    readAt: string | null;
    ackAt: string | null;
    seenVia: string | null;
  }[];
}

export interface NotifySettings {
  retentionYears: number | null;
  defaultExpireDays: number | null;
  archiveShowsExpired: boolean;
  maxEmailRecipients: number;
  maxImageBytes: number;
  viewUrl: string;
}

/** /ws/notify 收到的訊息 */
export type NotifySocketMessage =
  | { type: 'hello'; emp: string; app: NotifyApp }
  | { type: 'pong'; time: string }
  | {
      type: 'announcement';
      announcementId: number;
      title: string;
      summary: string;
      level: NotifyLevel;
      requireAck: boolean;
      publisherTitle: string | null;
      linkUrl: string | null;
      publishedAt: string;
    }
  | { type: 'revoked'; announcementId: number }
  | {
      type: 'notification';
      messageId: number;
      title: string;
      body: string;
      linkUrl: string | null;
      createdAt: string;
    };

export const LEVEL_NAMES: Record<NotifyLevel, string> = {
  info: '一般',
  important: '重要',
  urgent: '緊急',
};

/** 重連延遲:1、2、4、8、16、30、30… 秒,加 0–20% 抖動避免同時重連 */
export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 + random() * 0.2));
}

/** 解析 WebSocket 訊息;格式不對回傳 null */
export function parseSocketMessage(data: unknown): NotifySocketMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const m = JSON.parse(data) as { type?: unknown };
    return m && typeof m === 'object' && typeof m.type === 'string' ? (m as NotifySocketMessage) : null;
  } catch {
    return null;
  }
}

/** 新公告的提示方式:urgent 或需確認 → 對話框;其餘 → Toast;分頁在背景時另跳桌面通知(L1) */
export function presentationOf(
  m: { level: string; requireAck?: boolean },
  env: {
    hidden: boolean;
    permission: 'granted' | 'denied' | 'default' | 'unsupported';
  },
): { dialog: boolean; toast: boolean; desktop: boolean } {
  const dialog = m.level === 'urgent' || !!m.requireAck;
  return {
    dialog,
    toast: !dialog,
    desktop: env.hidden && env.permission === 'granted',
  };
}

/** 收到撤回:從清單移除該公告(未讀數由呼叫端重新查詢) */
export function removeAnnouncement(items: FeedItem[], announcementId: number): FeedItem[] {
  return items.filter((i) => !(i.kind === 'announcement' && i.id === announcementId));
}

/* ---------- HTML 白名單(與 BFF modules/notify/html.ts 相同) ---------- */

export const ALLOWED_TAGS = [
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
];
/** 連同內容一起移除的標籤(可執行、可載入外部資源或可造成 mXSS 的命名空間) */
export const DROP_WITH_CONTENT = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'template',
  'noscript',
  'noembed',
  'noframes',
  'xmp',
  'plaintext',
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'link',
  'meta',
  'base',
  'title',
  'head',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'portal',
  'dialog',
];
export const ALLOWED_ATTR = ['href', 'target', 'rel', 'src', 'alt', 'width', 'height', 'colspan', 'rowspan', 'span', 'start', 'style'];

/** 連結:https、mailto、站內路徑(不接受 // 協定相對網址) */
export const isAllowedHref = (v: string) => /^(https:|mailto:|\/(?!\/))/i.test(v.trim());
/** 圖片:只接受本平台圖片 API */
export const isAllowedImageSrc = (v: string) => /^\/api\/notify\/assets\/\d{1,18}$/.test(v.trim());

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;

/** style 屬性只留文字顏色、背景色與對齊;其餘宣告移除 */
export function filterStyle(style: string): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if ((prop === 'color' || prop === 'background-color') && COLOR.test(value)) out.push(`${prop}:${value}`);
    else if (prop === 'text-align' && /^(left|right|center|justify)$/i.test(value)) out.push(`${prop}:${value.toLowerCase()}`);
  }
  return out.join(';');
}
