/**
 * 工作階段(PRD §8.2.2、DATABASE.md §6):
 *   gn_at   Access Token(JWT ES256,15 分)     HttpOnly; Secure; SameSite=Strict; Path=/
 *   gn_rt   Refresh Token(familyId.secret)     HttpOnly; Secure; SameSite=Strict; Path=/api/auth;8 小時,記住我 7 天
 *   gn_csrf CSRF Token                          Secure; SameSite=Strict(非 HttpOnly,供 SPA 讀取)
 *
 * Redis:
 *   gw:rt:{familyId}       Hash { userId, amr, hash, remember, expiresAt }(TTL = 家族效期,Rotation 不延長)
 *   gw:user:rt:{userId}    Set familyId(強制登出用)
 *   gw:deny:{jti}          已撤銷 Access Token(TTL = 剩餘效期)
 *   gw:pwchg:{tokenHash}   限定變更密碼憑證(10 分)
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { ACCESS_TTL_SEC, type KeyStore } from './keys.js';
import type { Identity } from './identity.js';

export const COOKIE_AT = 'gn_at';
export const COOKIE_RT = 'gn_rt';
export const COOKIE_CSRF = 'gn_csrf';
export const COOKIE_PWCHG = 'gn_pwchg';
export const RT_TTL_SEC = 8 * 60 * 60;
export const RT_REMEMBER_TTL_SEC = 7 * 24 * 60 * 60;
export const PWCHG_TTL_SEC = 10 * 60;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const rtKey = (familyId: string) => `gw:rt:${familyId}`;
const userRtKey = (userId: number | string) => `gw:user:rt:${userId}`;
export const denyKey = (jti: string) => `gw:deny:${jti}`;
const pwchgKey = (hash: string) => `gw:pwchg:${hash}`;

/** 撤銷使用者所有 Refresh Token 家族(強制登出;CLI 重設密碼也使用) */
export async function revokeUserSessions(redis: Redis, userId: number): Promise<number> {
  const families = await redis.smembers(userRtKey(userId));
  if (families.length) await redis.del(...families.map(rtKey));
  await redis.del(userRtKey(userId));
  return families.length;
}

export type RefreshOutcome =
  { ok: true; userId: number; amr: 'ad' | 'local'; remember: boolean; familyId: string } | { ok: false; reason: 'missing' | 'expired' | 'reused' };

export class SessionService {
  constructor(
    private readonly redis: Redis,
    private readonly keys: KeyStore,
    private readonly cookieSecure: boolean,
  ) {}

  private cookieBase() {
    return { secure: this.cookieSecure, sameSite: 'strict' as const };
  }

  /** 登入或 Refresh 成功後發放 Cookie;familyId 為空時建立新家族 */
  async issue(reply: FastifyReply, identity: Identity, opts: { remember: boolean; familyId?: string; ip?: string; userAgent?: string }): Promise<void> {
    const { token } = await this.keys.signAccess({ ...identity.claims, pv: identity.pv });
    const secret = randomBytes(32).toString('base64url');
    const familyId = opts.familyId ?? randomUUID();
    const key = rtKey(familyId);
    let expiresAt: number;

    if (opts.familyId) {
      expiresAt = Number(await this.redis.hget(key, 'expiresAt'));
      await this.redis.hset(key, { hash: sha256(secret), rotatedAt: Date.now() });
    } else {
      expiresAt = Date.now() + (opts.remember ? RT_REMEMBER_TTL_SEC : RT_TTL_SEC) * 1000;
      await this.redis
        .multi()
        .hset(key, {
          userId: identity.userId,
          amr: identity.claims.amr,
          hash: sha256(secret),
          remember: opts.remember ? '1' : '0',
          expiresAt,
          createdAt: Date.now(),
          ip: opts.ip ?? '',
          ua: (opts.userAgent ?? '').slice(0, 200),
        })
        .pexpireat(key, expiresAt)
        .sadd(userRtKey(identity.userId), familyId)
        .expire(userRtKey(identity.userId), RT_REMEMBER_TTL_SEC)
        .exec();
    }

    const rtMaxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    const csrf = randomBytes(24).toString('base64url');
    reply
      .setCookie(COOKIE_AT, token, { ...this.cookieBase(), httpOnly: true, path: '/', maxAge: ACCESS_TTL_SEC })
      .setCookie(COOKIE_RT, `${familyId}.${secret}`, { ...this.cookieBase(), httpOnly: true, path: '/api/auth', maxAge: rtMaxAge })
      .setCookie(COOKIE_CSRF, csrf, { ...this.cookieBase(), httpOnly: false, path: '/', maxAge: rtMaxAge })
      .clearCookie(COOKIE_PWCHG, { ...this.cookieBase(), path: '/api/auth/password' });
  }

