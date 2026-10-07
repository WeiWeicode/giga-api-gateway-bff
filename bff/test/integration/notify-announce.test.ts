/**
 * 公告(NOTIFY-PLAN §6、W10-2)× SQL Server:對象展開、公告索引、已讀回條、分送 worker、保留期限、公告 Email。
 * 所有 SQL 經 2012 語法檢查(guard = error)。Redis 推播與 BullMQ 佇列以替身取代(不連 Redis)。
 */
import { eq, inArray } from 'drizzle-orm';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  department,
  notifyAnnouncement,
  notifyAnnouncementAsset,
  notifyLog,
  notifyReceipt,
  notifySetting,
  user,
  userCompany,
} from '../../src/db/schema/index.js';
import { AnnouncementDirectory, BROADCAST_CHANNEL, loadPopulation, markRead, readCounts, receiptsOf } from '../../src/modules/notify/announce.js';
import { SettingsStore } from '../../src/modules/notify/settings.js';
import type { NotifyFanoutJob, NotifyJob } from '../../src/plugins/queues.js';
import { createAnnounceProcessor } from '../../src/workers/announce.worker.js';
import { createAnnouncementMailer } from '../../src/workers/notify.worker.js';
import { openTestDb, type TestDb } from './helpers.js';

let t: TestDb;
const actor = { createdBy: 'it-announce', updatedBy: 'it-announce' };
const log = pino({ level: 'silent' });
const tag = Date.now().toString(36).slice(-4).toUpperCase();
// 本測試專用的部門樹:ROOT → MID → LEAF;OTHER 與 ROOT 平行
const D = { root: `A${tag}0`, mid: `A${tag}1`, leaf: `A${tag}2`, other: `A${tag}9` };
const users: Record<string, number> = {};

async function addUser(
  key: string,
  o: { dept: string; jobLevel?: string | null; email?: string | null; disabled?: boolean; virtual?: boolean; resigned?: boolean },
) {
  const emp = `Z${tag}${key}`.slice(0, 20);
  const [u] = await t.db
    .insert(user)
    .output({ id: user.userId })
    .values({
      employeeNo: emp,
      displayName: `測試${key}`,
      profileSource: 'ad_only',
      deptCode: o.dept,
      department: o.dept,
      jobLevel: o.jobLevel ?? '8',
      email: o.email === undefined ? `${emp.toLowerCase()}@example.test` : o.email,
      isDisabled: o.disabled ?? false,
      isVirtual: o.virtual ?? false,
      employmentStatus: o.resigned ? 'resigned' : 'active',
      ...actor,
    });
  users[key] = u!.id;
  return u!.id;
}

async function addAnnouncement(o: Omit<Partial<typeof notifyAnnouncement.$inferInsert>, 'audience' | 'channels'> & { audience: object; channels?: string[] }) {
  const [a] = await t.db
    .insert(notifyAnnouncement)
    .output({ id: notifyAnnouncement.announcementId })
    .values({
      title: '全體員工特休',
      bodyHtml: '<p>10/10 全體特休</p>',
      bodyText: '10/10 全體特休',
      level: 'important',
      status: 'published',
      publishAt: new Date(Date.now() - 60_000),
      ...o,
      audience: JSON.stringify(o.audience),
      channels: JSON.stringify(o.channels ?? ['itapp', 'email']),
      ...actor,
    });
  return a!.id;
}

const ourIds = (list: { userId: number }[]) =>
  list
    .map((p) => p.userId)
    .filter((id) => Object.values(users).includes(id))
    .sort((a, b) => a - b);
const ids = (...keys: string[]) => keys.map((k) => users[k]!).sort((a, b) => a - b);

