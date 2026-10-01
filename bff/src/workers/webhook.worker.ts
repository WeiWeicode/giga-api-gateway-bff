/**
 * Webhook 事件處理(PRD §8.6):依 gw.webhook_endpoint.dispatch_target 選擇處理程序,完成後寫入 gw.webhook_log.processed_at。
 * 失敗由 BullMQ 指數退避重試(入列時設定 5 次);最後一次失敗寫入 error_message 並保留於失敗清單供查。
 */
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { GwDatabase } from '../db/client.js';
import { webhookLog } from '../db/schema/index.js';
import type { WebhookJob } from '../plugins/queues.js';

export type WebhookHandler = (job: WebhookJob, log: Logger) => Promise<void>;

/**
 * 處理程序登記(dispatch_target → handler)。
 * 目前沒有外部來源(2026-10-01:BPM 不送 Webhook,簽核通知暫不處理),因此沒有處理程序;新增來源時在此登記。
 */
export const WEBHOOK_HANDLERS: Record<string, WebhookHandler> = {};

export function createWebhookProcessor(db: GwDatabase, log: Logger, handlers = WEBHOOK_HANDLERS) {
  return async (job: Job<WebhookJob>) => {
    const { logId, source, target } = job.data;
    const handler = handlers[target];
    if (!handler) {
      log.warn({ logId, source, target }, 'Webhook 沒有對應的處理程序,只記錄不處理');
      await db
        .update(webhookLog)
        .set({ processedAt: new Date(), errorMessage: `尚無處理程序:${target}` })
        .where(eq(webhookLog.logId, logId));
      return;
    }
    await handler(job.data, log);
    await db.update(webhookLog).set({ processedAt: new Date(), errorMessage: null }).where(eq(webhookLog.logId, logId));
  };
}

/** 重試用盡時記錄最後的錯誤 */
export async function recordWebhookFailure(db: GwDatabase, job: Job<WebhookJob>, err: Error): Promise<void> {
  await db
    .update(webhookLog)
    .set({ errorMessage: `處理失敗(第 ${job.attemptsMade} 次):${err.message}`.slice(0, 2000) })
    .where(eq(webhookLog.logId, job.data.logId));
}
