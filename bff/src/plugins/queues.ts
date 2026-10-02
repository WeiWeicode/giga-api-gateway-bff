import { Queue } from 'bullmq';
import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';

/** BullMQ 佇列名稱(Redis 鍵 bull:<名稱>:*,DATABASE.md §6) */
export const QUEUE_WEBHOOK = 'webhook';
export const QUEUE_NOTIFY = 'notify';
/** 人事同步排程(DATABASE.md §6 bull:employee-sync:*):部門樹(departments)、人員(employees),各每小時;人員同步可由管理 API 手動觸發 */
export const QUEUE_EMPLOYEE_SYNC = 'employee-sync';

/** 人員同步工作:手動觸發時由管理 API 先建立 gw.employee_sync_run(queued)並帶入 runId */
export interface EmployeeSyncJob {
  runId?: number;
}

export interface WebhookJob {
  logId: number;
  source: string;
  /** gw.webhook_endpoint.dispatch_type:queue = 內部處理程序;route = 轉送到已發佈路由的上游(PRD §8.6) */
  dispatchType?: 'queue' | 'route';
  /** gw.webhook_endpoint.dispatch_target:queue 為處理程序代碼,route 為 route_code */
  target: string;
  idempotencyKey: string;
  payload: string;
}

/** 一則通知 = 一位收件人 × 一個通道(對應一筆 gw.notify_log) */
export interface NotifyJob {
  logId: number;
  channel: 'email' | 'inapp';
  templateCode: string;
  /** inapp 必填;email 有對應使用者時填入 */
  userId: number | null;
  /** email 收件地址 */
  address: string | null;
  data: Record<string, unknown>;
}

declare module 'fastify' {
  interface FastifyInstance {
    queues: { webhook: Queue<WebhookJob>; notify: Queue<NotifyJob>; employeeSync: Queue<EmployeeSyncJob> };
  }
}

/**
 * 佇列只負責入列(API 端);處理在 worker 行程(src/worker.ts)。
 * 與 app.redis 分開連線:BullMQ 需要可離線排隊的連線,Redis 不可用時 add() 會在重試後拋錯(呼叫端回 500,由來源重送)。
 */
export default fp<{ config: AppConfig }>(
  async (app, { config }) => {
    const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectionName: 'giganexus-bff-queue' });
    connection.on('error', (err) => app.log.warn({ err: err.message }, 'Redis 佇列連線錯誤'));
    const webhook = new Queue<WebhookJob>(QUEUE_WEBHOOK, { connection });
    const notify = new Queue<NotifyJob>(QUEUE_NOTIFY, { connection });
    const employeeSync = new Queue<EmployeeSyncJob>(QUEUE_EMPLOYEE_SYNC, { connection });
    app.decorate('queues', { webhook, notify, employeeSync });
    app.addHook('onClose', async () => {
      await Promise.all([webhook.close(), notify.close(), employeeSync.close()]).catch(() => undefined);
      connection.disconnect();
    });
  },
  { name: 'queues' },
);
