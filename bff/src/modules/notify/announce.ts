/**
 * 公告服務(NOTIFY-PLAN §6.1–§6.4):對象展開、公告索引(收件匣 / 公告查詢)、已讀回條。
 *
 *   - 對象展開:gw.user(人員同步每小時寫入全體在職員工;排除停用、兼任虛擬帳號、離職)+ gw.user_company,於記憶體比對(audience.ts)。
 *   - 公告索引:已發布公告的輕量欄位(不含內文),每實例快取 30 秒;收到 gw:notify:broadcast 時立即失效,
 *     讓前端收到 WebSocket 後打 /api/notify/feed 一定看得到新公告。
 *   - 寫入(發布、撤回)由 routes 處理;分送由 worker(workers/announce.worker.ts)。
 */
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { GwDatabase } from '../../db/client.js';
import { company, notifyAnnouncement, notifyReceipt, user, userCompany } from '../../db/schema/index.js';
import { parseGroups, loadDeptTree } from '../rbac/permission.js';
import type { DeptTree } from '../rbac/rules.js';
import { matchAudience, parseAudience, type Audience, type AudienceFacts } from './audience.js';

/** 管道:portal / itapp = 站內(WebSocket + 收件匣);agent = 端點托盤(N4);email = 逐人寄 */
export const ANNOUNCE_CHANNELS = ['portal', 'itapp', 'agent', 'email'] as const;
export type AnnounceChannel = (typeof ANNOUNCE_CHANNELS)[number];
/** 目前已上線的管道(agent 於 N4 ItAgentBack 接收後開放) */
export const AVAILABLE_CHANNELS: readonly AnnounceChannel[] = ['portal', 'itapp', 'email'];
export const CHANNEL_NAMES: Record<AnnounceChannel, string> = { portal: '員工入口網', itapp: 'GigaItApp', agent: '端點 Agent(托盤)', email: 'Email' };
export const LEVELS = ['info', 'important', 'urgent'] as const;
export type Level = (typeof LEVELS)[number];
/** 收件匣的應用代碼(/ws/notify?app=、/api/notify/feed?app=) */
export const INBOX_APPS = ['portal', 'itapp'] as const;
export type InboxApp = (typeof INBOX_APPS)[number];
export const inboxAppOf = (v: unknown): InboxApp => (v === 'itapp' ? 'itapp' : 'portal');

export const BROADCAST_CHANNEL = 'gw:notify:broadcast';

export function parseChannelList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 對象展開的一個人 */
export interface Person extends AudienceFacts {
  userId: number;
  displayName: string;
  email: string | null;
  deptCode: string | null;
  department: string | null;
}

/** 公告索引的一筆(不含內文) */
export interface IndexEntry {
  id: number;
  title: string;
  summary: string;
  level: string;
  requireAck: boolean;
  publisherTitle: string | null;
  linkUrl: string | null;
  publishAt: Date;
  expireAt: Date | null;
  audience: Audience;
  channels: string[];
  createdBy: string;
}

const POPULATION_TTL_MS = 60_000;
const TREE_TTL_MS = 10 * 60_000;
const INDEX_TTL_MS = 30_000;
const CHUNK = 1000;

/** 小型快取:過期或失效時重新載入,同時間只載入一次 */
class Cached<T> {
  private value: { at: number; p: Promise<T> } | null = null;
  constructor(
    private readonly ttlMs: number,
    private readonly load: () => Promise<T>,
  ) {}
  get(): Promise<T> {
    if (!this.value || Date.now() - this.value.at >= this.ttlMs) {
      const p = this.load();
      this.value = { at: Date.now(), p };
      p.catch(() => (this.value = null));
    }
    return this.value.p;
  }
  invalidate() {
    this.value = null;
  }
}

/**
 * 在職人員(公告對象的母體)。loginCompanies(LOGIN_COMPANIES 分階段開放)不為空時,只留所屬公司已開放的人:
 * 未開放公司的人無法登入,全公司公告與 Email 都不發給他們(與 auth companyOpen 相同以公司名稱比對)。
 */
