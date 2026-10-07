/**
 * 公告分送(NOTIFY-PLAN §6.3):notify-fanout 佇列,一則公告一個工作。
 *
 *   publish    排程時間到(或立即):scheduled → published;廣播 gw:notify:broadcast(站內);Email 逐人寄
 *   revoke     廣播撤回,各端移除
 *   remind     對未讀者重寄 Email
 *   retention  每日:依設定的保留年數清除公告(預設永久,不清除);清除超過 7 天未綁定公告的草稿圖片
 *
 * Email:每位收件人一筆 gw.notify_log(announcement_id)+ 既有 notify 佇列的工作(templateCode = ANNOUNCEMENT),
 * 由 notify worker 寄出(沿用 MAIL_RATE_PER_SEC 限速、重試、死信告警)。同一公告的 publish 工作重試時不重複寄送。
 */
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { GwDatabase } from '../db/client.js';
import { notifyAnnouncement, notifyAnnouncementAsset, notifyLog, notifyReceipt } from '../db/schema/index.js';
import { AnnouncementDirectory, BROADCAST_CHANNEL, parseChannelList, receiptsFor, type Person } from '../modules/notify/announce.js';
import { parseAudience } from '../modules/notify/audience.js';
import { summaryOf } from '../modules/notify/html.js';
import { retentionCutoff, type SettingsStore } from '../modules/notify/settings.js';
import type { NotifyFanoutJob, NotifyJob } from '../plugins/queues.js';

export const ANNOUNCEMENT_TEMPLATE = 'ANNOUNCEMENT';
/** 每批寫入 notify_log 的筆數(每筆 7 個參數,SQL Server 上限 2100 個參數) */
const BATCH = 200;
const ORPHAN_ASSET_DAYS = 7;