  /** 驗證 gn_rt;舊 RT 被重用時撤銷整個家族(判定為竊用) */
  async consumeRefresh(cookie: string | undefined): Promise<RefreshOutcome> {
    const [familyId, secret] = (cookie ?? '').split('.');
    if (!familyId || !secret) return { ok: false, reason: 'missing' };
    const data = await this.redis.hgetall(rtKey(familyId));
    if (!data.hash) return { ok: false, reason: 'expired' };
    const a = Buffer.from(data.hash, 'hex');
    const b = Buffer.from(sha256(secret), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await this.revokeFamily(familyId, Number(data.userId));
      return { ok: false, reason: 'reused' };
    }
    return { ok: true, userId: Number(data.userId), amr: data.amr === 'local' ? 'local' : 'ad', remember: data.remember === '1', familyId };
  }

  async revokeFamily(familyId: string, userId?: number): Promise<void> {
    const m = this.redis.multi().del(rtKey(familyId));
    if (userId !== undefined) m.srem(userRtKey(userId), familyId);
    await m.exec();
  }

  /** 撤銷使用者所有 Refresh Token 家族(密碼變更、強制登出) */
  revokeUser(userId: number): Promise<number> {
    return revokeUserSessions(this.redis, userId);
  }

  familyIdOf(cookie: string | undefined): string | undefined {
    return cookie?.split('.')[0] || undefined;
  }

  /** Access Token 加入黑名單直到過期 */
  async deny(jti: string, exp: number): Promise<void> {
    const ttl = exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) await this.redis.set(denyKey(jti), '1', 'EX', ttl);
  }

  clearCookies(reply: FastifyReply): void {
    reply
      .clearCookie(COOKIE_AT, { ...this.cookieBase(), path: '/' })
      .clearCookie(COOKIE_RT, { ...this.cookieBase(), path: '/api/auth' })
      .clearCookie(COOKIE_CSRF, { ...this.cookieBase(), path: '/' })
      .clearCookie(COOKIE_PWCHG, { ...this.cookieBase(), path: '/api/auth/password' });
  }

  /** 限定變更密碼憑證:只能呼叫 /api/auth/password/change(PRD §8.2.5) */
  async issuePasswordChange(reply: FastifyReply, userId: number, remember: boolean): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.redis.set(pwchgKey(sha256(token)), JSON.stringify({ userId, remember }), 'EX', PWCHG_TTL_SEC);
    reply
      .setCookie(COOKIE_PWCHG, token, { ...this.cookieBase(), httpOnly: true, path: '/api/auth/password', maxAge: PWCHG_TTL_SEC })
      // 變更密碼仍是 POST,需要 CSRF Token
      .setCookie(COOKIE_CSRF, randomBytes(24).toString('base64url'), { ...this.cookieBase(), httpOnly: false, path: '/', maxAge: PWCHG_TTL_SEC });
  }

  async consumePasswordChange(token: string | undefined, peek = false): Promise<{ userId: number; remember: boolean } | null> {
    if (!token) return null;
    const key = pwchgKey(sha256(token));
    const raw = peek ? await this.redis.get(key) : await this.redis.getdel(key);
    return raw ? (JSON.parse(raw) as { userId: number; remember: boolean }) : null;
  }
}

/** CSRF 雙重提交:非 GET/HEAD/OPTIONS 需 X-CSRF-Token 等於 gn_csrf Cookie */
export function csrfValid(req: FastifyRequest): boolean {
  const cookie = req.cookies[COOKIE_CSRF];
  const header = req.headers['x-csrf-token'];
  if (!cookie || typeof header !== 'string') return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
