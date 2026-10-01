import { Queue } from 'bullmq';
import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';

/** BullMQ 佇列名稱(Redis 鍵 bull:<名稱>:*,DATABASE.md §6) */
export const QUEUE_WEBHOOK = 'webhook';

export interface WebhookJob {
  logId: number;
  source: string;
  /** gw.webhook_endpoint.dispatch_target:worker 依此選擇處理程序 */
  target: string;
  idempotencyKey: string;
  payload: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    queues: { webhook: Queue<WebhookJob> };
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
    app.decorate('queues', { webhook });
    app.addHook('onClose', async () => {
      await webhook.close().catch(() => undefined);
      connection.disconnect();
    });
  },
  { name: 'queues' },
);
