/** web-kit 前端監控的純邏輯(MONITORING-PLAN W9-9) */
import { describe, expect, it } from 'vitest';
import { rate, WebMonitorCore, type WebEvent } from '../../../web-kit/src/monitor-core.js';

const ev = (o: Partial<WebEvent> = {}): WebEvent => ({
  app: 'itapp-web',
  type: 'error',
  ts: '2026-10-06T00:00:00Z',
  page: '/it/',
  name: 'TypeError',
  message: 'x',
  ...o,
});

describe('Web Vitals 分級', () => {
  it('依 web.dev 門檻分 good / needs-improvement / poor', () => {
    expect(rate('LCP', 2500)).toBe('good');
    expect(rate('LCP', 3000)).toBe('needs-improvement');
    expect(rate('INP', 600)).toBe('poor');
    expect(rate('CLS', 0.05)).toBe('good');
    expect(rate('unknown', 1)).toBeUndefined();
  });
});

describe('WebMonitorCore', () => {
  it('同一錯誤每頁最多 5 次;不同錯誤各自計算;view / vital 不去重', () => {
    const sent: WebEvent[][] = [];
    const core = new WebMonitorCore((e) => sent.push(e));
    for (let i = 0; i < 8; i++) core.push(ev());
    core.push(ev({ message: 'y' }));
    for (let i = 0; i < 3; i++) core.push(ev({ type: 'view', name: undefined, message: undefined }));
    core.flush(true);
    const all = sent.flat();
    expect(all.filter((e) => e.type === 'error' && e.message === 'x')).toHaveLength(5);
    expect(all.filter((e) => e.message === 'y')).toHaveLength(1);
    expect(all.filter((e) => e.type === 'view')).toHaveLength(3);
  });

  it('滿 20 筆自動送出;每頁最多 200 筆', () => {
    const sent: WebEvent[][] = [];
    const core = new WebMonitorCore((e) => sent.push(e));
    for (let i = 0; i < 25; i++) core.push(ev({ type: 'view' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(20);
    expect(core.pending).toBe(5);
    for (let i = 0; i < 300; i++) core.push(ev({ type: 'view' }));
    core.flush(true);
    expect(sent.flat()).toHaveLength(200);
  });

  it('API 失敗以方法 + 路徑 + 狀態碼去重', () => {
    const sent: WebEvent[][] = [];
    const core = new WebMonitorCore((e) => sent.push(e));
    for (let i = 0; i < 7; i++) core.push(ev({ type: 'api', url: '/api/admin/roles', status: 502 }));
    for (let i = 0; i < 2; i++) core.push(ev({ type: 'api', url: '/api/admin/roles', status: 0 }));
    core.flush(true);
    expect(sent.flat()).toHaveLength(7);
  });
});
