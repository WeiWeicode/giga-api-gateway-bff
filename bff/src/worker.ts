/**
 * Worker 進入點(DEPLOYMENT.md §3.1:與 BFF 共用映像檔,以 `node dist/bff/src/worker.js` 啟動)。
 * 處理 BullMQ 佇列:webhook(W3-5.10)、notify(W3-5.8)、notify-fanout(公告分送與每日保留期限清理,NOTIFY-PLAN §6.3)、employee-sync(部門樹與人員各每小時,P2-3a / W3-4.6b)。BullMQ 確保多個 worker 不會重複處理同一個工作。
 * 告警(死信、同步中止、離職標記與新公司)寄給 ALERT_EMAIL_TO(workers/alert.ts)。
 */
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createGwDb, openPool } from './db/client.js';
import { KeyStore } from './modules/auth/keys.js';
import { SettingsStore } from './modules/notify/settings.js';
import { PermissionService } from './modules/rbac/permission.js';
import {
  QUEUE_EMPLOYEE_SYNC,
  QUEUE_NOTIFY,
  QUEUE_NOTIFY_FANOUT,
  QUEUE_WEBHOOK,
  type EmployeeSyncJob,
  type NotifyFanoutJob,
  type NotifyJob,
  type WebhookJob,
} from './plugins/queues.js';
import { createAlerter } from './workers/alert.js';
import { createAnnounceProcessor } from './workers/announce.worker.js';
import { createEmployeeSyncProcessor } from './workers/employee-sync.worker.js';
import { createAnnouncementMailer, createMailer, createNotifyProcessor, recordNotifyFailure } from './workers/notify.worker.js';
import { createRouteDispatcher, createWebhookProcessor, recordWebhookFailure } from './workers/webhook.worker.js';

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

// 站內通知推播、告警頻率、路由快照讀取用一般連線(Worker 的連線會被 BullMQ 阻塞式指令占用)
const pub = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectionName: 'giganexus-worker-pub' });
pub.on('error', (err) => log.warn({ err: err.message }, 'Redis 推播連線錯誤'));
const mailer = createMailer(config.mail);
if (!mailer) log.warn('未設定 MAIL_HOST,Email 通知會失敗並重試');
const alert = createAlerter({ mailer, mail: config.mail, to: config.alertEmailTo, redis: pub, log: log.child({ component: 'alert' }), env: config.gwEnv });
if (!config.alertEmailTo.length) log.warn('未設定 ALERT_EMAIL_TO,告警只寫 error log');

// Webhook 分派:queue = 內部處理程序;route = 轉送到已發佈路由的上游(PRD §8.6),以內部 Token 表明來源
const webhookLog = log.child({ queue: QUEUE_WEBHOOK });
const dispatcher = createRouteDispatcher({ redis: pub, keys: KeyStore.load(config.jwtKeysDir, config.jwtActiveKid), log: webhookLog });
const webhook = new Worker<WebhookJob>(QUEUE_WEBHOOK, createWebhookProcessor(db, webhookLog, undefined, dispatcher.dispatch), { connection, concurrency: 5 });
webhook.on('failed', (job, err) => {
  if (!job) return;
  log.error({ queue: QUEUE_WEBHOOK, jobId: job.id, attempts: job.attemptsMade, err: err.message }, 'Webhook 處理失敗');
  // 重試用盡,或不可重試的錯誤(路由不存在、上游 4xx)
  if (job.attemptsMade >= (job.opts.attempts ?? 1) || err.name === 'UnrecoverableError')
    void recordWebhookFailure(db, job, err).catch((e: Error) => log.error({ err: e.message }, '寫入 Webhook 失敗紀錄失敗'));
});
webhook.on('error', (err) => log.error({ err: err.message }, 'Webhook worker 錯誤'));

const notifyLog = log.child({ queue: QUEUE_NOTIFY });
const notifySettings = new SettingsStore(db);
const announcementMail = createAnnouncementMailer(db, notifySettings, config.publicBaseUrl);
const notify = new Worker<NotifyJob>(QUEUE_NOTIFY, createNotifyProcessor({ db, pub, mailer, mail: config.mail, log: notifyLog, announcementMail }), {
  connection,
  concurrency: 5,
  // SMTP 伺服器限制(PRD §8.5 限速)
  limiter: { max: config.mail.ratePerSec, duration: 1000 },
});
notify.on('failed', (job, err) => {
  if (!job) return;
  notifyLog.warn({ jobId: job.id, attempts: job.attemptsMade, err: err.message }, '通知寄送失敗');
  void recordNotifyFailure(db, notifyLog, job, err)
    .then((dead) =>
      dead
        ? alert('notify-dead', '通知寄送最終失敗(死信)', [
            `notify_log #${job.data.logId}`,
            `通道 ${job.data.channel}、範本 ${job.data.templateCode}`,
            err.message,
          ])
        : undefined,
    )
    .catch((e: Error) => log.error({ err: e.message }, '寫入通知失敗紀錄失敗'));
});
notify.on('error', (err) => log.error({ err: err.message }, '通知 worker 錯誤'));

