/**
 * 韌性與限流(最後執行:會暫停 Redis、觸發斷路器)
 *   - dynamic-routing.feature「斷路器」
 *   - release-publish.feature「Redis 不可用時既有路由仍可服務」
 *   - nginx-entry.feature「登入 API 套用較嚴格的來源 IP 限流」
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearLoginFails, closeAll, compose, login, Session, sleep } from './gw.js';

let s: Session;
beforeAll(async () => {
  await clearLoginFails('S112009');
  s = (await login('S112009')).s;
});
afterAll(async () => {
  await compose('start', 'redis').catch(() => undefined);
  await closeAll();
});

describe('Redis 不可用', () => {
  it('既有路由以記憶體路由樹正常轉發,權限退回資料庫查詢', async () => {
    await compose('stop', 'redis');
    try {
      const res = await s.get('/api/mes/work-orders/1003');
      expect(res.status).toBe(200);
      expect(res.json.id).toBe('1003');
      // 需要權限的路由仍正確判斷
      expect((await s.get('/api/portal/news')).status).toBe(200);
    } finally {
      await compose('start', 'redis');
    }
    await sleep(2000);
    expect((await s.get('/api/mes/work-orders/1003')).status).toBe(200);
  });
});

describe('斷路器', () => {
  it('上游連續失敗達閾值(10)後短路回 503 UPSTREAM_UNAVAILABLE', async () => {
    const codes: number[] = [];
    // 兩個 BFF 實例各自維護斷路器,輪流分配 → 最多約 2 × 10 次後兩邊都開啟
    for (let i = 0; i < 30; i++) codes.push((await s.get('/api/mes/debug/fail')).status);
    expect(codes.slice(0, 10).every((c) => c === 502)).toBe(true);
    expect(codes.slice(-4)).toEqual([503, 503, 503, 503]);
    // 同一上游的其他路由也被短路(使用不快取的路由;有 GET 快取者在快取期間仍可回應)
    const res = await s.get('/api/mes/work-orders?page=2');
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('Nginx 登入限流', () => {
  it('同一來源 IP 短時間大量呼叫 /api/auth/login → 429 RATE_LIMITED(Nginx 統一 JSON)', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => new Session().post('/api/auth/login', {}, { noRetry: true })));
    const limited = results.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]!.json).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited[0]!.json.requestId).toMatch(/^[0-9a-f]{32}$/);
  });
});
