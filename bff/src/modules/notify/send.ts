/**
 * 通知入列(PRD §8.5、W3-5.8):解析範本與收件人 → 每位收件人 × 每個通道寫一筆 gw.notify_log(queued)→ BullMQ notify。
 * 只負責入列;寄送在 worker(src/workers/notify.worker.ts)。供 /api/notify/send 與 BFF 內部(註冊、重設密碼)共用。
 */
import { eq, inArray, like, or } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { GwDatabase } from '../../db/client.js';
import { notifyLog, notifyTemplate, user } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import type { NotifyJob } from '../../plugins/queues.js';
import { isChannel, parseChannels, type Channel } from './template.js';

const IDEM_TTL_SEC = 24 * 60 * 60;
/** 單次請求展開後的通知上限(收件人 × 通道),避免一次請求塞滿佇列 */
export const MAX_NOTIFICATIONS = 1000;
const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const PRIORITY = { high: 1, normal: 5, low: 10 } as const;

export interface SendInput {
  templateCode: string;
  channels?: string[];
  to: { users?: string[]; adGroups?: string[]; emails?: string[] };
  data?: Record<string, unknown>;
  priority?: keyof typeof PRIORITY;
  idempotencyKey?: string;
  requestedBy: string;
}

export type SendResult = { duplicate: true } | { duplicate: false; queued: number; skipped: number };

interface Recipient {
  userId: number | null;
  address: string | null;
  label: string;
  skip?: string;
}

