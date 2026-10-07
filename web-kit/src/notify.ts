/**
 * 通知與公告(NOTIFY-PLAN §6.5):入口網與 GigaItApp 共用,不含畫面。
 *
 *   const center = useNotifyCenter('itapp')     // 同一應用共用一份狀態(鈴鐺、儀表板卡片、收件匣)
 *   center.start()                              // 連 /ws/notify?app=itapp,斷線指數退避重連,(重)連上即補查收件匣
 *   center.onArrive((m) => toast(m.title))      // 新公告 / 個人通知
 *   await center.markRead(id)
 *   notifyApi.create({ ... })                   // 發布端 API
 *   sanitizeHtml(detail.bodyHtml)               // 顯示前第二次清洗(BFF 已清洗一次;不依賴第三方套件,入口網以原始碼引用 web-kit)
 *   await enableDesktopNotify()                 // 須在使用者點擊時呼叫;之後分頁在背景時跳 Windows 通知(L1)
 *
 * WebSocket 只負責即時;正確性以 API 為準(收到推播一律重新查詢收件匣)。
 */
import { computed, reactive, readonly } from 'vue';
import { http, refreshSession } from './http';
import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  DROP_WITH_CONTENT,
  filterStyle,
  isAllowedHref,
  isAllowedImageSrc,
  parseSocketMessage,
  presentationOf,
  reconnectDelay,
  removeAnnouncement,
  type AnnouncementDetail,
  type AnnouncementInput,
  type AnnouncementRow,
  type AnnouncementStatus,
  type Audience,
  type AudiencePreview,
  type ComposeOptions,
  type Feed,
  type FeedItem,
  type NotifyApp,
  type NotifySettings,
  type NotifySocketMessage,
  type Receipts,
} from './notify-core';

const PING_MS = 25_000;

