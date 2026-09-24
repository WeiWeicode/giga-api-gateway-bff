/**
 * 路由層限流(Redis 滑動視窗)與 GET 回應快取(PRD §8.4.2、DATABASE.md §6)。
 * Redis 不可用時限流放行、快取略過(降級,不影響服務)。
 */
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

const SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
if redis.call('ZCARD', key) >= limit then return 0 end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return 1
`;

let seq = 0;

/** gw:rl:{policy}:{key};回傳是否放行 */
export async function allowRequest(redis: Redis, policy: string, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Date.now();
  const member = `${now}-${process.pid}-${seq++}`;
  const r = await redis.eval(SLIDING_WINDOW, 1, `gw:rl:${policy}:${key}`, now, windowSec * 1000, limit, member);
  return r === 1;
}

export interface CachedResponse {
  status: number;
  contentType: string | null;
  body: string; // base64
}

export function cacheKey(routeCode: string, url: string, scope: 'user' | 'shared', userId: number | null): string {
  const h = createHash('sha256')
    .update(`${scope === 'user' ? (userId ?? 'anon') : '*'}|${url}`)
    .digest('hex')
    .slice(0, 32);
  return `gw:cache:${routeCode}:${h}`;
}

export async function getCached(redis: Redis, key: string): Promise<CachedResponse | null> {
  const raw = await redis.get(key);
  return raw ? (JSON.parse(raw) as CachedResponse) : null;
}

export async function setCached(redis: Redis, key: string, ttlSec: number, v: CachedResponse): Promise<void> {
  await redis.set(key, JSON.stringify(v), 'EX', ttlSec);
}