/** LIKE 的萬用字元跳脫(SQL Server) */
const likeEscape = (s: string) => s.replace(/[[%_]/g, (c) => `[${c}]`);

export class NotifyService {
  constructor(
    private readonly db: GwDatabase,
    private readonly redis: Redis,
    private readonly queue: Queue<NotifyJob>,
    private readonly log: FastifyBaseLogger,
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    const [tpl] = await this.db.select().from(notifyTemplate).where(eq(notifyTemplate.code, input.templateCode));
    if (!tpl || !tpl.isEnabled) throw new GwError('VALIDATION_FAILED', '通知範本不存在或已停用', [{ field: 'templateCode', message: input.templateCode }]);

    const requested = input.channels?.length ? input.channels : parseChannels(tpl.channels);
    const unsupported = requested.filter((c) => !isChannel(c));
    if (unsupported.length) throw new GwError('CHANNEL_NOT_SUPPORTED', undefined, { channels: unsupported });
    const channels = [...new Set(requested)] as Channel[];
    if (!channels.length) throw new GwError('VALIDATION_FAILED', '未指定通道,範本也沒有預設通道');
    if (channels.includes('email') && (!tpl.emailSubject || !tpl.emailBody)) throw new GwError('VALIDATION_FAILED', '範本沒有 Email 主旨或內文');
    if (channels.includes('inapp') && !tpl.inappBody) throw new GwError('VALIDATION_FAILED', '範本沒有站內通知內文');

    const users = await this.resolveUsers(input.to.users ?? [], input.to.adGroups ?? []);
    const emails = [...new Set((input.to.emails ?? []).map((e) => e.trim().toLowerCase()))];
    const badEmails = emails.filter((e) => !EMAIL_PATTERN.test(e));
    if (badEmails.length)
      throw new GwError(
        'VALIDATION_FAILED',
        'Email 格式錯誤',
        badEmails.map((e) => ({ field: 'to.emails', message: e })),
      );

    // 收件人 × 通道
    const items: { channel: Channel; r: Recipient }[] = [];
    for (const u of users) {
      for (const channel of channels) {
        if (u.skip) items.push({ channel, r: u });
        else if (channel === 'email') items.push({ channel, r: u.address ? u : { ...u, skip: '收件人沒有 Email' } });
        else items.push({ channel, r: u });
      }
    }
    const userEmails = new Set(users.map((u) => u.address?.toLowerCase()).filter(Boolean));
    if (channels.includes('email')) for (const e of emails) if (!userEmails.has(e)) items.push({ channel: 'email', r: { userId: null, address: e, label: e } });
    if (!items.length) throw new GwError('VALIDATION_FAILED', '沒有收件人');
    if (items.length > MAX_NOTIFICATIONS) throw new GwError('VALIDATION_FAILED', `單次通知不可超過 ${MAX_NOTIFICATIONS} 則(收件人 × 通道)`);

    const idemKey = input.idempotencyKey ? `gw:idem:notify:${input.idempotencyKey}` : null;
    if (idemKey && (await this.redis.set(idemKey, input.requestedBy, 'EX', IDEM_TTL_SEC, 'NX')) === null) return { duplicate: true };

    const jobs: { logId: number; job: NotifyJob }[] = [];
    let skipped = 0;
    try {
      await this.db.transaction(async (tx) => {
        for (const { channel, r } of items) {
          const [row] = await tx
            .insert(notifyLog)
            .output({ id: notifyLog.logId })
            .values({
              templateCode: tpl.code,
              channel,
              recipientUserId: r.userId,
              recipientAddress: channel === 'email' ? r.address : null,
              status: r.skip ? 'skipped' : 'queued',
              errorMessage: r.skip ? `${r.skip}:${r.label}`.slice(0, 2000) : null,
              idempotencyKey: input.idempotencyKey ?? null,
              requestedBy: input.requestedBy.slice(0, 64),
            });
          if (r.skip) skipped++;
          else
            jobs.push({
              logId: row!.id,
              job: { logId: row!.id, channel, templateCode: tpl.code, userId: r.userId, address: r.address, data: input.data ?? {} },
            });
        }
      });
      await this.queue.addBulk(
        jobs.map(({ logId, job }) => ({
          name: job.channel,
          data: job,
          opts: {
            jobId: `nt-${logId}`,
            priority: PRIORITY[input.priority ?? 'normal'],
            // 指數退避重試 5 次(首次 + 5 次),最終失敗進入死信(PRD §8.5)
            attempts: 6,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: IDEM_TTL_SEC },
            removeOnFail: false,
          },
        })),
      );
    } catch (err) {
      this.log.error({ err: (err as Error).message, templateCode: tpl.code }, '通知入列失敗');
      if (idemKey) await this.redis.del(idemKey).catch(() => undefined);
      if (jobs.length)
        await this.db
          .update(notifyLog)
          .set({ status: 'failed', errorMessage: '入列失敗' })
          .where(
            inArray(
              notifyLog.logId,
              jobs.map((j) => j.logId),
            ),
          )
          .catch(() => undefined);
      throw new GwError('INTERNAL_ERROR');
    }
    return { duplicate: false, queued: jobs.length, skipped };
  }

  /** 工號與 AD 群組 → 使用者(去重);查無或停用的工號記為略過 */
  private async resolveUsers(empNos: string[], adGroups: string[]): Promise<Recipient[]> {
    const wanted = [...new Set(empNos.map((e) => e.trim().toUpperCase()))];
    const conds = [];
    if (wanted.length) conds.push(inArray(user.employeeNo, wanted));
    // gw.user.ad_groups 為登入時寫入的群組 DN JSON 陣列;接受完整 DN 或 CN 名稱(只涵蓋登入過的使用者)
    for (const g of adGroups) conds.push(like(user.adGroups, g.includes('=') ? `%"${likeEscape(g)}"%` : `%"CN=${likeEscape(g)},%`));
    if (!conds.length) return [];
    const rows = await this.db
      .select({ userId: user.userId, employeeNo: user.employeeNo, email: user.email, isDisabled: user.isDisabled, isVirtual: user.isVirtual })
      .from(user)
      .where(or(...conds));
    const found = new Map(rows.map((u) => [u.employeeNo, u]));
    const out: Recipient[] = [];
    for (const u of rows) {
      if (u.isVirtual) continue; // 兼任帳號併入本人,不單獨通知(PRD Q16)
      out.push({ userId: u.userId, address: u.email, label: u.employeeNo, ...(u.isDisabled ? { skip: '帳號已停用' } : {}) });
    }
    for (const e of wanted) if (!found.has(e)) out.push({ userId: null, address: null, label: e, skip: '查無使用者' });
    return out;
  }
}
