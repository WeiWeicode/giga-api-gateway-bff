/**
 * Webhook 事件處理(PRD §8.6),完成後寫入 gw.webhook_log.processed_at:
 *   dispatch_type = queue  依 dispatch_target 選擇內部處理程序
 *   dispatch_type = route  轉送到 dispatch_target(route_code)的上游(createRouteDispatcher)
 * 失敗由 BullMQ 指數退避重試(入列時設定 5 次);最後一次失敗寫入 error_message 並保留於失敗清單供查。
 */
import { eq } from 'drizzle-orm';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { SNAPSHOT_KEY, VERSION_KEY } from '../db/sync/release.js';
import type { GwDatabase } from '../db/client.js';
import { webhookLog } from '../db/schema/index.js';
import type { KeyStore } from '../modules/auth/keys.js';
import type { RouteSnapshot } from '../modules/router/snapshot.js';
import { UpstreamClient } from '../modules/router/upstream.js';
import type { WebhookJob } from '../plugins/queues.js';

export type WebhookHandler = (job: WebhookJob, log: Logger) => Promise<void>;

/**
 * 處理程序登記(dispatch_target → handler)。
 * 目前沒有外部來源(2026-10-01:BPM 不送 Webhook,簽核通知暫不處理),因此沒有處理程序;新增來源時在此登記。
 */
export const WEBHOOK_HANDLERS: Record<string, WebhookHandler> = {};

export function createWebhookProcessor(db: GwDatabase, log: Logger, handlers = WEBHOOK_HANDLERS, routeDispatch?: WebhookHandler) {
  return async (job: Job<WebhookJob>) => {
    const { logId, source, target } = job.data;
    if (job.data.dispatchType === 'route') {
      if (!routeDispatch) throw new UnrecoverableError('未設定路由分派');
      await routeDispatch(job.data, log);
      await db.update(webhookLog).set({ processedAt: new Date(), errorMessage: null }).where(eq(webhookLog.logId, logId));
      return;
    }
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

/**
 * dispatch_type = route(PRD §8.6):以 POST(或路由設定的上游方法)把原始 payload 轉送到路由的上游。
 *   - 路由與上游取自 Redis 目前發佈的快照(gw:routes:snapshot,與 BFF 同一來源;版本變更時重新讀取);只支援沒有路徑參數的 proxy 路由
 *   - X-Internal-Token:sub / emp = webhook:{來源},amr = webhook;另帶 Idempotency-Key(來源的冪等鍵)與 X-Webhook-Source
 *   - 上游 5xx / 逾時 / 連線失敗 → 丟出錯誤由 BullMQ 重試;4xx 視為設定或資料錯誤,不重試
 * 斷路器與連線池為 worker 自己的一份,不影響 BFF。
 */
export function createRouteDispatcher(deps: { redis: Redis; keys: KeyStore; log: Logger }) {
  const { redis, keys, log } = deps;
  const upstreams = new UpstreamClient(log);
  let cache: { version: string | null; snapshot: RouteSnapshot } | null = null;

  async function snapshot(): Promise<RouteSnapshot> {
    const version = await redis.get(VERSION_KEY);
    if (!cache || cache.version !== version) {
      const raw = await redis.get(SNAPSHOT_KEY);
      if (!raw) throw new Error('Redis 沒有路由快照');
      cache = { version, snapshot: JSON.parse(raw) as RouteSnapshot };
    }
    return cache.snapshot;
  }

  const dispatch: WebhookHandler = async (job) => {
    const snap = await snapshot();
    const route = snap.routes.find((r) => r.routeCode === job.target);
    if (!route || route.routeType !== 'proxy' || !route.upstreamCode) throw new UnrecoverableError(`分派目標不是已發佈的 proxy 路由:${job.target}`);
    const up = snap.upstreams.find((u) => u.code === route.upstreamCode);
    if (!up) throw new UnrecoverableError(`上游不存在:${route.upstreamCode}`);
    const path = route.upstreamPath ?? (route.publicPath.replace(new RegExp(`^/api/${route.systemCode}(?=/|$)`), '') || '/');
    if (/[:*]/.test(path)) throw new UnrecoverableError(`分派目標路由不可含路徑參數:${job.target}`);
    const token = await keys.signInternal(
      { sub: `webhook:${job.source}`, emp: `webhook:${job.source}`, upn: null, name: job.source, dept: null, cos: [], amr: 'webhook', roles: [] },
      up.code,
    );
    const res = await upstreams.request(up, {
      method: route.upstreamMethod ?? 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        'x-request-id': `webhook-${job.logId}`,
        'x-internal-token': token,
        'x-webhook-source': job.source,
        'idempotency-key': job.idempotencyKey,
      },
      body: Buffer.from(job.payload, 'utf8'),
      timeoutMs: route.timeoutMs ?? up.timeoutMs,
    });
    const text = await res.body.text();
    if (res.status >= 400) throw new UnrecoverableError(`上游回應 HTTP ${res.status}:${text.slice(0, 200)}`);
    log.info({ logId: job.logId, source: job.source, route: route.routeCode, status: res.status }, 'Webhook 已轉送上游');
  };

  return { dispatch, close: () => upstreams.close() };
}
