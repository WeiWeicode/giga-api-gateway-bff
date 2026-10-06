/**
 * 前端健康度監測(MONITORING-PLAN D5、W9-9):
 *
 *   import { installMonitor } from '@giganexus/web-kit'
 *   installMonitor({ app: 'itapp-web', router, vueApp: app })     // main.ts,app.mount 之前
 *
 * 回報到 BFF POST /api/telemetry/web(BFF 補上 IP、使用者後轉送 giga-observe),app = giga-observe 拓樸中的前端服務代碼。
 *   error  JS 錯誤(window error、unhandledrejection、Vue errorHandler、資源載入失敗)
 *   api    API 失敗:網路錯誤或 5xx(帶 X-Request-Id,可在架構觀測頁對到後端同一請求)
 *   vital  效能:LCP、INP、CLS、FCP、TTFB、載入時間(依 vitalsSampleRate 抽樣,預設 10%)
 *   view   換頁(錯誤率的分母)
 *
 * 鐵則(與後端 SDK 相同):監控不能影響頁面。批次送出、sendBeacon、同一錯誤每頁最多 5 次、每頁最多 200 筆、任何例外都吞掉。
 */
import type { App } from 'vue';
import type { Router } from 'vue-router';
import { setApiFailureHook } from './http';
import { rate, WebMonitorCore, type WebEvent, type WebEventType } from './monitor-core';

export { rate, WebMonitorCore } from './monitor-core';
export type { WebEvent, WebEventType } from './monitor-core';

export interface WebMonitorOptions {
  /** 前端服務代碼(giga-observe 拓樸 type = frontend),例 itapp-web */
  app: string;
  router?: Router;
  vueApp?: App;
  /** 版本(例 CI 的 commit SHA),錯誤明細會顯示 */
  release?: string;
  /** 預設 /api/telemetry/web */
  endpoint?: string;
  /** 效能資料抽樣比例,預設 0.1;錯誤一律回報 */
  vitalsSampleRate?: number;
  /** false 時不安裝(例:本機開發) */
  enabled?: boolean;
}

const FLUSH_MS = 5000;
const trim = (s: unknown, max: number) => (typeof s === 'string' ? s.slice(0, max) : undefined);

let installed: { core: WebMonitorCore; stop: () => void } | null = null;