beforeAll(async () => {
  t = await openTestDb();
  const syncedAt = new Date();
  await t.db.insert(department).values([
    { deptCode: D.root, name: '測試總部', parentDeptCode: null, syncedAt },
    { deptCode: D.mid, name: '測試處', parentDeptCode: D.root, syncedAt },
    { deptCode: D.leaf, name: '測試課', parentDeptCode: D.mid, syncedAt },
    { deptCode: D.other, name: '其他部門', parentDeptCode: null, syncedAt },
  ]);
  await addUser('MGR', { dept: D.mid, jobLevel: '5' });
  await addUser('STAFF', { dept: D.leaf, jobLevel: '8' });
  await addUser('NOMAIL', { dept: D.leaf, jobLevel: '9', email: null });
  await addUser('OTHER', { dept: D.other, jobLevel: '4' });
  await addUser('OFF', { dept: D.leaf, disabled: true });
  await addUser('VIRT', { dept: D.leaf, virtual: true });
  await addUser('LEFT', { dept: D.leaf, resigned: true });
  // 兼任:主要在 OTHER,另在 LEAF
  const r = await t.pool.request().query<{ id: number }>("SELECT TOP 1 company_id AS id FROM gw.company WHERE comp_name = N'碩禾'");
  const companyId = r.recordset[0]!.id;
  await t.db.insert(userCompany).values([
    { userId: users.OTHER!, companyId, viaEmployeeNo: `Z${tag}OTHER`, deptCode: D.other, isPrimary: true },
    { userId: users.OTHER!, companyId, viaEmployeeNo: `Z${tag}OTHER2`, deptCode: D.leaf, isVirtual: true },
  ]);
});

afterAll(async () => {
  await t?.close();
});

describe('對象展開(gw.user + user_company + 部門樹)', () => {
  it('排除停用、兼任虛擬帳號、離職;沒有所屬公司資料時以 gw.user.dept_code 比對', async () => {
    const people = await loadPopulation(t.db);
    expect(ourIds(people)).toEqual(ids('MGR', 'STAFF', 'NOMAIL', 'OTHER'));
    const other = people.find((p) => p.userId === users.OTHER)!;
    expect(other.memberships.map((m) => m.deptCode).sort()).toEqual([D.leaf, D.other].sort());
    expect(people.find((p) => p.userId === users.STAFF)!.memberships).toEqual([{ companyId: null, deptCode: D.leaf }]);
  });

  it('部門含下層、職級門檻、兼任', async () => {
    const dir = new AnnouncementDirectory(t.db);
    expect(ourIds(await dir.expand({ depts: [{ code: D.root, sub: true }] }))).toEqual(ids('MGR', 'STAFF', 'NOMAIL', 'OTHER'));
    expect(ourIds(await dir.expand({ depts: [{ code: D.mid, sub: false }] }))).toEqual(ids('MGR'));
    expect(ourIds(await dir.expand({ depts: [{ code: D.root, sub: true }], jobTier: 'manager' }))).toEqual(ids('MGR', 'OTHER'));
    expect(ourIds(await dir.expand({ users: [`Z${tag}NOMAIL`] }))).toEqual(ids('NOMAIL'));
  });
});

describe('公告索引與已讀回條', () => {
  let visible: number;
  let expired: number;
  let otherApp: number;
  let hidden: number[];

  beforeAll(async () => {
    visible = await addAnnouncement({ audience: { depts: [{ code: D.leaf, sub: true }] } });
    expired = await addAnnouncement({ audience: { depts: [{ code: D.leaf, sub: true }] }, expireAt: new Date(Date.now() - 1000) });
    otherApp = await addAnnouncement({ audience: { depts: [{ code: D.leaf, sub: true }] }, channels: ['portal'] });
    hidden = [
      await addAnnouncement({ audience: { depts: [{ code: D.leaf, sub: true }] }, status: 'revoked' }),
      await addAnnouncement({ audience: { depts: [{ code: D.leaf, sub: true }] }, status: 'scheduled', publishAt: new Date(Date.now() + 3600_000) }),
      await addAnnouncement({ audience: { depts: [{ code: D.other, sub: false }] } }),
    ];
  });

  it('收件匣只含已發布、未到期、管道含此應用且在對象內的公告;公告查詢含已到期', async () => {
    const dir = new AnnouncementDirectory(t.db);
    const staff = (await loadPopulation(t.db)).find((p) => p.userId === users.STAFF)!;
    const inbox = (await dir.visibleTo(staff, { app: 'itapp', includeExpired: false })).map((e) => e.id);
    expect(inbox).toContain(visible);
    expect(inbox).not.toContain(expired);
    expect(inbox).not.toContain(otherApp);
    const archive = (await dir.visibleTo(staff, { includeExpired: true })).map((e) => e.id);
    expect(archive).toEqual(expect.arrayContaining([visible, expired, otherApp]));
    // 撤回、排程中、其他部門的公告都不在
    for (const id of hidden) expect(archive).not.toContain(id);
    const entry = (await dir.published()).find((e) => e.id === visible)!;
    expect(entry.summary).toBe('10/10 全體特休');
  });

  it('同時標記已讀只寫一筆;確認已閱讀不覆寫已讀時間', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => markRead(t.db, visible, users.STAFF!, 'itapp', false)));
    const readAt = results[0]!.readAt.getTime();
    const ack = await markRead(t.db, visible, users.STAFF!, 'itapp', true);
    expect(ack.ackAt).toBeInstanceOf(Date);
    expect(ack.readAt.getTime()).toBeLessThanOrEqual(readAt + 1000);
    const rows = await t.db.select().from(notifyReceipt).where(eq(notifyReceipt.announcementId, visible));
    expect(rows).toHaveLength(1);
    expect((await readCounts(t.db, [visible, expired])).get(visible)).toEqual({ read: 1, ack: 1 });
    expect((await receiptsOf(t.db, users.STAFF!)).get(visible)?.ackAt).toBeInstanceOf(Date);
  });
});

