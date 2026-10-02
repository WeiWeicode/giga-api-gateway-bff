/**
 * Prometheus 指標(PRD §7.7、§12、W3-4.1 / W3-5.11):GET /metrics(僅內網,Nginx 以 internal-services 白名單限制)。
 *
 *   gw_http_requests_total{method,route,status}        請求數(route:內建路由的 URL 樣板;動態路由為 route_code)
 *   gw_http_request_duration_seconds{method,route}     延遲
 *   gw_upstream_requests_total{upstream,outcome}       上游呼叫結果(2xx / 4xx / UPSTREAM_*)
 *   gw_upstream_request_duration_seconds{upstream}
 *   gw_circuit_open{upstream}                          斷路器(1 = 開啟或半開;各實例記憶體狀態)
 *   gw_permission_check_seconds                        權限判斷(PRD §4.2:快取命中 < 2 ms)
 *   gw_login_total{result}                             登入結果(success / password_change_required / 錯誤代碼)
 *   gw_queue_jobs{queue,state}                         BullMQ 佇列長度;notify 的 failed 即死信(重試用盡)
 *   gw_route_snapshot_version                          目前套用的路由版本
 *   gw_*(Node.js 預設指標:CPU、記憶體、事件迴圈延遲、GC)
 *
 * 指標物件為模組層級(同一行程只註冊一次);worker 行程也會更新權限判斷指標,但不對外提供 /metrics。
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'gw_' });

export const httpRequests = new Counter({
  name: 'gw_http_requests_total',
  help: 'BFF 處理的 HTTP 請求數',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'gw_http_request_duration_seconds',
  help: 'BFF 處理 HTTP 請求的時間',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const upstreamRequests = new Counter({
  name: 'gw_upstream_requests_total',
  help: '上游呼叫結果',
  labelNames: ['upstream', 'outcome'] as const,
  registers: [registry],
});

export const upstreamDuration = new Histogram({
  name: 'gw_upstream_request_duration_seconds',
  help: '上游呼叫時間(至收到回應標頭)',
  labelNames: ['upstream'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const permissionCheck = new Histogram({
  name: 'gw_permission_check_seconds',
  help: '權限判斷時間(快取命中為一次 Redis SISMEMBER)',
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5],
  registers: [registry],
});

export const loginTotal = new Counter({
  name: 'gw_login_total',
  help: '登入結果',
  labelNames: ['result'] as const,
  registers: [registry],
});

/** 依 BFF 實例收集(scrape 時計算)的來源;由 plugin 設定 */
let source: FastifyInstance | null = null;

new Gauge({
  name: 'gw_circuit_open',
  help: '斷路器狀態(1 = 開啟或半開)',
  labelNames: ['upstream'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const [upstream, state] of Object.entries(source?.upstreams?.breakerStates() ?? {})) this.set({ upstream }, state === 'closed' ? 0 : 1);
  },
});

new Gauge({
  name: 'gw_route_snapshot_version',
  help: '目前套用的路由快照版本',
  registers: [registry],
  collect() {
    this.set(source?.routeTable?.version ?? 0);
  },
});

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

new Gauge({
  name: 'gw_queue_jobs',
  help: 'BullMQ 佇列工作數(notify 的 failed 為死信)',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
  async collect() {
    const queues = source?.queues;
    if (!queues) return;
    for (const q of [queues.webhook, queues.notify, queues.employeeSync]) {
      try {
        const counts = await q.getJobCounts(...QUEUE_STATES);
        for (const state of QUEUE_STATES) this.set({ queue: q.name, state }, counts[state] ?? 0);
      } catch {
        // Redis 不可用時不輸出此佇列(readyz 會反映 Redis 狀態)
      }
    }
  },
});

/** 指標的 route 標籤:動態路由用 route_code(x-route-code),內建路由用 URL 樣板,避免以實際路徑造成高基數 */
function routeLabel(routeUrl: string | undefined, routeCode: unknown): string {
  if (typeof routeCode === 'string' && routeCode) return routeCode;
  return routeUrl ?? 'unmatched';
}

/** 需在所有路由之前註冊(onResponse hook 才會套用到之後註冊的路由);路由器、佇列在 scrape 時才讀取 */
export default fp(
  async (app) => {
    source = app;
    app.addHook('onResponse', async (req, reply) => {
      const route = routeLabel(req.routeOptions.url, reply.getHeader('x-route-code'));
      httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) });
      httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
    });
    app.get('/metrics', { logLevel: 'warn' }, async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
  },
  { name: 'metrics' },
);