export function installMonitor(opts: WebMonitorOptions): { stop: () => void } {
  if (opts.enabled === false || typeof window === 'undefined') return { stop: () => undefined };
  if (installed) return installed;
  const endpoint = opts.endpoint ?? '/api/telemetry/web';
  const sampled = Math.random() < (opts.vitalsSampleRate ?? 0.1);
  const cleanups: (() => void)[] = [];

  const send = (events: WebEvent[], final: boolean) => {
    try {
      const body = JSON.stringify({ events });
      // text/plain:sendBeacon 的「簡單」內容類型;BFF 兩種都接受
      if (final && navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'text/plain' }))) return;
      void fetch(endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true }).catch(
        () => undefined,
      );
    } catch {
      // 監控本身不能出錯
    }
  };
  const core = new WebMonitorCore(send);

  const routeOf = () => {
    const r = opts.router?.currentRoute.value;
    return r?.matched.length ? (r.matched[r.matched.length - 1]?.path ?? null) : null;
  };
  const base = (type: WebEventType): WebEvent => ({
    app: opts.app,
    type,
    ts: new Date().toISOString(),
    page: location.pathname,
    route: routeOf(),
    release: opts.release ?? null,
  });
  const reportError = (err: unknown, extra: Partial<WebEvent> = {}) => {
    try {
      const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
      core.push({
        ...base('error'),
        name: trim(e?.name, 100) ?? 'Error',
        message: trim(e?.message, 2000) ?? trim(String(err), 2000),
        stack: trim(e?.stack, 8000),
        ...extra,
      });
    } catch {
      // 忽略
    }
  };

  // JS 錯誤與資源載入失敗(capture 階段才收得到 <script> / <link> 的 error)
  const onError = (ev: Event) => {
    if (ev instanceof ErrorEvent)
      return reportError(ev.error ?? { name: 'Error', message: ev.message }, ev.error ? {} : { stack: `${ev.filename}:${ev.lineno}:${ev.colno}` });
    const t = ev.target as (HTMLElement & { src?: string; href?: string }) | null;
    if (t && t !== (window as unknown as EventTarget) && (t.tagName === 'SCRIPT' || t.tagName === 'LINK' || t.tagName === 'IMG'))
      reportError({ name: 'ResourceError', message: `${t.tagName.toLowerCase()} 載入失敗:${t.src || t.href || ''}` });
  };
  const onRejection = (ev: PromiseRejectionEvent) => {
    // web-kit http 的 ApiError 已由 API 失敗回報處理,這裡不重複
    if ((ev.reason as { name?: string } | null)?.name === 'ApiError') return;
    reportError(ev.reason ?? { name: 'UnhandledRejection', message: '(無內容)' });
  };
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  cleanups.push(
    () => window.removeEventListener('error', onError, true),
    () => window.removeEventListener('unhandledrejection', onRejection),
  );

  if (opts.vueApp) {
    const prev = opts.vueApp.config.errorHandler;
    opts.vueApp.config.errorHandler = (err, instance, info) => {
      reportError(err, { message: `${trim((err as Error)?.message, 1900) ?? String(err)}(${info})` });
      if (prev) prev(err, instance, info);
      else console.error(err);
    };
  }

  // API 失敗(網路錯誤或 5xx)
  setApiFailureHook((f) => {
    if (f.url.startsWith(endpoint)) return;
    const name = f.status ? `HTTP ${f.status}` : 'NetworkError';
    core.push({
      ...base('api'),
      method: f.method,
      url: f.url.split('?')[0],
      status: f.status,
      requestId: f.requestId,
      durationMs: f.durationMs,
      name,
      message: trim(f.message, 500),
    });
  });
  cleanups.push(() => setApiFailureHook(null));

  // 換頁(錯誤率的分母)
  if (opts.router) {
    const remove = opts.router.afterEach((to, _from, failure) => {
      if (!failure)
        core.push({ ...base('view'), page: location.pathname, route: to.matched.length ? (to.matched[to.matched.length - 1]?.path ?? null) : null });
    });
    cleanups.push(remove);
  } else core.push(base('view'));

  // 效能(抽樣):頁面隱藏時送出最終值
  const vitals: Record<string, number> = {};
  if (sampled && typeof PerformanceObserver !== 'undefined') {
    const observe = (type: string, cb: (entries: PerformanceEntryList) => void, extra: Record<string, unknown> = {}) => {
      try {
        const po = new PerformanceObserver((list) => cb(list.getEntries()));
        po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
        cleanups.push(() => po.disconnect());
      } catch {
        // 瀏覽器不支援此類型
      }
    };
    observe('largest-contentful-paint', (es) => {
      const last = es[es.length - 1];
      if (last) vitals.LCP = last.startTime;
    });
    observe('paint', (es) => {
      for (const e of es) if (e.name === 'first-contentful-paint') vitals.FCP = e.startTime;
    });
    observe('layout-shift', (es) => {
      for (const e of es) {
        const ls = e as unknown as { hadRecentInput: boolean; value: number };
        if (!ls.hadRecentInput) vitals.CLS = (vitals.CLS ?? 0) + ls.value;
      }
    });
    // INP 近似:頁面期間最慢的一次互動
    observe(
      'event',
      (es) => {
        for (const e of es) if ((e as unknown as { interactionId?: number }).interactionId) vitals.INP = Math.max(vitals.INP ?? 0, e.duration);
      },
      { durationThreshold: 40 },
    );
    const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      vitals.TTFB = nav.responseStart;
      const setLoad = () => {
        if (nav.loadEventEnd > 0) vitals.load = nav.loadEventEnd;
      };
      if (document.readyState === 'complete') setLoad();
      else window.addEventListener('load', () => setTimeout(setLoad, 0), { once: true });
    }
  }
  let vitalsSent = false;
  const flushVitals = () => {
    if (vitalsSent || !sampled) return;
    vitalsSent = true;
    for (const [name, value] of Object.entries(vitals)) {
      const v = name === 'CLS' ? Math.round(value * 1000) / 1000 : Math.round(value);
      core.push({ ...base('vital'), name, value: v, rating: rate(name, v) });
    }
  };

  const timer = setInterval(() => core.flush(false), FLUSH_MS);
  const onHide = () => {
    if (document.visibilityState !== 'hidden') return;
    flushVitals();
    core.flush(true);
  };
  const onPageHide = () => {
    flushVitals();
    core.flush(true);
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  cleanups.push(
    () => clearInterval(timer),
    () => document.removeEventListener('visibilitychange', onHide),
    () => window.removeEventListener('pagehide', onPageHide),
  );

  installed = {
    core,
    stop: () => {
      cleanups.forEach((c) => c());
      core.flush(true);
      installed = null;
    },
  };
  return installed;
}
