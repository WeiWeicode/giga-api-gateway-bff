/**
 * Webhook 簽章(PRD §8.6、BACKEND-GUIDE.md §7.6):純函式,不做 I/O。
 *
 *   X-Gw-Timestamp: <Unix 秒>
 *   X-Gw-Signature: sha256=<hex(HMAC-SHA256(密鑰, timestamp + "." + 原始 body))>
 *   Idempotency-Key: <呼叫端產生,24 小時內唯一>
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TIMESTAMP_HEADER = 'x-gw-timestamp';
export const DEFAULT_SIGNATURE_HEADER = 'x-gw-signature';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** 時間戳允許誤差 ±5 分鐘,超出視為重放 */
export const TIMESTAMP_TOLERANCE_SEC = 300;

export function signPayload(secret: string, timestamp: string, body: Buffer): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

export function verifySignature(secret: string, timestamp: string, body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const actual = Buffer.from(signature.trim().toLowerCase());
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function timestampValid(timestamp: string | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(nowSec - Number(timestamp)) <= TIMESTAMP_TOLERANCE_SEC;
}
