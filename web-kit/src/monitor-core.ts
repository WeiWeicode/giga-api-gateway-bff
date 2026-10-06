/**
 * 前端監控的純邏輯(不依賴瀏覽器與 Vue,可單元測試):事件型別、Web Vitals 分級、佇列(去重、上限、批次)。
 * 瀏覽器端的收集見 monitor.ts(MONITORING-PLAN W9-9)。
 */
export type WebEventType = 'error' | 'api' | 'vital' | 'view';

export interface WebEvent {
  app: string;
  type: WebEventType;
  ts: string;
  page: string;
  route?: string | null;
  release?: string | null;
  name?: string;
  message?: string;
  stack?: string;
  value?: number;
  rating?: 'good' | 'needs-improvement' | 'poor';
  method?: string;
  url?: string;
  status?: number;
  requestId?: string | null;
  durationMs?: number;
}

/** Web Vitals 分級門檻(web.dev 建議值;load 為本專案自訂) */
const THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
  load: [3000, 6000],
};

export function rate(name: string, value: number): WebEvent['rating'] {
  const t = THRESHOLDS[name];
  if (!t) return undefined;
  return value <= t[0] ? 'good' : value <= t[1] ? 'needs-improvement' : 'poor';
}

const MAX_PER_SIGNATURE = 5;
const MAX_PER_PAGE = 200;
const BATCH = 20;

/**
 * 佇列:同一錯誤每頁最多 5 次、每頁最多 200 筆、滿 20 筆送出
 */
export class WebMonitorCore {
  private queue: WebEvent[] = [];
  private seen = new Map<string, number>();
  private count = 0;

  constructor(private readonly send: (events: WebEvent[], final: boolean) => void) {}

  get pending(): number {
    return this.queue.length;
  }

  push(e: WebEvent): boolean {
    if (this.count >= MAX_PER_PAGE) return false;
    if (e.type === 'error' || e.type === 'api') {
      const sig = `${e.type}|${e.name ?? ''}|${e.message ?? ''}|${e.url ?? ''}|${e.status ?? ''}`;
      const n = (this.seen.get(sig) ?? 0) + 1;
      this.seen.set(sig, n);
      if (n > MAX_PER_SIGNATURE) return false;
    }
    this.count += 1;
    this.queue.push(e);
    if (this.queue.length >= BATCH) this.flush(false);
    return true;
  }

  flush(final: boolean): void {
    while (this.queue.length) this.send(this.queue.splice(0, BATCH), final);
  }
}
