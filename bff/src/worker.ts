/**
 * Worker 進入點(DEPLOYMENT.md §3.1:與 BFF 共用映像檔,以 `node dist/bff/src/worker.js` 啟動)。
 * 處理 BullMQ 佇列:webhook(W3-5.10)、notify(W3-5.8)。BullMQ 確保多個 worker 不會重複處理同一個工作。
 */
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createGwDb, openPool } from './db/client.js';
import { QUEUE_NOTIFY, QUEUE_WEBHOOK, type NotifyJob, type WebhookJob } from './plugins/queues.js';
import { createMailer, createNotifyProcessor, recordNotifyFailure } from './workers/notify.worker.js';
import { createWebhookProcessor, recordWebhookFailure } from './workers/webhook.worker.js';

const config = loadConfig();
const log = pino({
  level: config.logLevel,
  base: { instance: config.instanceId },
  ...(config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } } : {}),
});

const pool = await openPool(config.gwDb, { appName: 'giganexus-worker', poolMax: 5 });
pool.on('error', (err) => log.error({ err }, 'giganexus_gw 連線池錯誤'));
const db = createGwDb(pool, config.sql2012Guard);
// BullMQ Worker 需要不限制重試次數的連線(maxRetriesPerRequest: null)
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null, connectionName: 'giganexus-worker' });
connection.on('error', (err) => log.warn({ err: err.message }, 'Redis 連線錯誤'));

const webhook = new Worker<WebhookJob>(QUEUE_WEBHOOK, createWebhookProcessor(db, log.child({ queue: QUEUE_WEBHOOK })), { connection, concurrency: 5 });
webhook.on('failed', (job, err) => {
  if (!job) return;
  log.error({ queue: QUEUE_WEBHOOK, jobId: job.id, attempts: job.attemptsMade, err: err.message }, 'Webhook 處理失敗');
  if (job.attemptsMade >= (job.opts.attempts ?? 1))
    void recordWebhookFailure(db, job, err).catch((e: Error) => log.error({ err: e.message }, '寫入 Webhook 失敗紀錄失敗'));
});
webhook.on('error', (err) => log.error({ err: err.message }, 'Webhook worker 錯誤'));

// 站內通知推播用一般連線(Worker 的連線會被 BullMQ 阻塞式指令占用)
const pub = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectionName: 'giganexus-worker-pub' });
pub.on('error', (err) => log.warn({ err: err.message }, 'Redis 推播連線錯誤'));
const notifyLog = log.child({ queue: QUEUE_NOTIFY });
const mailer = createMailer(config.mail);
if (!mailer) log.warn('未設定 MAIL_HOST,Email 通知會失敗並重試');
const notify = new Worker<NotifyJob>(QUEUE_NOTIFY, createNotifyProcessor({ db, pub, mailer, mail: config.mail, log: notifyLog }), {
  connection,
  concurrency: 5,
  // SMTP 伺服器限制(PRD §8.5 限速)
  limiter: { max: config.mail.ratePerSec, duration: 1000 },
});
notify.on('failed', (job, err) => {
  if (!job) return;
  notifyLog.warn({ jobId: job.id, attempts: job.attemptsMade, err: err.message }, '通知寄送失敗');
  void recordNotifyFailure(db, notifyLog, job, err).catch((e: Error) => log.error({ err: e.message }, '寫入通知失敗紀錄失敗'));
});
notify.on('error', (err) => log.error({ err: err.message }, '通知 worker 錯誤'));
log.info(
  {
    queues: [QUEUE_WEBHOOK, QUEUE_NOTIFY],
    mail: config.mail.host ? `${config.mail.host}:${config.mail.port}` : null,
    redirectTo: config.mail.redirectTo ?? null,
  },
  'worker 啟動',
);

const shutdown = async (signal: string) => {
  log.info({ signal }, '收到結束訊號,等待執行中的工作完成');
  try {
    await Promise.all([webhook.close(), notify.close()]);
    mailer?.close();
    pub.disconnect();
    connection.disconnect();
    await pool.close();
    process.exit(0);
  } catch (err) {
    log.error({ err }, '關閉失敗');
    process.exit(1);
  }
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
