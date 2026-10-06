/**
 * HTTP client(FRONTEND-GUIDE.md §6.2–§6.4):
 *   - 同網域相對路徑 /api/...,Cookie 由瀏覽器自動帶上;前端不接觸 Token
 *   - 非 GET/HEAD/OPTIONS 帶 X-CSRF-Token(= gn_csrf Cookie)
 *   - 401 → 先 Refresh 一次(多個請求共用同一次),失敗才導向 /login?redirect=...
 *   - 錯誤統一為 ApiError { status, code, message, requestId, details }
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * 遇 401 不做 Refresh 的端點(登入、換發、登出、註冊驗證、密碼變更 / 忘記 / 重設)。
 * /api/auth/me 不在此列:Access Token 過期或權限版本遞增後,換頁時第一個請求就是 me,必須先 Refresh 再重試。
 */
const NO_REFRESH = /^\/api\/auth\/(login|refresh|logout|register|password)(\/|\?|$)/;

export function readCookie(name: string): string | undefined {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined;
}

export function redirectToLogin(): void {
  const back = encodeURIComponent(location.pathname + location.search);
  location.href = `/login?redirect=${back}`;
}

let refreshing: Promise<boolean> | null = null;

/** 以 gn_rt 換發新 Token;同時間多個 401 共用同一次 Refresh */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: csrfHeader() })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

function csrfHeader(): Record<string, string> {
  const token = readCookie('gn_csrf');
  return token ? { 'X-CSRF-Token': token } : {};
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** 預設遇 401 且 Refresh 失敗時導向登入頁;登入頁本身設 false */
  redirectOnAuthFailure?: boolean;
  signal?: AbortSignal;
}

/** API 失敗(網路錯誤 status = 0,或 5xx);前端監控(monitor.ts)以此回報,帶 X-Request-Id 對到後端紀錄 */
export interface ApiFailure {
  method: string;
  url: string;
  status: number;
  requestId: string | null;
  durationMs: number;
  message: string;
}

let apiFailureHook: ((f: ApiFailure) => void) | null = null;

export function setApiFailureHook(fn: ((f: ApiFailure) => void) | null): void {
  apiFailureHook = fn;
}

function notifyFailure(f: ApiFailure): void {
  try {
    apiFailureHook?.(f);
  } catch {
    // 監控不能影響呼叫端
  }
}

export async function request<T = unknown>(method: string, url: string, body?: unknown, opts: RequestOptions = {}, retried = false): Promise<T> {
  const m = method.toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json', ...(SAFE.has(m) ? {} : csrfHeader()), ...opts.headers };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(url, { method: m, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    if ((err as Error)?.name !== 'AbortError')
      notifyFailure({ method: m, url, status: 0, requestId: null, durationMs, message: (err as Error)?.message ?? String(err) });
    throw err;
  }
  if (res.status >= 500) {
    const durationMs = Math.round(performance.now() - started);
    notifyFailure({ method: m, url, status: res.status, requestId: res.headers.get('X-Request-Id'), durationMs, message: res.statusText });
  }

  if (res.status === 401 && !retried && !NO_REFRESH.test(url)) {
    if (await refreshSession()) return request<T>(method, url, body, opts, true);
    if (opts.redirectOnAuthFailure !== false) redirectToLogin();
  }
  const requestId = res.headers.get('X-Request-Id');
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (data ?? {}) as { code?: string; message?: string; requestId?: string; details?: unknown };
    throw new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? res.statusText, e.requestId ?? requestId, e.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const http = {
  get: <T = unknown>(url: string, opts?: RequestOptions) => request<T>('GET', url, undefined, opts),
  post: <T = unknown>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', url, body, opts),
  put: <T = unknown>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', url, body, opts),
  patch: <T = unknown>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', url, body, opts),
  delete: <T = unknown>(url: string, opts?: RequestOptions) => request<T>('DELETE', url, undefined, opts),
};