describe('分送 worker', () => {
  const fakes = () => {
    const pub = { publish: vi.fn().mockResolvedValue(1) };
    const notifyQueue = { addBulk: vi.fn().mockResolvedValue([]) };
    const settings = new SettingsStore(t.db);
    const run = createAnnounceProcessor({ db: t.db, pub: pub as unknown as Redis, notifyQueue: notifyQueue as unknown as Queue<NotifyJob>, settings, log });
    const job = (data: NotifyFanoutJob) => run({ data } as Job<NotifyFanoutJob>);
    return { pub, notifyQueue, settings, job };
  };

  it('排程到期改為已發布、廣播一則、Email 逐人入列(沒有 Email 記為 skipped);重試不重複寄', async () => {
    const id = await addAnnouncement({ audience: { depts: [{ code: D.mid, sub: true }] }, status: 'scheduled', publishAt: new Date() });
    const f = fakes();
    await f.job({ kind: 'publish', announcementId: id, requestedBy: 'S112009' });

    const [a] = await t.db.select({ status: notifyAnnouncement.status }).from(notifyAnnouncement).where(eq(notifyAnnouncement.announcementId, id));
    expect(a!.status).toBe('published');
    expect(f.pub.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = f.pub.publish.mock.calls[0]!;
    expect(channel).toBe(BROADCAST_CHANNEL);
    expect(JSON.parse(raw as string)).toMatchObject({
      type: 'announcement',
      announcementId: id,
      channels: ['itapp', 'email'],
      audience: { depts: [{ code: D.mid, sub: true }] },
    });

    const logs = await t.db.select().from(notifyLog).where(eq(notifyLog.announcementId, id));
    // MGR、STAFF、NOMAIL、OTHER(兼任 LEAF)
    expect(logs).toHaveLength(4);
    expect(logs.filter((l) => l.status === 'skipped').map((l) => l.recipientUserId)).toEqual([users.NOMAIL]);
    const jobs = f.notifyQueue.addBulk.mock.calls.flatMap((c) => c[0] as { data: NotifyJob }[]);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.data.announcementId === id && j.data.templateCode === 'ANNOUNCEMENT' && j.data.address)).toBe(true);

    await f.job({ kind: 'publish', announcementId: id, requestedBy: 'S112009' });
    expect(await t.db.select().from(notifyLog).where(eq(notifyLog.announcementId, id))).toHaveLength(4);
  });

  it('提醒只寄給未讀者;撤回廣播 revoked;草稿與撤回的公告不發布', async () => {
    const id = await addAnnouncement({ audience: { depts: [{ code: D.leaf, sub: false }] } });
    await markRead(t.db, id, users.STAFF!, 'itapp', false);
    const f = fakes();
    await f.job({ kind: 'remind', announcementId: id, requestedBy: 'S112009' });
    const logs = await t.db.select().from(notifyLog).where(eq(notifyLog.announcementId, id));
    expect(logs.map((l) => l.recipientUserId).sort()).toEqual(ids('NOMAIL', 'OTHER'));

    await f.job({ kind: 'revoke', announcementId: id });
    expect(JSON.parse(f.pub.publish.mock.calls.at(-1)![1] as string)).toEqual({ type: 'revoked', announcementId: id });

    const draft = await addAnnouncement({ audience: { all: true }, status: 'draft', publishAt: null });
    const before = f.pub.publish.mock.calls.length;
    await f.job({ kind: 'publish', announcementId: draft });
    expect(f.pub.publish.mock.calls.length).toBe(before);
  });

  it('保留期限:預設永久不刪;設定 1 年後刪除超過期限的公告與其回條、圖片;清除 7 天前未綁定的草稿圖片', async () => {
    const old = await addAnnouncement({ audience: { all: true }, publishAt: new Date(Date.now() - 2 * 365 * 24 * 3600_000) });
    await markRead(t.db, old, users.STAFF!, 'itapp', false);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const [asset] = await t.db
      .insert(notifyAnnouncementAsset)
      .output({ id: notifyAnnouncementAsset.assetId })
      .values({ announcementId: old, contentType: 'image/png', sizeBytes: png.length, data: png, createdBy: 'it-announce' });
    const [orphan] = await t.db
      .insert(notifyAnnouncementAsset)
      .output({ id: notifyAnnouncementAsset.assetId })
      .values({ contentType: 'image/png', sizeBytes: png.length, data: png, createdBy: 'it-announce', createdAt: new Date(Date.now() - 8 * 24 * 3600_000) });

    // 其他測試可能留下設定(例 HTTP 測試把保留期限設回永久 = null):先清除,回到預設
    await t.db.delete(notifySetting).where(inArray(notifySetting.settingKey, ['retentionYears']));
    const f = fakes();
    await f.job({ kind: 'retention' });
    expect(await t.db.select().from(notifyAnnouncement).where(eq(notifyAnnouncement.announcementId, old))).toHaveLength(1);
    expect(await t.db.select().from(notifyAnnouncementAsset).where(eq(notifyAnnouncementAsset.assetId, orphan!.id))).toHaveLength(0);

    await t.db.insert(notifySetting).values({ settingKey: 'retentionYears', settingValue: '1', ...actor });
    try {
      await fakes().job({ kind: 'retention' });
      expect(await t.db.select().from(notifyAnnouncement).where(eq(notifyAnnouncement.announcementId, old))).toHaveLength(0);
      expect(await t.db.select().from(notifyReceipt).where(eq(notifyReceipt.announcementId, old))).toHaveLength(0);
      expect(await t.db.select().from(notifyAnnouncementAsset).where(eq(notifyAnnouncementAsset.assetId, asset!.id))).toHaveLength(0);
    } finally {
      await t.db.delete(notifySetting).where(inArray(notifySetting.settingKey, ['retentionYears']));
    }
  });
});