export async function loadPopulation(db: GwDatabase, loginCompanies: string[] = []): Promise<Person[]> {
  const users = await db
    .select({
      userId: user.userId,
      employeeNo: user.employeeNo,
      displayName: user.displayName,
      email: user.email,
      deptCode: user.deptCode,
      department: user.department,
      adGroups: user.adGroups,
      jobLevel: user.jobLevel,
    })
    .from(user)
    .where(and(eq(user.isDisabled, false), eq(user.isVirtual, false), or(isNull(user.employmentStatus), ne(user.employmentStatus, 'resigned'))));
  const memberships = await db
    .select({ userId: userCompany.userId, companyId: userCompany.companyId, deptCode: userCompany.deptCode, compName: company.compName })
    .from(userCompany)
    .innerJoin(company, eq(company.companyId, userCompany.companyId))
    .where(eq(company.isEnabled, true));
  const byUser = new Map<number, { companyId: number | null; deptCode: string | null }[]>();
  for (const m of memberships) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), { companyId: m.companyId, deptCode: m.deptCode }]);
  const openUsers = loginCompanies.length ? new Set(memberships.filter((m) => loginCompanies.includes(m.compName)).map((m) => m.userId)) : null;
  return users
    .filter((u) => !openUsers || openUsers.has(u.userId))
    .map((u) => ({
      userId: u.userId,
      employeeNo: u.employeeNo,
      displayName: u.displayName,
      email: u.email?.trim() || null,
      deptCode: u.deptCode,
      department: u.department,
      adGroups: parseGroups(u.adGroups),
      // 與 rbac/permission.ts loadUserFacts 相同:沒有所屬公司資料時以 gw.user.dept_code 比對
      memberships: byUser.get(u.userId) ?? [{ companyId: null, deptCode: u.deptCode }],
      jobLevel: u.jobLevel,
    }));
}

export class AnnouncementDirectory {
  private readonly population: Cached<Person[]>;
  private readonly tree: Cached<DeptTree>;
  private readonly index: Cached<IndexEntry[]>;

  /** loginCompanies:分階段開放的公司名稱(config.loginCompanies),空陣列 = 不限 */
  constructor(
    private readonly db: GwDatabase,
    loginCompanies: string[] = [],
  ) {
    this.population = new Cached(POPULATION_TTL_MS, () => loadPopulation(db, loginCompanies));
    this.tree = new Cached(TREE_TTL_MS, () => loadDeptTree(db));
    this.index = new Cached(INDEX_TTL_MS, () => this.loadIndex());
  }

  deptTree(): Promise<DeptTree> {
    return this.tree.get();
  }

  /** 公告發布 / 撤回後呼叫(本實例);其他實例由 gw:notify:broadcast 觸發 */
  invalidateIndex() {
    this.index.invalidate();
  }

  /** 對象展開為在職人員 */
  async expand(audience: Audience): Promise<Person[]> {
    const [people, tree] = await Promise.all([this.population.get(), this.tree.get()]);
    return people.filter((p) => matchAudience(audience, p, tree));
  }

  async matches(audience: Audience, facts: AudienceFacts): Promise<boolean> {
    return matchAudience(audience, facts, await this.tree.get());
  }

  /** 已發布(不含排程中、撤回)的公告,新到舊 */
  async published(): Promise<IndexEntry[]> {
    return this.index.get();
  }

  /** 使用者在對象內的已發布公告;app 指定時只留含此應用管道的公告 */
  async visibleTo(facts: AudienceFacts, opts: { app?: InboxApp; includeExpired: boolean; now?: Date }): Promise<IndexEntry[]> {
    const now = opts.now ?? new Date();
    const [list, tree] = await Promise.all([this.index.get(), this.tree.get()]);
    return list.filter(
      (e) =>
        e.publishAt <= now &&
        (opts.includeExpired || !e.expireAt || e.expireAt > now) &&
        (!opts.app || e.channels.includes(opts.app)) &&
        matchAudience(e.audience, facts, tree),
    );
  }

  private async loadIndex(): Promise<IndexEntry[]> {
    const rows = await this.db
      .select({
        id: notifyAnnouncement.announcementId,
        title: notifyAnnouncement.title,
        summary: sql<string>`LEFT(${notifyAnnouncement.bodyText}, 200)`,
        level: notifyAnnouncement.level,
        requireAck: notifyAnnouncement.requireAck,
        publisherTitle: notifyAnnouncement.publisherTitle,
        linkUrl: notifyAnnouncement.linkUrl,
        publishAt: notifyAnnouncement.publishAt,
        expireAt: notifyAnnouncement.expireAt,
        audience: notifyAnnouncement.audience,
        channels: notifyAnnouncement.channels,
        createdBy: notifyAnnouncement.createdBy,
      })
      .from(notifyAnnouncement)
      .where(eq(notifyAnnouncement.status, 'published'));
    return rows
      .filter((r) => r.publishAt)
      .map((r) => ({ ...r, publishAt: r.publishAt!, audience: parseAudience(r.audience), channels: parseChannelList(r.channels) }))
      .sort((a, b) => b.publishAt.getTime() - a.publishAt.getTime() || b.id - a.id);
  }
}

