/**
 * 身分驗證 plugin:組裝 KeyStore、SessionService、LoginService、PermissionService,
 * 並提供 request 層級的身分解析(Access Token → Principal)與 CSRF 檢查。
 */
import { BlockList, isIPv4 } from 'node:net';
import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { GwError } from '../../errors.js';
import { PermissionService } from '../rbac/permission.js';
import { KeyStore, type AccessClaims, type IdentityClaims } from './keys.js';
import { AdDirectory } from './ldap.js';
import { LoginService } from './login.js';
import { COOKIE_AT, csrfValid, denyKey, SessionService } from './session.js';

export interface Principal {
  userId: number;
  claims: AccessClaims;
}

declare module 'fastify' {
  interface FastifyInstance {
    keys: KeyStore;
    sessions: SessionService;
    logins: LoginService;
    perms: PermissionService;
    ad: AdDirectory;
    isInternalIp: (ip: string) => boolean;
  }
  interface FastifyRequest {
    /** 解析 gn_at;未登入、過期、已撤銷或權限版本已變更時回 null(結果快取於同一請求) */
    principal(): Promise<Principal | null>;
    requirePrincipal(): Promise<Principal>;
    principalCache?: Promise<Principal | null>;
  }
}

/** 登入前即可呼叫、不檢查 CSRF 的 API(此時尚無 gn_csrf);後端自動註冊只接受 X-Api-Key(不使用 Cookie),亦不適用 CSRF */
const CSRF_EXEMPT = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/register/verify',
  '/api/auth/password/forgot',
  '/api/auth/password/reset',
  '/api/admin/registrations',
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function identityOf(claims: AccessClaims): IdentityClaims {
  return { sub: claims.sub, emp: claims.emp, upn: claims.upn, name: claims.name, dept: claims.dept, cos: claims.cos, amr: claims.amr, roles: claims.roles };
}

export function buildBlockList(cidrs: string): BlockList {
  const list = new BlockList();
  for (const c of cidrs
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [net, prefix] = c.split('/');
    list.addSubnet(net!, Number(prefix ?? 32), isIPv4(net!) ? 'ipv4' : 'ipv6');
  }
  return list;
}

export default fp<{ config: AppConfig }>(
  async (app, { config }) => {
    await app.register(cookie);

    const keys = KeyStore.load(config.jwtKeysDir, config.jwtActiveKid);
    const ad = new AdDirectory(config.ldapDomains);
    const perms = new PermissionService(app.db, app.redis, app.log);
    app.decorate('keys', keys);
    app.decorate('ad', ad);
    app.decorate('perms', perms);
    app.decorate('sessions', new SessionService(app.redis, keys, config.cookieSecure));
    app.decorate('logins', new LoginService(app.db, app.redis, ad, app.ext, app.log));

    const internal = buildBlockList(config.internalNetworks);
    app.decorate('isInternalIp', (ip: string) => {
      const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
      return internal.check(v4, isIPv4(v4) ? 'ipv4' : 'ipv6');
    });

    async function resolve(req: FastifyRequest): Promise<Principal | null> {
      const token = req.cookies[COOKIE_AT];
      if (!token) return null;
      let claims: AccessClaims;
      try {
        claims = await keys.verifyAccess(token);
      } catch {
        return null;
      }
      const userId = Number(claims.sub);
      try {
        if (await app.redis.exists(denyKey(claims.jti))) return null;
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'Redis 無法檢查 Token 黑名單');
      }
      // 權限版本變更(角色、部門、停用…)→ 要求 Refresh 重新計算(PRD §8.2.2 強制登出)
      if ((await perms.currentPv(userId)) !== claims.pv) return null;
      return { userId, claims };
    }

    app.decorateRequest('principal', function (this: FastifyRequest) {
      this.principalCache ??= resolve(this);
      return this.principalCache;
    });
    app.decorateRequest('requirePrincipal', async function (this: FastifyRequest) {
      const p = await this.principal();
      if (!p) throw new GwError('UNAUTHENTICATED');
      return p;
    });

    // CSRF:所有 /api/* 的非 GET/HEAD/OPTIONS 請求(PRD §8.2.2)
    app.addHook('preHandler', async (req) => {
      if (SAFE_METHODS.has(req.method) || !req.url.startsWith('/api/')) return;
      const path = req.url.split('?')[0]!;
      if (CSRF_EXEMPT.has(path)) return;
      // 系統對系統以 X-Api-Key 呼叫(不帶登入 Cookie):瀏覽器跨站無法加自訂標頭,不適用 CSRF
      if (req.headers['x-api-key'] && !req.cookies[COOKIE_AT]) return;
      if (!csrfValid(req)) throw new GwError('CSRF_INVALID');
    });
  },
  { name: 'auth', dependencies: ['db', 'redis'] },
);
