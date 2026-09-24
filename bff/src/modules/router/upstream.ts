/**
 * 上游呼叫(PRD §8.4.2 步驟 3、5):
 *   - undici 連線池(每個 target 一個,keepalive)
 *   - 逾時 → 504 UPSTREAM_TIMEOUT;冪等方法遇連線錯誤重試 retry_count 次;非冪等不重試
 *   - 斷路器:連續失敗達 circuit_fail_threshold 即短路 30 秒,之後放行一個試探請求(半開)
 *   - 上游 5xx / 401 → 502 UPSTREAM_ERROR(401 視為金鑰或 aud 設定錯誤並告警)
 * 斷路器狀態由各實例在記憶體中維護。
 */
import type { IncomingHttpHeaders } from 'node:http';
import { errors as undiciErrors, Pool, type Dispatcher } from 'undici';
import { GwError } from '../../errors.js';
import type { SnapshotUpstream } from './snapshot.js';

export const CIRCUIT_OPEN_MS = 30_000;
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

export interface UpstreamRequest {
  method: string;
  path: string; // 含 query
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
}

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Dispatcher.ResponseData['body'];
}

class CircuitBreaker {
  private fails = 0;
  private openUntil = 0;
  private probing = false;

  constructor(readonly threshold: number) {}

  /** 回傳是否允許送出;半開時只放行一個試探 */
  allow(now = Date.now()): boolean {
    if (this.openUntil === 0) return true;
    if (now < this.openUntil || this.probing) return false;
    this.probing = true;
    return true;
  }

  success(): void {
    this.fails = 0;
    this.openUntil = 0;
    this.probing = false;
  }

  failure(now = Date.now()): boolean {
    this.probing = false;
    this.fails++;
    if (this.fails >= this.threshold) {
      const wasOpen = this.openUntil !== 0;
      this.openUntil = now + CIRCUIT_OPEN_MS;
      return !wasOpen;
    }
    return false;
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.openUntil === 0) return 'closed';
    return Date.now() < this.openUntil ? 'open' : 'half-open';
  }
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED'].includes(code);
}

function isTimeout(err: unknown): boolean {
  return err instanceof undiciErrors.HeadersTimeoutError || err instanceof undiciErrors.BodyTimeoutError;
}

export class UpstreamClient {
  private readonly pools = new Map<string, Pool>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly rr = new Map<string, number>();

  constructor(private readonly log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void }) {}

  private pool(baseUrl: string): Pool {
    const origin = new URL(baseUrl).origin;
    let p = this.pools.get(origin);
    if (!p) {
      p = new Pool(origin, { connections: 128, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connect: { timeout: 3_000 } });
      this.pools.set(origin, p);
    }
    return p;
  }

  private breaker(up: SnapshotUpstream): CircuitBreaker {
    let b = this.breakers.get(up.code);
    if (!b || b.threshold !== up.circuitFailThreshold) {
      b = new CircuitBreaker(up.circuitFailThreshold);
      this.breakers.set(up.code, b);
    }
    return b;
  }

  /** 加權輪詢選擇 target */
  private target(up: SnapshotUpstream): { baseUrl: string } {
    const expanded = up.targets.flatMap((t) => Array<typeof t>(Math.max(1, t.weight)).fill(t));
    if (!expanded.length) throw new GwError('UPSTREAM_UNAVAILABLE', '上游沒有可用的實例');
    const i = (this.rr.get(up.code) ?? 0) % expanded.length;
    this.rr.set(up.code, i + 1);
    return expanded[i]!;
  }

  breakerStates(): Record<string, string> {
    return Object.fromEntries([...this.breakers].map(([k, b]) => [k, b.state]));
  }

  async request(up: SnapshotUpstream, req: UpstreamRequest): Promise<UpstreamResponse> {
    const breaker = this.breaker(up);
    if (!breaker.allow()) throw new GwError('UPSTREAM_UNAVAILABLE');

    const attempts = 1 + (IDEMPOTENT.has(req.method) ? up.retryCount : 0);
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      const t = this.target(up);
      const basePath = new URL(t.baseUrl).pathname.replace(/\/$/, '');
      try {
        const res = await this.pool(t.baseUrl).request({
          method: req.method as 'GET',
          path: basePath + req.path,
          headers: req.headers,
          body: req.body && req.body.length ? req.body : undefined,
          headersTimeout: req.timeoutMs,
          bodyTimeout: req.timeoutMs,
        });
        if (res.statusCode >= 500) {
          res.body.resume();
          this.onFailure(up, breaker, `HTTP ${res.statusCode}`);
          throw new GwError('UPSTREAM_ERROR');
        }
        if (res.statusCode === 401) {
          res.body.resume();
          breaker.success();
          this.log.error({ upstream: up.code }, '上游回應 401:內部 Token 驗證失敗(金鑰或 aud 設定錯誤)');
          throw new GwError('UPSTREAM_ERROR');
        }
        breaker.success();
        return { status: res.statusCode, headers: res.headers as IncomingHttpHeaders, body: res.body };
      } catch (err) {
        if (err instanceof GwError) throw err;
        lastErr = err;
        if (isTimeout(err)) {
          this.onFailure(up, breaker, 'timeout');
          throw new GwError('UPSTREAM_TIMEOUT');
        }
        if (!isConnectionError(err) || i === attempts - 1) break;
        this.log.warn({ upstream: up.code, attempt: i + 1, err: (err as Error).message }, '上游連線錯誤,重試');
      }
    }
    this.onFailure(up, breaker, (lastErr as Error)?.message ?? 'error');
    throw new GwError('UPSTREAM_ERROR');
  }

  private onFailure(up: SnapshotUpstream, breaker: CircuitBreaker, reason: string): void {
    if (breaker.failure()) this.log.error({ upstream: up.code, reason, openMs: CIRCUIT_OPEN_MS }, '斷路器開啟');
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.close()));
  }
}
