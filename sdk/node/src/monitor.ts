/**
 * API 監控回報(MONITORING-PLAN.md §5.2;移植自 DevOpsDiagram devops-reporter,資料格式相同):
 *   送到 giga-observe 的 Ingest API(POST /api/v1/ingest/logs、POST /api/v1/heartbeat),serviceId 由 API Key 決定。
 *
 * 鐵則(監控壞掉不能拖累被監控的服務):
 *   1. 非同步:紀錄進記憶體佇列,不在請求路徑上等網路
 *   2. 送出逾時 1 秒
 *   3. 送不出去保留重送,緩衝滿了丟最舊的;這是全 SDK 唯一允許靜默失敗(只 warn)的地方
 *
 * 設定(環境變數,loadMonitorEnv):
 *   MONITOR_URL                giga-observe 位址,例 http://gno-backend:5132(各部署區各一套,不可跨區)
 *   MONITOR_API_KEY_FILE       Ingest API Key 檔案(Docker secret);dev 可改用 MONITOR_API_KEY。正式區只接受 _FILE
 *   MONITOR_ENABLED            true / false;預設 test、prod 開啟,dev 關閉(與自動註冊一致)
 */
import { readFileSync } from 'node:fs';
import { GatewayEnvError, type GwEnv } from './env.js';

export interface MonitorEnv {
  enabled: boolean;
  endpoint: string | null;
  apiKey: string | null;
}

export interface MonitorAction {
  seq: number;
  type: string;
  target: string;
  durationMs: number | null;
  note: string;
  ok: boolean;
}

export interface MonitorError {
  name: string;
  message: string;
  stack: string;
  code: string | null;
}

/** 單筆紀錄(giga-observe API_CONTRACT §2.1) */
export interface MonitorLog {
  ts: string;
  level: 'info' | 'warn' | 'error';
  kind: 'http' | 'job';
  /** Gateway 的 X-Request-Id;BFF、Nginx、後端同一請求以此串接 */
  traceId: string | null;
  request: {
    method: string;
    path: string;
    pathTemplate: string;
    query: unknown;
    body: unknown;
    bodySize: number;
    bodyTruncated: boolean;
    headers: Record<string, unknown>;
    ip: string | null;
    userId: string | null;
  };
  actions: MonitorAction[];
  response: { status: number; body: unknown; bodySize: number; bodyTruncated: boolean; durationMs: number };
  error: MonitorError | null;
  /** 附加標籤(例:BFF 的 routeCode、upstream);giga-observe 存在 meta,可篩選 */
  meta?: Record<string, string | number | boolean | null>;
}

export interface DepStatus {
  name: string;
  ok: boolean;
  latencyMs: number | null;
}

export interface MonitorOptions {
  endpoint: string | null;
  apiKey: string | null;
  enabled?: boolean;
  flushIntervalMs?: number;
  batchSize?: number;
  bufferSize?: number;
  timeoutMs?: number;
  /** 心跳間隔秒數;0 = 不送 */
  heartbeatSec?: number;
  /** 不記錄的路徑(前綴或 RegExp) */
  ignorePaths?: (string | RegExp)[];
  /** 只記錄錯誤 */
  errorOnly?: boolean;
  /** 成功請求的抽樣比例(0–1);錯誤永遠 100% */
  sampleRate?: number;
  /** 額外遮罩的欄位名稱 */
  maskFields?: string[];
  bodySummaryBytes?: number;
  bodyMaxBytes?: number;
  version?: string | null;
  /** 心跳時回報的相依服務狀態 */
  deps?: (() => Promise<DepStatus[]>) | null;
  /** 預設 console.warn */
  warn?: (msg: string) => void;
  /** 測試用:替換 fetch */
  fetch?: typeof fetch;
}

const DEFAULTS = {
  flushIntervalMs: 5000,
  batchSize: 50,
  bufferSize: 500,
  timeoutMs: 1000,
  heartbeatSec: 30,
  ignorePaths: ['/healthz', '/readyz', '/metrics', '/favicon.ico'] as (string | RegExp)[],
  errorOnly: false,
  sampleRate: 1,
  maskFields: [] as string[],
  bodySummaryBytes: 1024,
  bodyMaxBytes: 32768,
  version: null as string | null,
};

