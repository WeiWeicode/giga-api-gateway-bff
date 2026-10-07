/**
 * 通知寄送(PRD §8.5、W3-5.8 / W3-5.9):Email(nodemailer,SMTP)與站內通知(gw.notify_message + Redis 推播 /ws/notify)。
 * 失敗由 BullMQ 指數退避重試(入列時 attempts = 6);每次失敗更新 gw.notify_log(failed、retry_count),用盡後標記 dead 並發出告警 log。
 * 公告 Email(job.data.announcementId,NOTIFY-PLAN §6.3):內容取自 gw.notify_announcement,圖片改 CID 內嵌;公告已撤回則記為 skipped。
 */
import { eq, inArray } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { GwDatabase } from '../db/client.js';
import { notifyAnnouncement, notifyAnnouncementAsset, notifyLog, notifyMessage, notifyTemplate } from '../db/schema/index.js';
import { assetIdsIn, toCidImages } from '../modules/notify/html.js';
import { viewUrlOf, type SettingsStore } from '../modules/notify/settings.js';
import { escapeHtml, renderTemplate } from '../modules/notify/template.js';
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

const LEVEL_PREFIX: Record<string, string> = { urgent: '【緊急】', important: '【重要】' };
const LEVEL_COLOR: Record<string, string> = { urgent: '#dc2626', important: '#ea580c', info: '#2563eb' };
const ANNOUNCEMENT_CACHE_MS = 5 * 60_000;

interface AnnouncementMail {
  status: string;
  subject: string;
  html: string;
  attachments: { filename: string; content: Buffer; contentType: string; cid: string }[];
}

/** 公告 Email 內容(全公司逐人寄時同一則公告重複使用,快取 5 分鐘) */
export function createAnnouncementMailer(db: GwDatabase, settings: SettingsStore, publicBaseUrl: string) {
  const cache = new Map<number, { at: number; p: Promise<AnnouncementMail | null> }>();
  const load = async (id: number): Promise<AnnouncementMail | null> => {
    const [a] = await db.select().from(notifyAnnouncement).where(eq(notifyAnnouncement.announcementId, id));
    if (!a) return null;
    const ids = assetIdsIn(a.bodyHtml);
    const assets = ids.length
      ? await db
          .select({
            id: notifyAnnouncementAsset.assetId,
            contentType: notifyAnnouncementAsset.contentType,
            fileName: notifyAnnouncementAsset.fileName,
            data: notifyAnnouncementAsset.data,
          })
          .from(notifyAnnouncementAsset)
          .where(inArray(notifyAnnouncementAsset.assetId, ids))
      : [];
    const url = `${publicBaseUrl.replace(/\/$/, '')}${viewUrlOf(await settings.get(), id)}`;
    const date = (a.publishAt ?? a.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    // 表格加框線(多數郵件軟體不套用外部樣式)
    const body = toCidImages(a.bodyHtml).replace(/<table\b/g, '<table border="1" cellpadding="6" cellspacing="0"');
    const html = [
      `<div style="font-family:'Microsoft JhengHei',Arial,sans-serif;font-size:14px;line-height:1.7;color:#1f2937">`,
      `<div style="border-left:4px solid ${LEVEL_COLOR[a.level] ?? LEVEL_COLOR.info};padding:4px 12px;margin-bottom:16px">`,
      `<div style="font-size:12px;color:#6b7280">${escapeHtml(a.publisherTitle ?? '公告')} · ${escapeHtml(date)}</div>`,
      `<div style="font-size:18px;font-weight:bold">${escapeHtml(a.title)}</div></div>`,
      body,
      `<p style="margin-top:24px;font-size:12px;color:#6b7280">在平台查看公告:<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`,
      a.requireAck ? '<br>此公告需要確認已閱讀,請至平台按「已閱讀」。' : '',
      '</p></div>',
    ].join('');
    return {
      status: a.status,
      subject: `${LEVEL_PREFIX[a.level] ?? ''}${a.title}`,
      html,
      attachments: assets.map((x) => ({
        filename: x.fileName ?? `image-${x.id}`,
        content: x.data,
        contentType: x.contentType,
        cid: `asset-${x.id}@giganexus`,
      })),
    };
  };
  return (id: number) => {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < ANNOUNCEMENT_CACHE_MS) return hit.p;
    const p = load(id);
    cache.set(id, { at: Date.now(), p });
    p.catch(() => cache.delete(id));
    for (const [k, v] of cache) if (Date.now() - v.at >= ANNOUNCEMENT_CACHE_MS) cache.delete(k);
    return p;
  };
}

export function createNotifyProcessor(deps: {
  db: GwDatabase;
  pub: Redis;
  mailer: Transporter | null;
  mail: MailConfig;
  log: Logger;
  /** 公告 Email;未提供時公告工作會失敗 */
  announcementMail?: ReturnType<typeof createAnnouncementMailer>;
}) {
  const { db, pub, mailer, mail, log, announcementMail } = deps;
  return async (job: Job<NotifyJob>) => {
    const { logId, channel, templateCode, userId, address, data, announcementId } = job.data;
    let providerMsgId: string | null;

    if (announcementId) {
      if (!mailer) throw new Error('未設定 SMTP(MAIL_HOST)');
      if (!announcementMail) throw new Error('worker 未設定公告 Email');
      if (!address) throw new Error('沒有收件地址');
      const m = await announcementMail(announcementId);
      if (!m || m.status !== 'published') {
        await db
          .update(notifyLog)
          .set({ status: 'skipped', errorMessage: m ? '公告已撤回' : '公告不存在' })
          .where(eq(notifyLog.logId, logId));
        return;
      }
      let { subject } = m;
      let to = address;
      if (mail.redirectTo) {
        subject = `[測試 → ${address}] ${subject}`;
        to = mail.redirectTo;
      }
      const info = await mailer.sendMail({ from: mail.from, to, subject, html: m.html, attachments: m.attachments });
      await db
        .update(notifyLog)
        .set({ status: 'sent', sentAt: new Date(), providerMsgId: info.messageId ?? null, retryCount: job.attemptsMade, errorMessage: null })
        .where(eq(notifyLog.logId, logId));
      return;
    }

    const [tpl] = await db.select().from(notifyTemplate).where(eq(notifyTemplate.code, templateCode));
    if (!tpl) throw new Error(`範本不存在:${templateCode}`);

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