describe('公告 Email 內容', () => {
  it('主旨加等級前綴、圖片改 CID 內嵌、表格加框線、附平台連結;撤回後回傳狀態', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const [asset] = await t.db
      .insert(notifyAnnouncementAsset)
      .output({ id: notifyAnnouncementAsset.assetId })
      .values({ contentType: 'image/png', fileName: 'a.png', sizeBytes: png.length, data: png, createdBy: 'it-announce' });
    const id = await addAnnouncement({
      audience: { all: true },
      level: 'urgent',
      publisherTitle: '總經理室',
      requireAck: true,
      bodyHtml: `<p>特休 <img src="/api/notify/assets/${asset!.id}" /></p><table><tbody><tr><td>10/10</td></tr></tbody></table>`,
    });
    const mail = createAnnouncementMailer(t.db, new SettingsStore(t.db), 'https://giganexus-test.gigasolar.com.tw/');
    const m = (await mail(id))!;
    expect(m.subject).toBe('【緊急】全體員工特休');
    expect(m.html).toContain(`src="cid:asset-${asset!.id}@giganexus"`);
    expect(m.html).toContain('<table border="1" cellpadding="6" cellspacing="0">');
    expect(m.html).toContain(`https://giganexus-test.gigasolar.com.tw/it/notify/archive?id=${id}`);
    expect(m.html).toContain('總經理室');
    expect(m.html).toContain('確認已閱讀');
    expect(m.attachments).toEqual([{ filename: 'a.png', content: png, contentType: 'image/png', cid: `asset-${asset!.id}@giganexus` }]);
  });
});
