/** web-kit 通知模組的純邏輯(NOTIFY-PLAN §6.5、W10-3) */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  DROP_WITH_CONTENT,
  filterStyle,
  isAllowedHref,
  isAllowedImageSrc,
  parseSocketMessage,
  presentationOf,
  reconnectDelay,
  removeAnnouncement,
  type FeedItem,
} from '../../../web-kit/src/notify-core.js';

describe('WebSocket 重連與訊息', () => {
  it('重連延遲 1、2、4… 秒,上限 30 秒,抖動不超過 20%', () => {
    const none = () => 0;
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((a) => reconnectDelay(a, none))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(reconnectDelay(0, () => 0.999)).toBeLessThanOrEqual(1200);
  });

  it('訊息格式不對回傳 null', () => {
    expect(parseSocketMessage('{"type":"revoked","announcementId":1}')).toEqual({ type: 'revoked', announcementId: 1 });
    expect(parseSocketMessage('not json')).toBeNull();
    expect(parseSocketMessage('{"x":1}')).toBeNull();
    expect(parseSocketMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe('提示方式', () => {
  const env = (hidden: boolean, permission: 'granted' | 'denied' | 'default' | 'unsupported' = 'granted') => ({ hidden, permission });

  it('緊急或需確認 → 對話框;其他 → Toast', () => {
    expect(presentationOf({ level: 'urgent' }, env(false))).toEqual({ dialog: true, toast: false, desktop: false });
    expect(presentationOf({ level: 'info', requireAck: true }, env(false)).dialog).toBe(true);
    expect(presentationOf({ level: 'important' }, env(false))).toEqual({ dialog: false, toast: true, desktop: false });
  });

  it('分頁在背景且已授權才跳桌面通知', () => {
    expect(presentationOf({ level: 'info' }, env(true)).desktop).toBe(true);
    expect(presentationOf({ level: 'info' }, env(true, 'default')).desktop).toBe(false);
    expect(presentationOf({ level: 'info' }, env(false)).desktop).toBe(false);
  });

  it('撤回只移除該則公告,不影響同 ID 的個人通知', () => {
    const items = [
      { kind: 'announcement', id: 1 },
      { kind: 'message', id: 1 },
      { kind: 'announcement', id: 2 },
    ] as FeedItem[];
    expect(removeAnnouncement(items, 1).map((i) => `${i.kind}:${i.id}`)).toEqual(['message:1', 'announcement:2']);
  });
});

describe('前端 HTML 白名單(與 BFF 相同)', () => {
  it('連結只接受 https、mailto、站內路徑', () => {
    for (const ok of ['https://www.gigasolar.com.tw', 'mailto:it@gigasolar.com.tw', '/it/notify', ' /it/notify']) expect(isAllowedHref(ok), ok).toBe(true);
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', '//evil.example', 'http://x', 'data:text/html,1', 'relative'])
      expect(isAllowedHref(bad), bad).toBe(false);
  });

  it('圖片只接受本平台圖片 API', () => {
    expect(isAllowedImageSrc('/api/notify/assets/12')).toBe(true);
    expect(isAllowedImageSrc('/api/notify/assets/12/../x')).toBe(false);
    expect(isAllowedImageSrc('https://tracker.example/p.gif')).toBe(false);
  });

  it('style 只留顏色、背景色、對齊', () => {
    expect(filterStyle('color: #dc2626; font-size: 40px; text-align: CENTER')).toBe('color:#dc2626;text-align:center');
    expect(filterStyle('background-color: url(https://x); color: expression(alert(1))')).toBe('');
    expect(filterStyle('background-color: rgb(255, 0, 0)')).toBe('background-color:rgb(255, 0, 0)');
  });

  it('白名單不含可執行或可載入外部資源的標籤與事件屬性', () => {
    for (const t of ['script', 'iframe', 'svg', 'math', 'style', 'object', 'form']) {
      expect(ALLOWED_TAGS).not.toContain(t);
      expect(DROP_WITH_CONTENT).toContain(t);
    }
    expect(ALLOWED_ATTR.filter((a) => a.startsWith('on'))).toEqual([]);
  });
});
