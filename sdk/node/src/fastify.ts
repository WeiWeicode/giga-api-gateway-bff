/**
 * Fastify 一鍵接入(MONITORING-PLAN.md §5.2):`@giganexus/backend-sdk/fastify`
 *
 *   await app.register(setupGateway, { env: config.gateway, monitor: config.monitor, version: '1.2.0' });
 *
 *   - 監控:每筆請求送 giga-observe(錯誤含完整 body、成功只存摘要;遮罩敏感欄位;心跳)
 *   - req.monitor.action('db', 'mssql.items', 12) 記錄步驟;req.monitor.fail(err) 自報錯誤
 *   - app.monitor.job('nightly-sync') 回報排程工作
 *   - 開始服務後自動註冊 API(dev 不註冊;失敗只記錄 error,不停止服務,BACKEND-GUIDE.md §7.5)
 *
 * 必須在路由之前 register(hook 才會套用到之後的路由);本 plugin 不封裝(skip-override),hook 對整個 app 生效。
 * 健康檢查(/healthz、/readyz)仍由服務自己提供:它們的驗證設定各服務不同。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayEnv } from './env.js';
import { GatewayError } from './client.js';
import {
  maskDeep,
  Monitor,
  MonitorScope,
  pickHeaders,
  prepareBody,
  shouldIgnore,
  toMonitorError,
  type MonitorEnv,
  type MonitorLog,
  type MonitorOptions,
} from './monitor.js';
import { autoRegister } from './register.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** giga-observe 回報器;停用時 enabled = false,所有方法都是 no-op */
    monitor: Monitor;
  }
  interface FastifyRequest {
    /** 本次請求的步驟與自報錯誤 */
    monitor: MonitorScope;
  }
}

export interface SetupGatewayOptions {
  /** 自動註冊需要;register: false 時可省略 */
  env?: GatewayEnv;
  /** loadMonitorEnv() 的結果;false 或省略 = 不監控 */
  monitor?: MonitorEnv | false;
  /** 進階監控參數(抽樣、忽略路徑、遮罩欄位、相依服務…) */
  monitorOptions?: Omit<MonitorOptions, 'endpoint' | 'apiKey' | 'enabled'>;
  /** 服務版本,隨心跳回報 */
  version?: string;
  /** 自動註冊:false 停用;spec 預設 app.swagger()(需先註冊 @fastify/swagger) */
  register?: false | { spec?: () => object };
  /** 取得使用者代碼;預設 req.identity 的 emp(工號)或 sub。可回傳 Promise(在回應送出後才呼叫,不影響回應時間) */
  userId?: (req: FastifyRequest) => string | null | undefined | Promise<string | null | undefined>;
  /** 附加標籤(例:BFF 的 routeCode、upstream) */
  meta?: (req: FastifyRequest, reply: FastifyReply) => MonitorLog['meta'] | undefined;
}

interface Captured {
  payload?: unknown;
  error?: unknown;
}

const captured = new WeakMap<FastifyRequest, Captured>();

function defaultUserId(req: FastifyRequest): string | null {
  const id = (req as unknown as { identity?: { emp?: string; sub?: string } | null }).identity;
  return id?.emp ?? id?.sub ?? null;
}

function clientIp(req: FastifyRequest): string | null {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.ip || null;
}

/**
 * 請求 body:Fastify 已解析的物件照用;原始 Buffer(例:BFF 轉送上游,不解析 body)若為 JSON / 文字則轉回內容才能遮罩,其餘只記大小
 */
function requestBody(body: unknown, contentType: string, maxBytes: number): unknown {
  if (!Buffer.isBuffer(body)) return body;
  if (!body.length) return null;
  if (contentType.includes('json') && body.length <= maxBytes) {
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      // 非合法 JSON 照文字處理
    }
  }
  if (contentType.includes('json') || contentType.startsWith('text/') || contentType.includes('x-www-form-urlencoded')) return body.toString('utf8');
  return `[binary ${body.length} bytes]`;
}

/** onSend 的 payload:字串或 Buffer 保留;錯誤且為 JSON 時解析成物件,畫面才好讀 */
function responseBody(payload: unknown, isError: boolean, contentType: string, maxBytes: number, maskFields: string[]): unknown {
  let text: string | null = null;
  if (typeof payload === 'string') text = payload;
  else if (Buffer.isBuffer(payload))
    text = contentType.startsWith('text/') || contentType.includes('json') ? payload.toString('utf8') : `[binary ${payload.length} bytes]`;
  else if (payload) return '[stream]';
  if (text === null) return null;
  if (isError && contentType.includes('json') && text.length <= maxBytes) {
    try {
      return maskDeep(JSON.parse(text), maskFields);
    } catch {
      // 非合法 JSON 照原字串
    }
  }
  return text;
}