// 公告分送:一則公告一個工作(廣播、展開 Email);每日 03:00(台北)依保留期限清理
const fanoutLog = log.child({ queue: QUEUE_NOTIFY_FANOUT });
const notifyQueue = new Queue<NotifyJob>(QUEUE_NOTIFY, { connection });
const fanoutQueue = new Queue<NotifyFanoutJob>(QUEUE_NOTIFY_FANOUT, { connection });
const fanout = new Worker<NotifyFanoutJob>(QUEUE_NOTIFY_FANOUT, createAnnounceProcessor({ db, pub, notifyQueue, settings: notifySettings, log: fanoutLog }), {
  connection,
  concurrency: 2,
});
fanout.on('failed', (job, err) => {
  if (!job) return;
  fanoutLog.error(
    { jobId: job.id, kind: job.data.kind, announcementId: job.data.announcementId, attempts: job.attemptsMade, err: err.message },
    '公告分送失敗',
  );
  if (job.attemptsMade >= (job.opts.attempts ?? 1))
    void alert('announce-dead', '公告分送最終失敗', [`工作 ${job.data.kind}、公告 #${job.data.announcementId ?? '-'}`, err.message]).catch(() => undefined);
});
fanout.on('error', (err) => fanoutLog.error({ err: err.message }, '公告分送 worker 錯誤'));
await fanoutQueue.upsertJobScheduler(
  'retention',
  { pattern: '0 3 * * *', tz: 'Asia/Taipei' },
  { name: 'retention', data: { kind: 'retention' }, opts: { removeOnComplete: 7, removeOnFail: 20 } },
);

// 人事同步:部門樹與人員(每小時;BPM / LOS 皆未設定時不排程)
const syncLog = log.child({ queue: QUEUE_EMPLOYEE_SYNC });
const syncQueue = new Queue<EmployeeSyncJob>(QUEUE_EMPLOYEE_SYNC, { connection });
const perms = new PermissionService(db, pub, syncLog);
const sync = createEmployeeSyncProcessor({ db, config, perms, alert, log: syncLog });
const employeeSync = new Worker<EmployeeSyncJob>(QUEUE_EMPLOYEE_SYNC, sync.processor, { connection, concurrency: 1 });
employeeSync.on('failed', (job, err) => syncLog.error({ jobId: job?.id, name: job?.name, err: err.message }, '人事同步失敗'));
employeeSync.on('error', (err) => syncLog.error({ err: err.message }, '人事同步 worker 錯誤'));
const SYNC_OPTS = { removeOnComplete: 24, removeOnFail: 50 };
if (config.bpmDb) await syncQueue.upsertJobScheduler('departments', { every: 60 * 60 * 1000 }, { name: 'departments', opts: SYNC_OPTS });
else syncLog.warn('未設定 BPM_DB_HOST,不排程部門樹同步');
if (config.bpmDb || config.losDb) await syncQueue.upsertJobScheduler('employees', { every: 60 * 60 * 1000 }, { name: 'employees', opts: SYNC_OPTS });
else syncLog.warn('未設定 BPM_DB_HOST / LOS_DB_HOST,不排程人員同步');

log.info(
  {
    queues: [QUEUE_WEBHOOK, QUEUE_NOTIFY, QUEUE_NOTIFY_FANOUT, QUEUE_EMPLOYEE_SYNC],
    mail: config.mail.host ? `${config.mail.host}:${config.mail.port}` : null,
    redirectTo: config.mail.redirectTo ?? null,
  },
  'worker 啟動',
);

const shutdown = async (signal: string) => {
  log.info({ signal }, '收到結束訊號,等待執行中的工作完成');
  try {
    await Promise.all([webhook.close(), notify.close(), fanout.close(), notifyQueue.close(), fanoutQueue.close(), employeeSync.close(), syncQueue.close()]);
    await sync.close();
    await dispatcher.close();
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