function qs(q: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/* ---------------- API ---------------- */

export const notifyApi = {
  composeOptions: () => http.get<ComposeOptions>('/api/notify/compose-options'),
  preview: (audience: Audience, channels?: string[]) =>
    http.post<AudiencePreview>('/api/notify/announcements/preview', {
      audience,
      channels,
    }),
  create: (input: AnnouncementInput) =>
    http.post<{
      announcementId: number;
      status: AnnouncementStatus;
      targetCount: number | null;
      code?: string;
    }>('/api/notify/announcements', input),
  update: (id: number, patch: Partial<AnnouncementInput> & { rowVer: string; publish?: boolean }) =>
    http.patch<AnnouncementDetail>(`/api/notify/announcements/${id}`, patch),
  list: (
    q: {
      status?: AnnouncementStatus;
      q?: string;
      mine?: boolean;
      page?: number;
      pageSize?: number;
    } = {},
  ) =>
    http.get<{
      total: number;
      page: number;
      pageSize: number;
      items: AnnouncementRow[];
    }>(`/api/notify/announcements${qs(q)}`),
  get: (id: number) => http.get<AnnouncementDetail>(`/api/notify/announcements/${id}`),
  receipts: (
    id: number,
    q: {
      state?: 'read' | 'unread' | 'all';
      q?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) => http.get<Receipts>(`/api/notify/announcements/${id}/receipts${qs(q)}`),
  /** 已讀名單 CSV 下載網址(同網域,Cookie 自動帶上) */
  receiptsCsvUrl: (id: number, state: 'read' | 'unread' | 'all' = 'all') => `/api/notify/announcements/${id}/receipts${qs({ format: 'csv', state })}`,
  revoke: (id: number) => http.post<{ announcementId: number; status: AnnouncementStatus }>(`/api/notify/announcements/${id}/revoke`),
  remind: (id: number) => http.post<{ queued: boolean }>(`/api/notify/announcements/${id}/remind`),
  uploadAsset: (file: File | Blob, name = 'image') => {
    const fd = new FormData();
    fd.append('file', file, file instanceof File ? file.name : name);
    return http.post<{
      assetId: number;
      url: string;
      contentType: string;
      sizeBytes: number;
    }>('/api/notify/assets', fd);
  },
  feed: (app: NotifyApp, q: { unread?: boolean; page?: number; pageSize?: number } = {}) => http.get<Feed>(`/api/notify/feed${qs({ app, ...q })}`),
  archive: (
    q: {
      q?: string;
      from?: string;
      to?: string;
      level?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) => http.get<Feed>(`/api/notify/archive${qs(q)}`),
  read: (id: number, via: string) => http.post<{ readAt: string; ackAt: string | null }>(`/api/notify/announcements/${id}/read`, { via }),
  ack: (id: number, via: string) => http.post<{ readAt: string; ackAt: string | null }>(`/api/notify/announcements/${id}/ack`, { via }),
  readMessage: (id: number) => http.post<{ unread: number }>(`/api/notify/messages/${id}/read`),
  readAllMessages: () => http.post<{ unread: number }>('/api/notify/messages/read-all'),
  settings: () =>
    http.get<{
      settings: NotifySettings;
      defaults: NotifySettings;
      readonly: { mailRatePerSec: number };
    }>('/api/admin/notify/settings'),
  saveSettings: (changes: Partial<Record<keyof NotifySettings, unknown>>) =>
    http.put<{ settings: NotifySettings }>('/api/admin/notify/settings', {
      changes,
    }),
  retentionPreview: (years: number) =>
    http.get<{ years: number; cutoff: string; announcements: number }>(`/api/admin/notify/settings/retention-preview${qs({ years })}`),
};

/* ---------------- WebSocket ---------------- */

export interface NotifyClient {
  close(): void;
}

/** 連 /ws/notify?app=;斷線指數退避重連;登入過期(4401)先換發 Token 再連,換發失敗就停止 */
export function createNotifyClient(opts: {
  app: NotifyApp;
  onMessage: (m: NotifySocketMessage) => void;
  onStatus?: (connected: boolean) => void;
}): NotifyClient {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const schedule = () => {
    if (!closed) retry = setTimeout(connect, reconnectDelay(attempt++));
  };

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/notify?app=${opts.app}`);
    ws.onopen = () => {
      attempt = 0;
      opts.onStatus?.(true);
      ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), PING_MS);
    };
    ws.onmessage = (e) => {
      const m = parseSocketMessage(e.data);
      if (m) opts.onMessage(m);
    };
    ws.onclose = (e) => {
      clearInterval(ping);
      opts.onStatus?.(false);
      if (closed) return;
      if (e.code === 4401) void refreshSession().then((ok) => (ok ? schedule() : undefined));
      else schedule();
    };
  }

  connect();
  return {
    close() {
      closed = true;
      clearTimeout(retry);
      clearInterval(ping);
      ws?.close();
    },
  };
}

/* ---------------- 桌面通知(L1:Notification API) ---------------- */

export type DesktopPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export const desktopPermission = (): DesktopPermission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** 要求桌面通知權限;瀏覽器規定須由使用者點擊觸發。拒絕後網站無法再詢問,只能由使用者在瀏覽器設定改回 */
export async function enableDesktopNotify(): Promise<DesktopPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

/* ---------------- 收件匣狀態(每個應用一份) ---------------- */

export type ArriveMessage = Extract<NotifySocketMessage, { type: 'announcement' | 'notification' }>;

export interface NotifyCenter {
  readonly state: {
    readonly items: readonly FeedItem[];
    readonly unread: number;
    readonly loading: boolean;
    readonly connected: boolean;
    readonly error: string | null;
  };
  items: Readonly<{ value: readonly FeedItem[] }>;
  unread: Readonly<{ value: number }>;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  markRead(item: Pick<FeedItem, 'kind' | 'id'>): Promise<void>;
  ack(id: number): Promise<void>;
  markAllRead(): Promise<void>;
  /** 新公告 / 個人通知(Toast、對話框);回傳取消訂閱 */
  onArrive(fn: (m: ArriveMessage, how: ReturnType<typeof presentationOf>) => void): () => void;
  /** 撤回(對話框若正顯示該公告應關閉) */
  onRevoked(fn: (announcementId: number) => void): () => void;
  /** 點擊桌面通知時(預設只把視窗帶到前景) */
  setDesktopClickHandler(fn: ((m: ArriveMessage) => void) | null): void;
}

const centers = new Map<NotifyApp, NotifyCenter>();

function createCenter(app: NotifyApp): NotifyCenter {
  const state = reactive({
    items: [] as FeedItem[],
    unread: 0,
    loading: false,
    connected: false,
    error: null as string | null,
  });
  const arrive = new Set<(m: ArriveMessage, how: ReturnType<typeof presentationOf>) => void>();
  const revoked = new Set<(id: number) => void>();
  let client: NotifyClient | null = null;
  let clickHandler: ((m: ArriveMessage) => void) | null = null;
  let pending: Promise<void> | null = null;

  const refresh = () =>
    (pending ??= notifyApi
      .feed(app, { pageSize: 20 })
      .then((f) => {
        state.items = f.items;
        state.unread = f.unread;
        state.error = null;
      })
      .catch((e: unknown) => void (state.error = (e as Error)?.message ?? String(e)))
      .finally(() => {
        state.loading = false;
        pending = null;
      }));

  const desktop = (m: ArriveMessage) => {
    try {
      const title = m.title;
      const body = m.type === 'announcement' ? m.summary : m.body;
      const n = new Notification(title, {
        body,
        tag: m.type === 'announcement' ? `ann-${m.announcementId}` : `msg-${m.messageId}`,
      });
      n.onclick = () => {
        window.focus();
        clickHandler?.(m);
        n.close();
      };
    } catch {
      // 部分瀏覽器(行動版)只允許經 Service Worker 顯示
    }
  };

  const onMessage = (m: NotifySocketMessage) => {
    if (m.type === 'hello') {
      // (重)連上:補查斷線期間的通知
      void refresh();
      return;
    }
    if (m.type === 'revoked') {
      state.items = removeAnnouncement(state.items, m.announcementId);
      revoked.forEach((fn) => fn(m.announcementId));
      void refresh();
      return;
    }
    if (m.type === 'announcement' || m.type === 'notification') {
      const how = presentationOf(m.type === 'announcement' ? m : { level: 'info' }, {
        hidden: typeof document !== 'undefined' && document.hidden,
        permission: desktopPermission(),
      });
      if (how.desktop) desktop(m);
      arrive.forEach((fn) => fn(m, how));
      void refresh();
    }
  };

  const findItem = (kind: FeedItem['kind'], id: number) => state.items.find((i) => i.kind === kind && i.id === id);

  return {
    state: readonly(state),
    items: computed(() => state.items),
    unread: computed(() => state.unread),
    start() {
      if (client) return;
      state.loading = true;
      void refresh();
      client = createNotifyClient({
        app,
        onMessage,
        onStatus: (c) => (state.connected = c),
      });
    },
    stop() {
      client?.close();
      client = null;
    },
    refresh,
    async markRead(item) {
      const cur = findItem(item.kind, item.id);
      if (item.kind === 'announcement') await notifyApi.read(item.id, app);
      else await notifyApi.readMessage(item.id);
      if (cur && !cur.isRead) {
        cur.isRead = true;
        state.unread = Math.max(0, state.unread - 1);
      }
    },
    async ack(id) {
      const r = await notifyApi.ack(id, app);
      const cur = findItem('announcement', id);
      if (cur) {
        if (!cur.isRead) state.unread = Math.max(0, state.unread - 1);
        cur.isRead = true;
        cur.ackAt = r.ackAt;
      }
    },
    async markAllRead() {
      const unread = state.items.filter((i) => i.kind === 'announcement' && !i.isRead && !i.requireAck);
      await Promise.all([...unread.map((i) => notifyApi.read(i.id, app)), notifyApi.readAllMessages()]);
      await refresh();
    },
    onArrive(fn) {
      arrive.add(fn);
      return () => arrive.delete(fn);
    },
    onRevoked(fn) {
      revoked.add(fn);
      return () => revoked.delete(fn);
    },
    setDesktopClickHandler(fn) {
      clickHandler = fn;
    },
  };
}

/** 同一應用共用一份收件匣狀態;第一次呼叫建立,start() 後才連線 */
export function useNotifyCenter(app: NotifyApp): NotifyCenter {
  let c = centers.get(app);
  if (!c) centers.set(app, (c = createCenter(app)));
  return c;
}

/* ---------------- 公告查詢 ---------------- */

export function useAnnouncementArchive() {
  const state = reactive({
    q: '',
    from: '',
    to: '',
    level: '',
    page: 1,
    pageSize: 20,
    total: 0,
    items: [] as FeedItem[],
    loading: false,
    error: null as string | null,
  });
  async function search(page = 1) {
    state.loading = true;
    state.page = page;
    try {
      const r = await notifyApi.archive({
        q: state.q.trim() || undefined,
        from: state.from ? new Date(state.from).toISOString() : undefined,
        to: state.to ? new Date(state.to).toISOString() : undefined,
        level: state.level || undefined,
        page,
        pageSize: state.pageSize,
      });
      state.items = r.items;
      state.total = r.total;
      state.error = null;
    } catch (e) {
      state.error = (e as Error)?.message ?? String(e);
    } finally {
      state.loading = false;
    }
  }
  return { state, search };
}

/* ---------------- HTML 清洗(顯示前第二道) ---------------- */

const TAGS = new Set(ALLOWED_TAGS);
const ATTRS = new Set(ALLOWED_ATTR);
const DROP = new Set(DROP_WITH_CONTENT);

function clean(node: Node): void {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    clean(el);
    if (!TAGS.has(tag)) {
      // 不在白名單但無害的標籤(例 div、font):保留文字內容,去掉標籤
      el.replaceWith(...el.childNodes);
      continue;
    }
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase();
      if (!ATTRS.has(name)) el.removeAttribute(a.name);
      else if (name === 'href' && !isAllowedHref(a.value)) el.removeAttribute(a.name);
      else if (name === 'src' && !isAllowedImageSrc(a.value)) el.removeAttribute(a.name);
      else if (name === 'style') {
        const v = filterStyle(a.value);
        if (v) el.setAttribute('style', v);
        else el.removeAttribute('style');
      }
    }
    if (tag === 'img' && !el.hasAttribute('src')) el.remove();
    if (tag === 'a') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

/**
 * 公告 HTML 顯示前清洗(白名單與 BFF 相同);以 v-html 顯示時一律先經過此函式,外層加 class gn-notify-content。
 * DOMParser 產生的是不執行腳本、不載入資源的文件,在其中移除不允許的節點與屬性後再序列化。
 */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  clean(doc.body);
  return doc.body.innerHTML;
}