/** 使用者的已讀回條(announcementId → 狀態) */
export async function receiptsOf(db: GwDatabase, userId: number): Promise<Map<number, { readAt: Date | null; ackAt: Date | null }>> {
  const rows = await db
    .select({ id: notifyReceipt.announcementId, readAt: notifyReceipt.readAt, ackAt: notifyReceipt.ackAt })
    .from(notifyReceipt)
    .where(eq(notifyReceipt.userId, userId));
  return new Map(rows.map((r) => [r.id, { readAt: r.readAt, ackAt: r.ackAt }]));
}

/** 公告的已讀回條(全部;對象人數上限約數千,一次載入) */
export async function receiptsFor(db: GwDatabase, announcementId: number) {
  return db
    .select({
      userId: notifyReceipt.userId,
      seenVia: notifyReceipt.seenVia,
      firstSeenAt: notifyReceipt.firstSeenAt,
      readAt: notifyReceipt.readAt,
      ackAt: notifyReceipt.ackAt,
    })
    .from(notifyReceipt)
    .where(eq(notifyReceipt.announcementId, announcementId));
}

/** 多則公告的已讀 / 已確認數(發布紀錄清單) */
export async function readCounts(db: GwDatabase, ids: number[]): Promise<Map<number, { read: number; ack: number }>> {
  const out = new Map<number, { read: number; ack: number }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select({
        id: notifyReceipt.announcementId,
        read: sql<number>`SUM(CASE WHEN ${notifyReceipt.readAt} IS NULL THEN 0 ELSE 1 END)`,
        ack: sql<number>`SUM(CASE WHEN ${notifyReceipt.ackAt} IS NULL THEN 0 ELSE 1 END)`,
      })
      .from(notifyReceipt)
      .where(inArray(notifyReceipt.announcementId, ids.slice(i, i + CHUNK)))
      .groupBy(notifyReceipt.announcementId);
    for (const r of rows) out.set(r.id, { read: Number(r.read), ack: Number(r.ack) });
  }
  return out;
}

/** SQL Server 主鍵 / 唯一鍵重複(2627 / 2601):併發寫入同一筆回條 */
const isDuplicateKey = (err: unknown) => {
  const n = (err as { number?: number; originalError?: { info?: { number?: number } }; cause?: { number?: number } }) ?? {};
  return [n.number, n.originalError?.info?.number, n.cause?.number].some((x) => x === 2627 || x === 2601);
};

/** 標記已讀(ack = true 時一併確認已閱讀);已有的時間不覆寫 */
export async function markRead(
  db: GwDatabase,
  announcementId: number,
  userId: number,
  via: string,
  ack: boolean,
): Promise<{ readAt: Date; ackAt: Date | null }> {
  const where = and(eq(notifyReceipt.announcementId, announcementId), eq(notifyReceipt.userId, userId));
  const [cur] = await db.select({ readAt: notifyReceipt.readAt, ackAt: notifyReceipt.ackAt }).from(notifyReceipt).where(where);
  const now = new Date();
  if (!cur) {
    try {
      await db.insert(notifyReceipt).values({ announcementId, userId, seenVia: via.slice(0, 10), readAt: now, ackAt: ack ? now : null });
      return { readAt: now, ackAt: ack ? now : null };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }
  const set: Partial<typeof notifyReceipt.$inferInsert> = {};
  if (!cur?.readAt) set.readAt = now;
  if (ack && !cur?.ackAt) set.ackAt = now;
  if (Object.keys(set).length) await db.update(notifyReceipt).set(set).where(where);
  const [after] = await db.select({ readAt: notifyReceipt.readAt, ackAt: notifyReceipt.ackAt }).from(notifyReceipt).where(where);
  return { readAt: after?.readAt ?? now, ackAt: after?.ackAt ?? null };
}