async function setupGatewayPlugin(app: FastifyInstance, opts: SetupGatewayOptions): Promise<void> {
  const m = opts.monitor || null;
  const monitor = new Monitor({
    ...opts.monitorOptions,
    endpoint: m?.endpoint ?? null,
    apiKey: m?.apiKey ?? null,
    enabled: !!m?.enabled,
    version: opts.version ?? opts.monitorOptions?.version ?? null,
    warn: opts.monitorOptions?.warn ?? ((msg) => app.log.warn(msg)),
  });
  app.decorate('monitor', monitor);
  app.decorateRequest('monitor', null as unknown as MonitorScope);

  app.addHook('onRequest', async (req) => {
    req.monitor = new MonitorScope();
  });

  if (monitor.enabled) {
    const cfg = monitor.cfg;
    const userId = opts.userId ?? defaultUserId;

    app.addHook('onError', async (req, _reply, error) => {
      const c = captured.get(req) ?? {};
      c.error = error;
      captured.set(req, c);
    });

    app.addHook('onSend', async (req, _reply, payload) => {
      const c = captured.get(req) ?? {};
      c.payload = payload;
      captured.set(req, c);
      return payload;
    });

    app.addHook('onResponse', async (req, reply) => {
      try {
        const path = req.url.split('?')[0] ?? req.url;
        if (shouldIgnore(path, cfg.ignorePaths)) return;
        const c = captured.get(req) ?? {};
        captured.delete(req);
        const status = reply.statusCode;
        const error = req.monitor?.error ?? (status >= 500 && c.error ? toMonitorError(c.error) : null);
        const isError = status >= 500 || error !== null;
        if (!monitor.wants(isError)) return;
        const reqType = String(req.headers['content-type'] ?? '');
        const resType = String(reply.getHeader('content-type') ?? '');
        const meta = opts.meta?.(req, reply);
        monitor.push({
          ts: new Date(Date.now() - reply.elapsedTime).toISOString(),
          level: isError ? 'error' : status >= 400 ? 'warn' : 'info',
          kind: 'http',
          traceId: req.id ? String(req.id) : null,
          request: {
            method: req.method,
            path,
            pathTemplate: req.routeOptions.url ?? '(no route)',
            query: maskDeep(req.query, cfg.maskFields),
            ...prepareBody(maskDeep(requestBody(req.body, reqType, cfg.bodyMaxBytes), cfg.maskFields), isError, cfg, reqType),
            headers: pickHeaders(req.headers as Record<string, unknown>),
            ip: clientIp(req),
            userId: (await userId(req)) ?? null,
          },
          actions: req.monitor?.actions ?? [],
          response: {
            status,
            ...prepareBody(responseBody(c.payload, isError, resType, cfg.bodyMaxBytes, cfg.maskFields), isError, cfg, resType),
            durationMs: Math.round(reply.elapsedTime),
          },
          error,
          ...(meta ? { meta } : {}),
        });
      } catch (err) {
        // 任何例外都不能影響服務
        app.log.warn({ err: (err as Error).message }, '[giganexus-monitor] 組裝紀錄失敗');
      }
    });
  }

  if (opts.register !== false) {
    if (!opts.env) throw new Error('setupGateway:自動註冊需要 env(或設定 register: false)');
    const env = opts.env;
    const specOf = opts.register?.spec ?? (() => (app as unknown as { swagger?: () => object }).swagger?.());
    app.addHook('onListen', async () => {
      // 背景執行:重試期間(最長約 30 秒)不阻擋服務
      void (async () => {
        try {
          const spec = specOf();
          if (!spec) {
            app.log.error('找不到 OpenAPI 規格(未註冊 @fastify/swagger 且未提供 register.spec),略過自動註冊');
            return;
          }
          await autoRegister({ env, spec, log: app.log });
        } catch (err) {
          app.log.error(
            err instanceof GatewayError ? { code: err.code, status: err.status, requestId: err.requestId, details: err.details } : { err },
            'API 自動註冊失敗,Gateway 路由未更新',
          );
        }
      })();
    });
  }

  app.addHook('onClose', async () => {
    await monitor.shutdown();
  });
}

// 不封裝:hook 與 decorator 對整個 app 生效(同 fastify-plugin)
(setupGatewayPlugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
(setupGatewayPlugin as unknown as Record<symbol, unknown>)[Symbol.for('fastify.display-name')] = 'giganexus-setup-gateway';

export const setupGateway = setupGatewayPlugin;