const SENSITIVE = ['password', 'passwd', 'token', 'authorization', 'apikey', 'secret', 'credential', 'cookie'];
const HEADER_ALLOWLIST = ['content-type', 'user-agent', 'referer', 'x-request-id'];
/** 單次遮罩處理的節點上限:結構再離譜,成本都有天花板 */
const MAX_NODES = 5000;

/** 讀取監控設定;未設定 MONITOR_URL 時視為停用(不報錯,監控不是服務的必要條件) */
export function loadMonitorEnv(gwEnv: GwEnv, env: NodeJS.ProcessEnv = process.env): MonitorEnv {
  let endpoint: string | null = null;
  if (env.MONITOR_URL) {
    try {
      endpoint = new URL(env.MONITOR_URL).toString().replace(/\/$/, '');
    } catch {
      throw new GatewayEnvError(`MONITOR_URL 不是合法的 URL:${env.MONITOR_URL}`);
    }
  }
  if (gwEnv === 'prod' && env.MONITOR_API_KEY) throw new GatewayEnvError('正式區不可用 MONITOR_API_KEY 明文設定,請改用 MONITOR_API_KEY_FILE(Docker secret)');
  let apiKey = env.MONITOR_API_KEY ?? null;
  if (env.MONITOR_API_KEY_FILE) {
    try {
      apiKey = readFileSync(env.MONITOR_API_KEY_FILE, 'utf8').trim();
    } catch (err) {
      throw new GatewayEnvError(`無法讀取 MONITOR_API_KEY_FILE:${(err as Error).message}`);
    }
  }
  const flag = env.MONITOR_ENABLED?.toLowerCase();
  const wanted = flag === undefined || flag === '' ? gwEnv !== 'dev' : flag === 'true' || flag === '1';
  return { enabled: wanted && !!endpoint && !!apiKey, endpoint, apiKey };
}

function isSensitiveKey(key: string, extra: string[]): boolean {
  const lower = key.toLowerCase().replace(/[-_]/g, '');
  if (SENSITIVE.some((p) => lower.includes(p))) return true;
  return extra.some((f) => f.toLowerCase() === key.toLowerCase());
}

/**
 * 遞迴遮罩敏感欄位。三道保護缺一不可(沿用 devops-reporter 踩過的坑):
 *  1. 先呼叫 toJSON():ORM model 直接列舉屬性會挖出內部結構與循環參考
 *  2. 循環參考偵測
 *  3. 節點預算
 */
export function maskDeep(value: unknown, extra: string[] = [], depth = 0, ctx?: { seen: WeakSet<object>; nodes: number }): unknown {
  const c = ctx ?? { seen: new WeakSet<object>(), nodes: 0 };
  if (depth > 12 || value === null || value === undefined || typeof value !== 'object') return value;
  if (c.nodes++ > MAX_NODES) return '[truncated: too large]';
  // Buffer 也有 toJSON(會變成位元組陣列),要在 toJSON 之前處理
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  let v: unknown = value;
  const toJSON = (v as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    try {
      v = toJSON.call(v);
    } catch {
      return '[unserializable]';
    }
    if (v === null || typeof v !== 'object') return v;
  }
  const obj = v as object;
  if (c.seen.has(obj)) return '[circular]';
  c.seen.add(obj);
  if (Array.isArray(obj)) return obj.map((x) => maskDeep(x, extra, depth + 1, c));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(obj)) out[k] = isSensitiveKey(k, extra) ? '***' : maskDeep(x, extra, depth + 1, c);
  return out;
}

