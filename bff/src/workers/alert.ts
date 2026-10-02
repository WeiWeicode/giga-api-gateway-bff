/**
 * 告警 Email(worker 使用):通知死信(PRD §8.5)、人員 / 部門同步中止與連續失敗、離職標記與新公司(DATABASE.md §8.3)。
 *
 *   - 一律先寫 error log(alert: true),集中日誌可據此告警
 *   - 設定 ALERT_EMAIL_TO 且有 SMTP 時直接寄信(不經通知佇列,避免佇列本身異常時告警也送不出)
 *   - 同一類告警(kind)預設 10 分鐘內只寄一次:Redis gw:alert:{kind}(SET NX EX);Redis 不可用時照寄
 *   - GW_ENV 不是 prod 時改寄 MAIL_REDIRECT_TO(DEPLOYMENT.md §5.1),主旨註明原收件人
 */
import type { Redis } from 'ioredis';
import type { Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { escapeHtml } from '../modules/notify/template.js';

const DEFAULT_THROTTLE_SEC = 10 * 60;

export type Alert = (kind: string, subject: string, lines: string[], opts?: { throttleSec?: number }) => Promise<void>;

export function createAlerter(deps: { mailer: Transporter | null; mail: AppConfig['mail']; to: string[]; redis: Redis; log: Logger; env: string }): Alert {
  const { mailer, mail, to, redis, log, env } = deps;
  return async (kind, subject, lines, opts = {}) => {
    log.error({ alert: true, kind, detail: lines.slice(0, 20) }, subject);
    if (!mailer || !to.length) return;
    try {
      const first = await redis.set(`gw:alert:${kind}`, '1', 'EX', opts.throttleSec ?? DEFAULT_THROTTLE_SEC, 'NX');
      if (!first) return;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Redis 無法檢查告警頻率,照常寄送');
    }
    let title = `[GigaNexus ${env} 告警] ${subject}`;
    let recipients = to.join(', ');
    if (mail.redirectTo) {
      title = `[測試 → ${recipients}] ${title}`;
      recipients = mail.redirectTo;
    }
    const html = `<p>${escapeHtml(subject)}</p><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul><p>時間:${new Date().toISOString()}</p>`;
    try {
      await mailer.sendMail({ from: mail.from, to: recipients, subject: title, html });
    } catch (err) {
      log.error({ err: (err as Error).message, kind }, '告警 Email 寄送失敗');
    }
  };
}
