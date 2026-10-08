/**
 * Auth API(PRD §8.2.4)。這些路由是程式內建,不受動態路由表影響(PRD §14.1)。
 *   POST /api/auth/login | refresh | logout | password/change | register/verify
 *   POST /api/auth/register | password/forgot | password/reset   自行註冊與忘記密碼(local-account.ts)
 *   GET  /api/auth/me
 *   GET  /_auth/verify               僅供 Nginx auth_request(internal location)
 *   GET  /.well-known/jwks.json      內部 Token 公鑰(僅內網)
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { localAccountToken, localCredential, user } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { loginTotal } from '../../plugins/metrics.js';
import type { RouteTable } from '../router/table.js';
import { companyOpen } from '../rbac/login-companies.js';
import { buildIdentity } from './identity.js';
import { FORGOT_MESSAGE, LocalAccountService } from './local-account.js';
import { writeAuthLog } from './login.js';
import { checkPasswordPolicy, hashPassword, isReused, POLICY_MESSAGES, pushHistory, verifyPassword } from './password.js';
import { identityOf } from './plugin.js';
import { COOKIE_PWCHG, COOKIE_RT, csrfValid } from './session.js';

const loginBody = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 128 },
    password: { type: 'string', minLength: 1, maxLength: 256 },
    remember: { type: 'boolean', default: false },
  },
} as const;

const changeBody = {
  type: 'object',
  required: ['newPassword'],
  additionalProperties: false,
  properties: {
    currentPassword: { type: 'string', maxLength: 256 },
    newPassword: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

const verifyBody = {
  type: 'object',
  required: ['token', 'password'],
  additionalProperties: false,
  properties: { token: { type: 'string', minLength: 10, maxLength: 200 }, password: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;

const registerBody = {
  type: 'object',
  required: ['employeeNo', 'name'],
  // 自填 Email 等多餘欄位直接移除:驗證連結只寄到 LOS / BPM 登記的 Email
  properties: {
    employeeNo: { type: 'string', minLength: 1, maxLength: 20 },
    name: { type: 'string', minLength: 1, maxLength: 50 },
    hireDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    password: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

const forgotBody = {
  type: 'object',
  required: ['employeeNo'],
  properties: { employeeNo: { type: 'string', minLength: 1, maxLength: 20 } },
} as const;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

declare module 'fastify' {
  interface FastifyInstance {
    localAccounts: LocalAccountService;
  }
}

const authRoutes: FastifyPluginAsync<{ config: AppConfig; routes: RouteTable }> = async (app, { config, routes }) => {
  const ua = (req: FastifyRequest) => String(req.headers['user-agent'] ?? '');
  app.decorate(
    'localAccounts',
    new LocalAccountService({
      db: app.db,
      redis: app.redis,
      ad: app.ad,
      ext: app.ext,
      notifier: app.notifier,
      log: app.log,
      publicBaseUrl: config.publicBaseUrl,
      resetFallbackTo: config.passwordResetFallbackTo,
      revokeUser: (userId) => app.sessions.revokeUser(userId),
    }),
  );

  async function startSession(req: FastifyRequest, reply: FastifyReply, userId: number, amr: 'ad' | 'local', remember: boolean) {
    const identity = await buildIdentity(app.db, app.redis, userId, amr);
    if (identity.isDisabled) throw new GwError('ACCOUNT_DISABLED');
    if (!companyOpen(config.loginCompanies, identity.me.companies)) {
      await writeAuthLog(app.db, {
        username: identity.claims.emp,
        userId,
        authMethod: amr,
        event: 'login_fail',
        reason: `COMPANY_NOT_OPEN: ${identity.me.companies.join(',') || '(無所屬公司)'}`.slice(0, 200),
        ip: req.ip,
        userAgent: ua(req),
      });
      throw new GwError('COMPANY_NOT_OPEN');
    }
    // 「記住我」僅限公司內網來源(PRD Q4)
    await app.sessions.issue(reply, identity, { remember: remember && app.isInternalIp(req.ip), ip: req.ip, userAgent: ua(req) });
    return identity.me;
  }

  app.post<{ Body: { username: string; password: string; remember: boolean } }>('/api/auth/login', { schema: { body: loginBody } }, async (req, reply) => {
    const result = await app.logins.login({ username: req.body.username, password: req.body.password, ip: req.ip, userAgent: ua(req) });
    loginTotal.inc({ result: result.kind === 'ok' ? 'success' : result.kind === 'password_change_required' ? result.kind : result.code });
    if (result.kind === 'ok') return startSession(req, reply, result.userId, result.amr, req.body.remember);
    if (result.kind === 'password_change_required') {
      // 只發 10 分鐘有效、只能變更密碼的限定憑證,不發正式 Token(PRD §8.2.5)
      await app.sessions.issuePasswordChange(reply, result.userId, req.body.remember);
      throw new GwError('PASSWORD_CHANGE_REQUIRED');
    }
    if (result.code === 'UPSTREAM_UNAVAILABLE') throw new GwError('UPSTREAM_UNAVAILABLE', '驗證服務暫時無法使用');
    throw new GwError(result.code);
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const outcome = await app.sessions.consumeRefresh(req.cookies[COOKIE_RT]);
    if (!outcome.ok) {
      if (outcome.reason === 'reused') {
        await writeAuthLog(app.db, {
          username: '(refresh)',
          event: 'token_reuse_detected',
          reason: 'refresh token family revoked',
          ip: req.ip,
          userAgent: ua(req),
        });
        req.log.warn({ ip: req.ip }, '偵測到 Refresh Token 重複使用,已撤銷整個家族');
      }
      app.sessions.clearCookies(reply);
      throw new GwError('REFRESH_TOKEN_INVALID');
    }
    const identity = await buildIdentity(app.db, app.redis, outcome.userId, outcome.amr);
    if (identity.isDisabled || !companyOpen(config.loginCompanies, identity.me.companies)) {
      await app.sessions.revokeFamily(outcome.familyId, outcome.userId);
      app.sessions.clearCookies(reply);
      throw new GwError('REFRESH_TOKEN_INVALID');
    }
    await app.sessions.issue(reply, identity, { remember: outcome.remember, familyId: outcome.familyId });
    await writeAuthLog(app.db, {
      username: identity.claims.emp,
      userId: identity.userId,
      authMethod: outcome.amr,
      event: 'refresh',
      ip: req.ip,
      userAgent: ua(req),
    });
    return identity.me;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const p = await req.principal();
    if (p) await app.sessions.deny(p.claims.jti, p.claims.exp);
    const familyId = app.sessions.familyIdOf(req.cookies[COOKIE_RT]);
    if (familyId) await app.sessions.revokeFamily(familyId, p?.userId);
    app.sessions.clearCookies(reply);
    if (p) await writeAuthLog(app.db, { username: p.claims.emp, userId: p.userId, authMethod: p.claims.amr, event: 'logout', ip: req.ip, userAgent: ua(req) });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (req) => {
    const p = await req.requirePrincipal();
    return (await buildIdentity(app.db, app.redis, p.userId, p.claims.amr)).me;
  });

  /** 本機帳號變更密碼:已登入者需提供目前密碼;持限定憑證(首次登入 / IT 重設後)者不需要 */
  app.post<{ Body: { currentPassword?: string; newPassword: string } }>('/api/auth/password/change', { schema: { body: changeBody } }, async (req, reply) => {
    const limited = await app.sessions.consumePasswordChange(req.cookies[COOKIE_PWCHG], true);
    const p = limited ? null : await req.requirePrincipal();
    const userId = limited?.userId ?? p!.userId;

    const [row] = await app.db
      .select({ cred: localCredential, emp: user.employeeNo })
      .from(localCredential)
      .innerJoin(user, eq(user.userId, localCredential.userId))
      .where(eq(localCredential.userId, userId));
    if (!row) throw new GwError('PERMISSION_DENIED', 'AD 帳號請依公司 AD 流程變更密碼');
    if (!limited && !(await verifyPassword(row.cred.passwordHash, req.body.currentPassword ?? ''))) throw new GwError('INVALID_CREDENTIALS', '目前密碼錯誤');

    const failed = checkPasswordPolicy(req.body.newPassword, row.emp);
    if (failed.length)
      throw new GwError(
        'PASSWORD_POLICY_VIOLATION',
        undefined,
        failed.map((rule) => ({ rule, message: POLICY_MESSAGES[rule] })),
      );
    if (await isReused(req.body.newPassword, row.cred.passwordHash, row.cred.passwordHistory)) throw new GwError('PASSWORD_REUSED');

    await app.db
      .update(localCredential)
      .set({
        passwordHash: await hashPassword(req.body.newPassword),
        passwordHistory: pushHistory(row.cred.passwordHash, row.cred.passwordHistory),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        failedCount: 0,
        updatedBy: row.emp,
      })
      .where(eq(localCredential.userId, userId));
    if (limited) await app.sessions.consumePasswordChange(req.cookies[COOKIE_PWCHG]);
    await writeAuthLog(app.db, { username: row.emp, userId, authMethod: 'local', event: 'password_changed', ip: req.ip, userAgent: ua(req) });

    // 密碼變更後撤銷所有 Refresh Token 家族,其他裝置須重新登入;本裝置換發新工作階段
    await app.sessions.revokeUser(userId);
    if (p) await app.sessions.deny(p.claims.jti, p.claims.exp);
    return startSession(req, reply, userId, 'local', limited?.remember ?? false);
  });

  /** 自行註冊(W3-5.8a):有 Email 寄驗證連結 → 202;無 Email 比對到職日後直接啟用 → 200;查無轉審核 → 202 */
  app.post<{ Body: { employeeNo: string; name: string; hireDate?: string; password?: string } }>(
    '/api/auth/register',
    { schema: { body: registerBody } },
    async (req, reply) => {
      const r = await app.localAccounts.register({ ...req.body, ip: req.ip, userAgent: ua(req) });
      return reply.code(r.code === 'OK' ? 200 : 202).send({ code: r.code, message: r.message, requestId: req.id });
    },
  );

  /** 忘記密碼(W3-5.8b):不論帳號是否存在都回相同內容 */
  app.post<{ Body: { employeeNo: string } }>('/api/auth/password/forgot', { schema: { body: forgotBody } }, async (req, reply) => {
    await app.localAccounts.forgot(req.body.employeeNo, { ip: req.ip, userAgent: ua(req) });
    return reply.code(202).send({ code: 'VERIFICATION_SENT', message: FORGOT_MESSAGE, requestId: req.id });
  });

  /** 以重設連結設定新密碼(W3-5.8b) */
  app.post<{ Body: { token: string; password: string } }>('/api/auth/password/reset', { schema: { body: verifyBody } }, async (req) => {
    await app.localAccounts.reset(req.body.token, req.body.password, { ip: req.ip, userAgent: ua(req) });
    return { code: 'OK', message: '密碼已重設,其他裝置的登入已登出,請以新密碼登入' };
  });

  /** 以驗證 / 啟用連結的 token 設定密碼並啟用本機帳號(IT 代建 72 小時、Email 驗證 30 分鐘) */
  app.post<{ Body: { token: string; password: string } }>('/api/auth/register/verify', { schema: { body: verifyBody } }, async (req) => {
    const [t] = await app.db
      .select()
      .from(localAccountToken)
      .where(eq(localAccountToken.tokenHash, sha256(req.body.token)));
    if (!t || !['activate', 'verify_email'].includes(t.purpose)) throw new GwError('TOKEN_INVALID');
    if (t.usedAt) throw new GwError('TOKEN_USED');
    if (t.expiresAt.getTime() < Date.now()) throw new GwError('TOKEN_EXPIRED');

    const [u] = await app.db.select({ emp: user.employeeNo }).from(user).where(eq(user.userId, t.userId));
    const failed = checkPasswordPolicy(req.body.password, u!.emp);
    if (failed.length)
      throw new GwError(
        'PASSWORD_POLICY_VIOLATION',
        undefined,
        failed.map((rule) => ({ rule, message: POLICY_MESSAGES[rule] })),
      );

    const passwordHash = await hashPassword(req.body.password);
    await app.db.transaction(async (tx) => {
      await tx.update(localAccountToken).set({ usedAt: new Date() }).where(eq(localAccountToken.tokenId, t.tokenId));
      await tx
        .update(localCredential)
        .set({ passwordHash, status: 'active', mustChangePassword: false, passwordChangedAt: new Date(), failedCount: 0, updatedBy: u!.emp })
        .where(eq(localCredential.userId, t.userId));
      await writeAuthLog(tx, { username: u!.emp, userId: t.userId, authMethod: 'local', event: 'register_verified', ip: req.ip, userAgent: ua(req) });
    });
    return { code: 'OK', message: '帳號已啟用,請以新密碼登入' };
  });

  /**
   * Nginx auth_request(PRD §7.4):依 X-Original-URI 判斷權限,回 204 / 401 / 403;
   * 成功時以回應標頭帶回 X-Auth-User 與 X-Internal-Token,由 Nginx 轉給上游。
   */
  app.get('/_auth/verify', { logLevel: 'warn' }, async (req, reply) => {
    const p = await req.principal();
    if (!p) return reply.code(401).send();
    const uri = String(req.headers['x-original-uri'] ?? '').split('?')[0]!;
    const method = String(req.headers['x-original-method'] ?? 'GET');
    // Nginx 直送上游的寫入請求(附件上傳,giga-file-service D4-B)不經 BFF 的 CSRF 檢查,在此補驗(auth_request 會帶原請求的標頭)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && !csrfValid(req)) return reply.code(403).send();
    let audience: string;
    let permission: string | null;
    if (uri.startsWith('/ws/endpoint/')) {
      audience = 'endpoint-api';
      permission = config.endpointWsPermission;
    } else {
      const match = routes.find(method, uri);
      if (!match || match.route.authMode === 'public') return reply.code(match ? 204 : 403).send();
      audience = match.route.upstreamCode ?? 'giganexus';
      permission = match.route.authMode === 'permission' ? match.route.permissionCode : null;
    }
    if (permission && !(await app.perms.has(p.userId, p.claims.pv, permission))) return reply.code(403).send();
    return reply
      .code(204)
      .header('x-auth-user', p.claims.emp)
      .header('x-internal-token', await app.keys.signInternal(identityOf(p.claims), audience))
      .send();
  });

  app.get('/.well-known/jwks.json', { logLevel: 'warn' }, async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return app.keys.jwks();
  });
};

export default authRoutes;