export function createAnnounceProcessor(deps: { db: GwDatabase; pub: Redis; notifyQueue: Queue<NotifyJob>; settings: SettingsStore; log: Logger }) {
  const { db, pub, notifyQueue, settings, log } = deps;
  const dir = new AnnouncementDirectory(db);

  /** 逐人寄:寫 notify_log(沒有 Email 記為 skipped)→ 入列 notify;requestedBy 區分發布與提醒 */
  async function enqueueEmails(announcementId: number, people: Person[], requestedBy: string) {
    let queued = 0;
    let skipped = 0;
    for (let i = 0; i < people.length; i += BATCH) {
      const batch = people.slice(i, i + BATCH);
      const rows = await db
        .insert(notifyLog)
        .output({ logId: notifyLog.logId, userId: notifyLog.recipientUserId, status: notifyLog.status })
        .values(
          batch.map((x) => ({
            templateCode: ANNOUNCEMENT_TEMPLATE,
            channel: 'email',
            recipientUserId: x.userId,
            recipientAddress: x.email,
            status: x.email ? 'queued' : 'skipped',
            errorMessage: x.email ? null : `收件人沒有 Email:${x.employeeNo}`,
            requestedBy: requestedBy.slice(0, 64),
            announcementId,
          })),
        );
      const byUser = new Map(batch.map((x) => [x.userId, x]));
      const jobs = rows
        .filter((r) => r.status === 'queued')
        .map((r) => ({
          name: 'email',
          data: {
            logId: r.logId,
            channel: 'email',
            templateCode: ANNOUNCEMENT_TEMPLATE,
            userId: r.userId,
            address: byUser.get(r.userId!)?.email ?? null,
            data: {},
            announcementId,
          } satisfies NotifyJob,
          opts: {
            jobId: `nt-${r.logId}`,
            attempts: 6,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: 24 * 60 * 60 },
            removeOnFail: false,
          },
        }));
      if (jobs.length) await notifyQueue.addBulk(jobs);
      queued += jobs.length;
      skipped += rows.length - jobs.length;
    }
    return { queued, skipped };
  }

  async function publish(id: number, requestedBy: string) {
    const [a] = await db.select().from(notifyAnnouncement).where(eq(notifyAnnouncement.announcementId, id));
    if (!a) return log.warn({ announcementId: id }, '公告不存在,略過發布');
    if (a.status === 'scheduled') {
      await db
        .update(notifyAnnouncement)
        .set({ status: 'published', updatedBy: 'system:announce' })
        .where(and(eq(notifyAnnouncement.announcementId, id), eq(notifyAnnouncement.status, 'scheduled')));
    } else if (a.status !== 'published') return log.info({ announcementId: id, status: a.status }, '公告不是發布狀態,略過');

    const channels = parseChannelList(a.channels);
    const audience = parseAudience(a.audience);
    // 站內:一則廣播,各 BFF 實例比對連線的使用者
    await pub.publish(
      BROADCAST_CHANNEL,
      JSON.stringify({
        type: 'announcement',
        announcementId: id,
        title: a.title,
        summary: summaryOf(a.bodyText),
        level: a.level,
        requireAck: a.requireAck,
        publisherTitle: a.publisherTitle,
        linkUrl: a.linkUrl,
        publishedAt: a.publishAt ?? new Date(),
        audience,
        channels,
      }),
    );

    if (channels.includes('email')) {
      // 重試時不重複寄送:已有本公告的發布 Email 紀錄就略過
      const [sent] = await db
        .select({ id: notifyLog.logId })
        .top(1)
        .from(notifyLog)
        .where(and(eq(notifyLog.announcementId, id), eq(notifyLog.requestedBy, `announce:${requestedBy}`.slice(0, 64))));
      if (!sent) {
        const people = await dir.expand(audience);
        const r = await enqueueEmails(id, people, `announce:${requestedBy}`);
        log.info({ announcementId: id, ...r }, '公告 Email 已入列');
      }
    }
    log.info({ announcementId: id, channels }, '公告已發布');
  }

  async function remind(id: number, requestedBy: string) {
    const [a] = await db.select().from(notifyAnnouncement).where(eq(notifyAnnouncement.announcementId, id));
    if (!a || a.status !== 'published') return;
    const read = new Set((await receiptsFor(db, id)).filter((r) => r.readAt).map((r) => r.userId));
    const unread = (await dir.expand(parseAudience(a.audience))).filter((x) => !read.has(x.userId));
    const r = await enqueueEmails(id, unread, `remind:${requestedBy}`);
    log.info({ announcementId: id, ...r }, '公告提醒 Email 已入列');
  }

  async function retention() {
    const s = await settings.get();
    const orphanBefore = new Date(Date.now() - ORPHAN_ASSET_DAYS * 24 * 60 * 60 * 1000);
    await db.delete(notifyAnnouncementAsset).where(and(isNull(notifyAnnouncementAsset.announcementId), lt(notifyAnnouncementAsset.createdAt, orphanBefore)));
    if (s.retentionYears === null) return;
    const cutoff = retentionCutoff(s.retentionYears);
    const ids = (
      await db
        .select({ id: notifyAnnouncement.announcementId })
        .from(notifyAnnouncement)
        .where(and(or(eq(notifyAnnouncement.status, 'published'), eq(notifyAnnouncement.status, 'revoked')), lt(notifyAnnouncement.publishAt, cutoff)))
    ).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await db.transaction(async (tx) => {
        await tx.delete(notifyReceipt).where(inArray(notifyReceipt.announcementId, chunk));
        await tx.delete(notifyAnnouncementAsset).where(inArray(notifyAnnouncementAsset.announcementId, chunk));
        await tx.delete(notifyAnnouncement).where(inArray(notifyAnnouncement.announcementId, chunk));
      });
    }
    if (ids.length) log.info({ deleted: ids.length, retentionYears: s.retentionYears, cutoff }, '已依保留期限清除公告');
  }

  return async (job: Job<NotifyFanoutJob>) => {
    const { kind, announcementId, requestedBy = 'system' } = job.data;
    if (kind === 'retention') return retention();
    if (!announcementId) throw new Error(`${kind} 缺少 announcementId`);
    if (kind === 'publish') return publish(announcementId, requestedBy);
    if (kind === 'remind') return remind(announcementId, requestedBy);
    if (kind === 'revoke') {
      await pub.publish(BROADCAST_CHANNEL, JSON.stringify({ type: 'revoked', announcementId }));
      return;
    }
    throw new Error(`未知的工作:${kind as string}`);
  };
}
