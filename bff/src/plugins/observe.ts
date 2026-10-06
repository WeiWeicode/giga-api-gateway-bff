/**
 * API 監控(MONITORING-PLAN §5.3、W9-6):BFF 每筆請求送 giga-observe(服務 gw-bff),與下游後端用同一個 SDK。
 *
 *   - 動態路由附 meta:routeCode、upstream、routeType → 儀表板「上游服務健康」依 upstream 彙總
 *   - 使用者:已解析過的登入者工號(不為了監控額外解析 Token);API Key 呼叫記為 client:{代碼}
 *   - 心跳帶相依服務狀態(SQL Server、Redis),架構圖詳情顯示
 *   - 不記錄:健康檢查、/metrics、/docs、前端遙測本身(/api/telemetry/web)
 *   - 遮罩:SDK 預設(password、token、secret…)之外,再遮 otp、captcha
 *
 * 需在所有路由之前註冊(hook 才會套用);監控停用(dev 預設、未設定 MONITOR_URL / Key)時 hook 不掛載,只留 req.monitor 空殼。
 * SDK 尚未發佈到 Registry(W9-3),先以相對路徑使用同 repo 的原始碼(tsconfig.build rootDir = ..)。
 */
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { setupGateway } from '../../../sdk/node/src/fastify.js';
import type { DepStatus } from '../../../sdk/node/src/monitor.js';
import type { AppConfig } from '../config.js';
import { TELEMETRY_PATH } from '../modules/telemetry/routes.js';

async function ping(name: string, fn: () => Promise<unknown>): Promise<DepStatus> {
  const t0 = performance.now();
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref())]);
    return { name, ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch {
    return { name, ok: false, latencyMs: null };
  }
}

async function userOf(req: FastifyRequest): Promise<string | null> {
  if (req.apiClient) return `client:${req.apiClient.code}`;
  // 只用已解析的結果:路由本來就需要登入時才有,不為了監控另外驗證 Token
  const p = await (req.principalCache ?? Promise.resolve(null)).catch(() => null);
  return p?.claims.emp ?? null;
}

export default fp<{ config: AppConfig }>(
  async (app, { config }) => {
    const m = config.monitor;
    await app.register(setupGateway, {
      register: false,
      monitor: { enabled: (m.enabled ?? config.gwEnv !== 'dev') && !!m.url && !!m.apiKey, endpoint: m.url ?? null, apiKey: m.apiKey ?? null },
      version: process.env.IMAGE_TAG ?? process.env.npm_package_version,
      userId: userOf,
      meta: (req, reply) => {
        const routeCode = reply.getHeader('x-route-code');
        if (typeof routeCode !== 'string') return undefined;
        const match = app.routeTable?.find(req.method, req.url.split('?')[0]!);
        return { routeCode, upstream: match?.route.upstreamCode ?? null, routeType: match?.route.routeType ?? null };
      },
      monitorOptions: {
        ignorePaths: ['/healthz', '/readyz', '/metrics', '/docs', TELEMETRY_PATH],
        maskFields: ['otp', 'captcha'],
        deps: async () => Promise.all([ping('sqlserver', () => app.gwPool.request().query('SELECT 1 AS ok')), ping('redis', () => app.redis.ping())]),
      },
    });
  },
  { name: 'observe' },
);
