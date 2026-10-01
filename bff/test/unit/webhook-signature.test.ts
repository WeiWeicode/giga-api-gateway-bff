import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPayload, timestampValid, verifySignature } from '../../src/modules/webhook/signature.js';

const SECRET = 'test-secret';
const BODY = Buffer.from('{"eventType":"approval.completed","formNo":"LV-001"}');

describe('signPayload / verifySignature(BACKEND-GUIDE §8)', () => {
  it('簽章 = sha256=hex(HMAC(密鑰, timestamp + "." + body))', () => {
    const expected = createHmac('sha256', SECRET).update(`1700000000.${BODY.toString()}`).digest('hex');
    expect(signPayload(SECRET, '1700000000', BODY)).toBe(`sha256=${expected}`);
  });

  it('正確簽章通過;大寫 hex 也接受', () => {
    const sig = signPayload(SECRET, '1700000000', BODY);
    expect(verifySignature(SECRET, '1700000000', BODY, sig)).toBe(true);
    expect(verifySignature(SECRET, '1700000000', BODY, sig.toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
  });

  it.each([
    ['密鑰不同', 'other', '1700000000', BODY],
    ['時間戳被竄改', SECRET, '1700000001', BODY],
    ['body 被竄改', SECRET, '1700000000', Buffer.from('{"eventType":"x"}')],
  ])('%s → 失敗', (_name, secret, ts, body) => {
    expect(verifySignature(secret, ts, body, signPayload(SECRET, '1700000000', BODY))).toBe(false);
  });

  it('缺少或長度不符的簽章 → 失敗', () => {
    expect(verifySignature(SECRET, '1700000000', BODY, undefined)).toBe(false);
    expect(verifySignature(SECRET, '1700000000', BODY, 'sha256=abc')).toBe(false);
  });
});

describe('timestampValid(±5 分鐘)', () => {
  const now = 1_700_000_000;
  it.each([
    [now - 240, true],
    [now - 300, true],
    [now - 360, false],
    [now + 360, false],
  ])('%i → %s', (ts, ok) => {
    expect(timestampValid(String(ts), now)).toBe(ok);
  });

  it.each([undefined, '', 'abc', '1.5', '-100'])('格式錯誤 %s → 失敗', (ts) => {
    expect(timestampValid(ts, now)).toBe(false);
  });
});
