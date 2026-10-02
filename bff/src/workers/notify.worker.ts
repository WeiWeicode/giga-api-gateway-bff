/**
 * 通知寄送(PRD §8.5、W3-5.8 / W3-5.9):Email(nodemailer,SMTP)與站內通知(gw.notify_message + Redis 推播 /ws/notify)。
 * 失敗由 BullMQ 指數退避重試(入列時 attempts = 6);每次失敗更新 gw.notify_log(failed、retry_count),用盡後標記 dead 並發出告警 log。
 */
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { GwDatabase } from '../db/client.js';
import { notifyLog, notifyMessage, notifyTemplate } from '../db/schema/index.js';
import { renderTemplate } from '../modules/notify/template.js';
import type { NotifyJob } from '../plugins/queues.js';

type MailConfig = AppConfig['mail'];

export function createMailer(mail: MailConfig): Transporter | null {
  if (!mail.host) return null;
  return nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    ...(mail.user ? { auth: { user: mail.user, pass: mail.password ?? '' } } : {}),
    // 內網 SMTP 中繼可能使用企業 CA 或自簽憑證(STARTTLS);只影響傳輸加密,不影響收件
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

/** 站內通知連結:只接受站內路徑或 https 網址 */
function linkOf(data: Record<string, unknown>): string | null {
  const v = data.linkUrl;
  return typeof v === 'string' && v.length <= 500 && (v.startsWith('/') || v.startsWith('https://')) ? v : null;
}

export function createNotifyProcessor(deps: { db: GwDatabase; pub: Redis; mailer: Transporter | null; mail: MailConfig; log: Logger }) {
  const { db, pub, mailer, mail, log } = deps;
  return async (job: Job<NotifyJob>) => {
    const { logId, channel, templateCode, userId, address, data } = job.data;
    const [tpl] = await db.select().from(notifyTemplate).where(eq(notifyTemplate.code, templateCode));
    if (!tpl) throw new Error(`範本不存在:${templateCode}`);
    let providerMsgId: string | null;

    if (channel === 'email') {
      if (!mailer) throw new Error('未設定 SMTP(MAIL_HOST)');
      if (!address) throw new Error('沒有收件地址');
      let subject = renderTemplate(tpl.emailSubject ?? tpl.name, data);
      let to = address;
      if (mail.redirectTo) {
        // 測試區 / 開發:改寄測試信箱(DEPLOYMENT.md §5.1)
        subject = `[測試 → ${address}] ${subject}`;
        to = mail.redirectTo;
      }
      const info = await mailer.sendMail({ from: mail.from, to, subject, html: renderTemplate(tpl.emailBody ?? '', data, true) });
      providerMsgId = info.messageId ?? null;
    } else {
      if (!userId) throw new Error('站內通知沒有使用者');
      const title = renderTemplate(tpl.emailSubject ?? tpl.name, data).slice(0, 200);
      const body = renderTemplate(tpl.inappBody ?? '', data).slice(0, 2000);
      const linkUrl = linkOf(data);
      const [msg] = await db
        .insert(notifyMessage)
        .output({ id: notifyMessage.messageId, createdAt: notifyMessage.createdAt })
        .values({ userId, title, body, linkUrl });
      // 推播給已連線的 /ws/notify(各 BFF 實例訂閱 gw:notify:user:*);未連線者下次開啟時查詢
      await pub
        .publish(`gw:notify:user:${userId}`, JSON.stringify({ type: 'notification', messageId: msg!.id, title, body, linkUrl, createdAt: msg!.createdAt }))
        .catch((err: Error) => log.warn({ err: err.message, userId }, '站內通知推播失敗(訊息已寫入)'));
      providerMsgId = `inapp:${msg!.id}`;
    }
    await db
      .update(notifyLog)
      .set({ status: 'sent', sentAt: new Date(), providerMsgId, retryCount: job.attemptsMade, errorMessage: null })
      .where(eq(notifyLog.logId, logId));
  };
}

/** 每次失敗:未用盡 → failed;用盡 → dead(死信,保留在 BullMQ 失敗清單)。回傳是否為死信,由呼叫端告警(workers/alert.ts) */
export async function recordNotifyFailure(db: GwDatabase, log: Logger, job: Job<NotifyJob>, err: Error): Promise<boolean> {
  const dead = job.attemptsMade >= (job.opts.attempts ?? 1);
  await db
    .update(notifyLog)
    // retry_count = 已重試次數(第 1 次執行不算重試)
    .set({ status: dead ? 'dead' : 'failed', retryCount: job.attemptsMade - 1, errorMessage: err.message.slice(0, 2000) })
    .where(eq(notifyLog.logId, job.data.logId));
  if (dead) log.warn({ logId: job.data.logId, channel: job.data.channel, templateCode: job.data.templateCode, err: err.message }, '通知最終失敗(死信)');
  return dead;
}