export function pickHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) if (HEADER_ALLOWLIST.includes(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
}

function safeStringify(value: unknown): string | null {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** 成功存摘要(前 1 KB)、錯誤存完整(32 KB 截斷);檔案上傳只記大小 */
export function prepareBody(
  body: unknown,
  isError: boolean,
  limits: { bodySummaryBytes: number; bodyMaxBytes: number },
  contentType?: string | null,
): { body: unknown; bodySize: number; bodyTruncated: boolean } {
  if (body === null || body === undefined || body === '') return { body: null, bodySize: 0, bodyTruncated: false };
  const str = safeStringify(body);
  if (contentType?.includes('multipart/form-data')) return { body: '[multipart]', bodySize: str ? Buffer.byteLength(str) : 0, bodyTruncated: false };
  if (str === null) return { body: '[unserializable]', bodySize: 0, bodyTruncated: false };
  const size = Buffer.byteLength(str, 'utf8');
  const limit = isError ? limits.bodyMaxBytes : limits.bodySummaryBytes;
  if (size <= limit) return { body, bodySize: size, bodyTruncated: false };
  return { body: Buffer.from(str, 'utf8').subarray(0, limit).toString('utf8'), bodySize: size, bodyTruncated: true };
}

export function toMonitorError(err: unknown): MonitorError {
  const e = (err ?? {}) as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
  return {
    name: typeof e.name === 'string' ? e.name : 'Error',
    message: typeof e.message === 'string' ? e.message : String(err),
    stack: typeof e.stack === 'string' ? e.stack : '',
    code: typeof e.code === 'string' ? e.code : null,
  };
}

export function shouldIgnore(path: string, ignorePaths: (string | RegExp)[]): boolean {
  return ignorePaths.some((p) =>
    p instanceof RegExp ? p.test(path) : path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`) || path.startsWith(`${p}?`),
  );
}

/** 一次請求或排程執行中記錄的步驟(DB、外部 API…)與自報錯誤 */
export class MonitorScope {
  readonly actions: MonitorAction[] = [];
  error: MonitorError | null = null;

  action(type: string, target: string, durationMs?: number | null, note?: string, ok = true): void {
    this.actions.push({ seq: this.actions.length + 1, type: type || 'other', target: target || '', durationMs: durationMs ?? null, note: note ?? '', ok });
  }

  failedAction(type: string, target: string, durationMs?: number | null, note?: string): void {
    this.action(type, target, durationMs, note, false);
  }

  /** 自報錯誤:即使回應 2xx 也視為錯誤(永久保存) */
  fail(err: unknown, note?: string): void {
    this.error = toMonitorError(err);
    if (note) this.error.message += `(${note})`;
  }
}

export class Monitor {
  readonly cfg: Required<Omit<MonitorOptions, 'endpoint' | 'apiKey' | 'deps' | 'fetch' | 'warn'>> & {
    endpoint: string;
    apiKey: string;
    deps: MonitorOptions['deps'];
  };
  private buffer: MonitorLog[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private readonly startedAt = Date.now();
  private overflowWarned = false;
  private authWarned = false;
  private readonly warn: (msg: string) => void;
  private readonly doFetch: typeof fetch;

  constructor(opts: MonitorOptions) {
    this.warn = opts.warn ?? ((m) => console.warn(`[giganexus-monitor] ${m}`));
    this.doFetch = opts.fetch ?? fetch;
    const enabled = (opts.enabled ?? true) && !!opts.endpoint && !!opts.apiKey;
    this.cfg = {
      ...DEFAULTS,
      ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
      enabled,
      endpoint: (opts.endpoint ?? '').replace(/\/$/, ''),
      apiKey: opts.apiKey ?? '',
      deps: opts.deps ?? null,
    } as Monitor['cfg'];
    if (!enabled) return;
    this.flushTimer = setInterval(() => void this.flush(), this.cfg.flushIntervalMs);
    this.flushTimer.unref();
    if (this.cfg.heartbeatSec > 0) {
      void this.heartbeat();
      this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.cfg.heartbeatSec * 1000);
      this.heartbeatTimer.unref();
    }
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** 目前緩衝筆數(測試、除錯用) */
  get pending(): number {
    return this.buffer.length;
  }

  /** 是否要記錄這次請求:錯誤一律記錄,成功依 errorOnly / sampleRate */
  wants(isError: boolean): boolean {
    if (!this.cfg.enabled) return false;
    if (isError) return true;
    if (this.cfg.errorOnly) return false;
    return this.cfg.sampleRate >= 1 || Math.random() < this.cfg.sampleRate;
  }

  push(log: MonitorLog): void {
    if (!this.cfg.enabled) return;
    this.buffer.push(log);
    if (this.buffer.length > this.cfg.bufferSize) {
      this.buffer.shift();
      if (!this.overflowWarned) {
        this.warn('緩衝已滿,開始丟棄最舊的紀錄(giga-observe 無法連線?)');
        this.overflowWarned = true;
      }
    }
    if (this.buffer.length >= this.cfg.batchSize) void this.flush();
  }

  /** 送出緩衝;同一時間只有一個 flush 在跑 */
  flush(): Promise<void> {
    if (!this.cfg.enabled || this.buffer.length === 0) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        while (this.buffer.length) {
          const batch = this.buffer.splice(0, Math.min(this.cfg.batchSize, 100));
          const sent = await this.post('/api/v1/ingest/logs', { logs: batch });
          if (!sent) {
            // 送不出去放回前面,等下一輪重送
            this.buffer = batch.concat(this.buffer).slice(-this.cfg.bufferSize);
            return;
          }
          this.overflowWarned = false;
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  /** 回傳 true = 已送達或平台要求丟棄(429);false = 需重送 */
  private async post(path: string, payload: unknown): Promise<boolean> {
    try {
      const res = await this.doFetch(`${this.cfg.endpoint}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return true;
      if ((res.status === 401 || res.status === 403) && !this.authWarned) {
        this.warn(`giga-observe 認證失敗(${res.status}),請確認 MONITOR_API_KEY`);
        this.authWarned = true;
      }
      // 4xx(格式錯、認證錯)重送也沒用,直接丟棄;429 表示平台要求丟棄;5xx 重送
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async heartbeat(): Promise<void> {
    if (!this.cfg.enabled) return;
    let deps: DepStatus[] = [];
    if (this.cfg.deps) {
      try {
        deps = await this.cfg.deps();
      } catch {
        deps = [];
      }
    }
    await this.post('/api/v1/heartbeat', {
      ts: new Date().toISOString(),
      version: this.cfg.version,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      deps,
    });
  }

  /**
   * 排程工作回報(一次執行 = 一筆紀錄,DevOpsDiagram D-08):
   *   const job = monitor.job('employee-sync'); job.action('db', 'bpm.emp', 120); await job.success({ synced: 30 });
   */
  job(name: string, opts: { trigger?: string; cronExpr?: string | null; params?: Record<string, unknown> } = {}) {
    const startedAt = Date.now();
    const scope = new MonitorScope();
    const input = { trigger: opts.trigger ?? 'cron', cronExpr: opts.cronExpr ?? null, params: opts.params ?? {} };
    const finish = async (status: number, result: unknown, err?: unknown) => {
      if (!this.cfg.enabled) return;
      const error = err !== undefined ? toMonitorError(err) : scope.error;
      const isError = status >= 500 || error !== null;
      this.push({
        ts: new Date(startedAt).toISOString(),
        level: isError ? 'error' : 'info',
        kind: 'job',
        traceId: null,
        request: {
          method: 'JOB',
          path: name,
          pathTemplate: name,
          query: {},
          ...prepareBody(maskDeep(input, this.cfg.maskFields), true, this.cfg),
          headers: {},
          ip: null,
          userId: null,
        },
        actions: scope.actions,
        response: { status, ...prepareBody(maskDeep(result, this.cfg.maskFields), isError, this.cfg), durationMs: Date.now() - startedAt },
        error,
      });
      await this.flush();
    };
    return {
      action: scope.action.bind(scope),
      failedAction: scope.failedAction.bind(scope),
      success: (result?: unknown) => finish(200, result),
      fail: (err: unknown, result?: unknown) => finish(500, result, err),
    };
  }

  /** 關閉時盡力送出剩餘紀錄,最多等 3 秒 */
  async shutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.flushTimer = this.heartbeatTimer = null;
    if (!this.cfg.enabled || this.buffer.length === 0) return;
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 3000).unref())]);
  }
}
