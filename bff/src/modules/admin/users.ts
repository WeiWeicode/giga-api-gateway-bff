/**
 * 使用者、公司與本機帳號管理 API(PRD §8.2.5、§8.7、P2-3):API Key 或登入者皆可。
 *
 *   GET    /api/admin/users                              使用者清單(搜尋、篩選、分頁)           gw.admin.user.read
 *   GET    /api/admin/users/:id                          明細:所屬公司、個別指派角色、本機帳號、登入數  gw.admin.user.read
 *   PATCH  /api/admin/users/:id                          停用 / 啟用、取代個別指派角色             gw.admin.user.write
 *   POST   /api/admin/users/:id/revoke-sessions          強制登出                                 gw.admin.user.write
 *   GET    /api/admin/companies                          公司清單(網域、預設角色、人數)          gw.admin.company.read
 *   PATCH  /api/admin/companies/:id                      全名、工號字首、啟用                     gw.admin.company.write
 *   PUT    /api/admin/companies/:id/ad-domains           AD 網域與嘗試順序(陣列順序)            gw.admin.company.write
 *   PUT    /api/admin/companies/:id/roles                公司預設角色                             gw.admin.company.write
 *   GET    /api/admin/local-accounts                     本機帳號(含待審核,新到舊)            gw.admin.local.read
 *   POST   /api/admin/local-accounts                     IT 代建(回傳 72 小時啟用連結)          gw.admin.local.write
 *   POST   /api/admin/local-accounts/:id/approve         核准待審核(回傳啟用連結)              gw.admin.local.write
 *   POST   /api/admin/local-accounts/:id/reset-password  IT 重設(回傳臨時密碼,只顯示一次)      gw.admin.local.write
 *   POST   /api/admin/local-accounts/:id/unlock          解除鎖定                                 gw.admin.local.write
 *   POST   /api/admin/local-accounts/:id/disable         停用本機帳號                             gw.admin.local.write
 *
 * - :id 為 user_id 或工號。修改使用者與公司需帶 rowVer(樂觀鎖)。
 * - 影響權限的變更在同一交易內遞增受影響使用者的 perm_version,提交後清除其 pv 快取(DATABASE.md §7.2)。
 * - 個別指派:不可授予或移除自己沒有的權限(避免 gw-it-admin 自行取得 gw-super-admin 等提權)。
 */
import { and, asc, count, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../../config.js';
import {
  company,
  companyAdDomain,
  localCredential,
  role,
  roleCompany,
  rowVerFromHex,
  rowVerToHex,
  user,
  userCompany,
  userRole,
} from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { normalizeEmpNo } from '../auth/profile.js';
import { revokeUserSessions, userSessionCount } from '../auth/session.js';
import { parseGroups, permissionsOf } from '../rbac/permission.js';
import { writeAudit } from './audit-log.js';
import { createAuthorizer } from './authorize.js';
import * as localAdmin from './local-account-admin.js';

const USER_READ = 'gw.admin.user.read';
const USER_WRITE = 'gw.admin.user.write';
const COMPANY_READ = 'gw.admin.company.read';
const COMPANY_WRITE = 'gw.admin.company.write';
const LOCAL_READ = 'gw.admin.local.read';
const LOCAL_WRITE = 'gw.admin.local.write';
const LOCAL_STATUSES = ['pending_verify', 'pending_approval', 'active', 'locked', 'disabled'] as const;

const ROW_VER = { type: 'string', pattern: '^[0-9a-fA-F]{16}$' };
const REF_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 20 } } };
const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const PAGING = { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 } };

const likeOf = (q: string) => `%${q.replace(/[[%_]/g, (c) => `[${c}]`)}%`;

function verOf(hex: string): Buffer {
  try {
    return rowVerFromHex(hex);
  } catch {
    throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'rowVer', message: '格式錯誤' }]);
  }
}

interface RoleAssign {
  code: string;
  validTo?: string | null;
  reason?: string | null;
}

const users: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  const authorize = createAuthorizer(app);
  const localDeps = { db: app.db, redis: app.redis };

  /** user_id 或工號 → 使用者 */
  async function findUser(ref: string) {
    const [u] = await app.db
      .select()
      .from(user)
      .where(/^\d+$/.test(ref) ? eq(user.userId, Number(ref)) : eq(user.employeeNo, normalizeEmpNo(ref)));
    if (!u) throw new GwError('VALIDATION_FAILED', '使用者不存在', [{ field: 'id', message: ref }]);
    return u;
  }

  async function findCompany(id: number) {
    const [c] = await app.db.select().from(company).where(eq(company.companyId, id));
    if (!c) throw new GwError('VALIDATION_FAILED', '公司不存在', [{ field: 'id', message: String(id) }]);
    return c;
  }

  /** 提交後:清除 pv 快取(失敗時 15 分鐘內自然過期) */
  const invalidatePv = (ids: number[] | 'all') =>
    app.perms.invalidatePv(ids).catch((err: Error) => app.log.warn({ err: err.message }, 'pv 快取清除失敗(15 分鐘內自然過期)'));

  // ───────── 使用者 ─────────

  app.get<{ Querystring: { q?: string; companyId?: number; deptCode?: string; disabled?: boolean; authType?: string; page?: number; pageSize?: number } }>(
    '/api/admin/users',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 100 },
            companyId: { type: 'integer', minimum: 1 },
            deptCode: { type: 'string', maxLength: 30 },
            disabled: { type: 'boolean' },
            authType: { type: 'string', enum: ['ad', 'local'] },
            ...PAGING,
          },
        },
      },
    },
    async (req) => {
      await authorize(req, USER_READ);
      const { q, companyId, deptCode, disabled, authType, page = 1, pageSize = 50 } = req.query;
      const conds: (SQL | undefined)[] = [];
      if (q?.trim()) conds.push(or(like(user.employeeNo, likeOf(q.trim())), like(user.displayName, likeOf(q.trim())), like(user.email, likeOf(q.trim()))));
      if (companyId) conds.push(inArray(user.userId, app.db.select({ id: userCompany.userId }).from(userCompany).where(eq(userCompany.companyId, companyId))));
      if (deptCode) conds.push(eq(user.deptCode, deptCode));
      if (disabled !== undefined) conds.push(eq(user.isDisabled, disabled));
      if (authType) conds.push(eq(user.authType, authType));
      const where = and(...conds);
      const [[total], rows] = await Promise.all([
        app.db.select({ n: count() }).from(user).where(where),
        app.db
          .select({
            userId: user.userId,
            employeeNo: user.employeeNo,
            displayName: user.displayName,
            email: user.email,
            deptCode: user.deptCode,
            department: user.department,
            orgName: user.orgName,
            title: user.title,
            jobLevel: user.jobLevel,
            authType: user.authType,
            adDomain: user.adDomain,
            employmentStatus: user.employmentStatus,
            isDisabled: user.isDisabled,
            lastLoginAt: user.lastLoginAt,
            localStatus: localCredential.status,
          })
          .from(user)
          .leftJoin(localCredential, eq(localCredential.userId, user.userId))
          .where(where)
          .orderBy(asc(user.employeeNo))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
      ]);
      return { total: total?.n ?? 0, page, pageSize, items: rows };
    },
  );

  async function userDetail(userId: number) {
    const [u] = await app.db.select().from(user).where(eq(user.userId, userId));
    if (!u) throw new GwError('VALIDATION_FAILED', '使用者不存在', [{ field: 'id', message: String(userId) }]);
    const [companies, roles, [cred], sessions] = await Promise.all([
      app.db
        .select({
          companyId: company.companyId,
          compName: company.compName,
          viaEmployeeNo: userCompany.viaEmployeeNo,
          deptCode: userCompany.deptCode,
          department: userCompany.department,
          isVirtual: userCompany.isVirtual,
          isPrimary: userCompany.isPrimary,
        })
        .from(userCompany)
        .innerJoin(company, eq(company.companyId, userCompany.companyId))
        .where(eq(userCompany.userId, userId)),
      app.db
        .select({
          code: role.code,
          name: role.name,
          validFrom: userRole.validFrom,
          validTo: userRole.validTo,
          reason: userRole.reason,
          createdBy: userRole.createdBy,
        })
        .from(userRole)
        .innerJoin(role, eq(role.roleId, userRole.roleId))
        .where(eq(userRole.userId, userId))
        .orderBy(asc(role.code)),
      app.db
        .select({
          status: localCredential.status,
          registeredVia: localCredential.registeredVia,
          failedCount: localCredential.failedCount,
          lockedAt: localCredential.lockedAt,
          mustChangePassword: localCredential.mustChangePassword,
          passwordChangedAt: localCredential.passwordChangedAt,
          approvedBy: localCredential.approvedBy,
          approvedAt: localCredential.approvedAt,
          createdAt: localCredential.createdAt,
        })
        .from(localCredential)
        .where(eq(localCredential.userId, userId)),
      userSessionCount(app.redis, userId).catch(() => null),
    ]);
    // 不輸出內部欄位(人事雜湊、通知偏好)
    const { adGroups, profileHash: _h, notifyPref: _n, rowVer, ...rest } = u;
    return {
      ...rest,
      adGroups: parseGroups(adGroups),
      rowVer: rowVerToHex(rowVer),
      companies,
      roles,
      localAccount: cred ?? null,
      sessions,
    };
  }

  app.get<{ Params: { id: string } }>('/api/admin/users/:id', { schema: { params: REF_PARAMS } }, async (req) => {
    await authorize(req, USER_READ);
    return userDetail((await findUser(req.params.id)).userId);
  });

  app.patch<{ Params: { id: string }; Body: { rowVer: string; isDisabled?: boolean; roles?: RoleAssign[] } }>(
    '/api/admin/users/:id',
    {
      schema: {
        params: REF_PARAMS,
        body: {
          type: 'object',
          required: ['rowVer'],
          additionalProperties: false,
          properties: {
            rowVer: ROW_VER,
            isDisabled: { type: 'boolean' },
            roles: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                required: ['code'],
                additionalProperties: false,
                properties: {
                  code: { type: 'string', minLength: 1, maxLength: 50 },
                  validTo: { type: ['string', 'null'], format: 'date-time' },
                  reason: { type: ['string', 'null'], maxLength: 200 },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, USER_WRITE);
      const b = req.body;
      const u = await findUser(req.params.id);
      if (b.isDisabled === true && actor.userId === u.userId)
        throw new GwError('VALIDATION_FAILED', '不可停用自己的帳號', [{ field: 'isDisabled', message: '' }]);

      const current = await app.db
        .select({ roleId: userRole.roleId, code: role.code, validFrom: userRole.validFrom, validTo: userRole.validTo, reason: userRole.reason })
        .from(userRole)
        .innerJoin(role, eq(role.roleId, userRole.roleId))
        .where(eq(userRole.userId, u.userId));
      let next: { roleId: number; code: string; validFrom: Date; validTo: Date | null; reason: string | null }[] | null = null;
      if (b.roles) {
        const codes = [...new Set(b.roles.map((r) => r.code))];
        if (codes.length !== b.roles.length) throw new GwError('VALIDATION_FAILED', '角色重複', [{ field: 'roles', message: '同一角色只能出現一次' }]);
        const found = codes.length ? await app.db.select({ id: role.roleId, code: role.code }).from(role).where(inArray(role.code, codes)) : [];
        const missing = codes.filter((c) => !found.some((f) => f.code === c));
        if (missing.length)
          throw new GwError(
            'VALIDATION_FAILED',
            '角色不存在',
            missing.map((m) => ({ field: 'roles', message: m })),
          );
        const now = new Date();
        next = b.roles.map((r) => {
          const validTo = r.validTo ? new Date(r.validTo) : null;
          if (validTo && validTo <= now) throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'roles', message: `${r.code} 的到期時間需晚於現在` }]);
          const cur = current.find((c) => c.code === r.code);
          return { roleId: found.find((f) => f.code === r.code)!.id, code: r.code, validFrom: cur?.validFrom ?? now, validTo, reason: r.reason ?? null };
        });
        // 新增或移除的角色:其權限須是操作人本身具備的
        const changed = [
          ...next.filter((n) => !current.some((c) => c.roleId === n.roleId)),
          ...current.filter((c) => !next!.some((n) => n.roleId === c.roleId)),
        ];
        if (changed.length) {
          const mine = await actor.permissions();
          const lacking = (
            await permissionsOf(
              app.db,
              changed.map((c) => c.roleId),
            )
          ).filter((p) => !mine.has(p));
          if (lacking.length)
            throw new GwError(
              'PERMISSION_DENIED',
              '不可指派或移除含有您沒有的權限的角色',
              lacking.map((p) => ({ field: 'roles', message: p })),
            );
        }
      }

      await app.db.transaction(async (tx) => {
        const rows = await tx
          .update(user)
          .set({ ...(b.isDisabled !== undefined ? { isDisabled: b.isDisabled } : {}), permVersion: sql`${user.permVersion} + 1`, updatedBy: actor.name })
          .output({ inserted: { id: user.userId } })
          .where(and(eq(user.userId, u.userId), eq(user.rowVer, verOf(b.rowVer))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        if (next) {
          await tx.delete(userRole).where(eq(userRole.userId, u.userId));
          for (const n of next)
            await tx
              .insert(userRole)
              .values({ userId: u.userId, roleId: n.roleId, validFrom: n.validFrom, validTo: n.validTo, reason: n.reason, createdBy: actor.name });
        }
        await writeAudit(
          tx,
          actor,
          'user.update',
          'user',
          u.employeeNo,
          { isDisabled: u.isDisabled, roles: current.map((c) => ({ code: c.code, validTo: c.validTo, reason: c.reason })) },
          { isDisabled: b.isDisabled, roles: next?.map((n) => ({ code: n.code, validTo: n.validTo, reason: n.reason })) },
        );
      });
      // 停用:撤銷 Refresh Token 家族;Access Token 因 pv 變更下一次請求即失效
      if (b.isDisabled === true) await revokeUserSessions(app.redis, u.userId).catch((err: Error) => req.log.warn({ err: err.message }, '撤銷登入失敗'));
      await invalidatePv([u.userId]);
      return userDetail(u.userId);
    },
  );

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/revoke-sessions', { schema: { params: REF_PARAMS } }, async (req) => {
    const actor = await authorize(req, USER_WRITE);
    const u = await findUser(req.params.id);
    await app.db.transaction(async (tx) => {
      await tx
        .update(user)
        .set({ permVersion: sql`${user.permVersion} + 1`, updatedBy: actor.name })
        .where(eq(user.userId, u.userId));
      await writeAudit(tx, actor, 'user.revoke_sessions', 'user', u.employeeNo, null, {});
    });
    const revoked = await revokeUserSessions(app.redis, u.userId);
    await invalidatePv([u.userId]);
    return { employeeNo: u.employeeNo, revokedSessions: revoked };
  });

  // ───────── 公司 ─────────

  async function companyOut(rows: (typeof company.$inferSelect)[]) {
    const ids = rows.map((c) => c.companyId);
    const [domains, roles, members] = ids.length
      ? await Promise.all([
          app.db.select().from(companyAdDomain).where(inArray(companyAdDomain.companyId, ids)).orderBy(asc(companyAdDomain.tryOrder)),
          app.db
            .select({ companyId: roleCompany.companyId, code: role.code, name: role.name })
            .from(roleCompany)
            .innerJoin(role, eq(role.roleId, roleCompany.roleId))
            .where(inArray(roleCompany.companyId, ids)),
          app.db
            .select({ companyId: userCompany.companyId, n: sql<number>`count(distinct ${userCompany.userId})` })
            .from(userCompany)
            .where(inArray(userCompany.companyId, ids))
            .groupBy(userCompany.companyId),
        ])
      : [[], [], []];
    return rows.map((c) => ({
      ...c,
      rowVer: rowVerToHex(c.rowVer),
      adDomains: domains.filter((d) => d.companyId === c.companyId).map((d) => d.domainCode),
      roles: roles.filter((r) => r.companyId === c.companyId).map(({ code, name }) => ({ code, name })),
      users: members.find((m) => m.companyId === c.companyId)?.n ?? 0,
    }));
  }

  app.get('/api/admin/companies', async (req) => {
    await authorize(req, COMPANY_READ);
    const rows = await app.db.select().from(company).orderBy(asc(company.compName));
    return { domainCodes: app.ad.codes, items: await companyOut(rows) };
  });

  /** 公司成員(含兼任)的 user_id:公司預設角色、啟用狀態變更時遞增其 pv */
  const membersOf = async (companyId: number) =>
    (await app.db.selectDistinct({ id: userCompany.userId }).from(userCompany).where(eq(userCompany.companyId, companyId))).map((r) => r.id);

  async function updateCompany(
    companyId: number,
    rowVer: string,
    actorName: string,
    extra: Partial<typeof company.$inferInsert>,
    fn: (tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0]) => Promise<void>,
  ) {
    await app.db.transaction(async (tx) => {
      const rows = await tx
        .update(company)
        .set({ ...extra, updatedBy: actorName })
        .output({ inserted: { id: company.companyId } })
        .where(and(eq(company.companyId, companyId), eq(company.rowVer, verOf(rowVer))));
      if (!rows.length) throw new GwError('VERSION_CONFLICT');
      await fn(tx);
    });
    return (await companyOut([await findCompany(companyId)]))[0];
  }

  const bumpUsers = (tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0], ids: number[], actorName: string) =>
    ids.length
      ? tx
          .update(user)
          .set({ permVersion: sql`${user.permVersion} + 1`, updatedBy: actorName })
          .where(inArray(user.userId, ids))
      : Promise.resolve();

  app.patch<{ Params: { id: number }; Body: { rowVer: string; compFullName?: string | null; empPrefix?: string | null; isEnabled?: boolean } }>(
    '/api/admin/companies/:id',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          required: ['rowVer'],
          additionalProperties: false,
          properties: {
            rowVer: ROW_VER,
            compFullName: { type: ['string', 'null'], maxLength: 100 },
            empPrefix: { type: ['string', 'null'], maxLength: 5, pattern: '^[A-Z]*$' },
            isEnabled: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, COMPANY_WRITE);
      const c = await findCompany(req.params.id);
      const { rowVer, ...changes } = req.body;
      // 停用公司:該公司的預設角色與規則不再套用,成員權限需重新計算
      const members = changes.isEnabled !== undefined && changes.isEnabled !== c.isEnabled ? await membersOf(c.companyId) : [];
      const out = await updateCompany(c.companyId, rowVer, actor.name, changes, async (tx) => {
        await bumpUsers(tx, members, actor.name);
        await writeAudit(
          tx,
          actor,
          'company.update',
          'company',
          c.compName,
          { compFullName: c.compFullName, empPrefix: c.empPrefix, isEnabled: c.isEnabled },
          changes,
        );
      });
      await invalidatePv(members);
      return out;
    },
  );

  app.put<{ Params: { id: number }; Body: { rowVer: string; domains: string[] } }>(
    '/api/admin/companies/:id/ad-domains',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          required: ['rowVer', 'domains'],
          additionalProperties: false,
          properties: { rowVer: ROW_VER, domains: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 30 } } },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, COMPANY_WRITE);
      const c = await findCompany(req.params.id);
      const unknown = req.body.domains.filter((d) => !app.ad.codes.includes(d));
      if (unknown.length)
        throw new GwError(
          'VALIDATION_FAILED',
          'AD 網域不存在',
          unknown.map((d) => ({ field: 'domains', message: d })),
        );
      const before = (await companyOut([c]))[0]!.adDomains;
      // 只影響登入時嘗試的網域(PRD §8.2.5),不影響權限
      return updateCompany(c.companyId, req.body.rowVer, actor.name, {}, async (tx) => {
        await tx.delete(companyAdDomain).where(eq(companyAdDomain.companyId, c.companyId));
        for (const [i, d] of req.body.domains.entries()) await tx.insert(companyAdDomain).values({ companyId: c.companyId, domainCode: d, tryOrder: i + 1 });
        await writeAudit(tx, actor, 'company.ad_domains', 'company', c.compName, { domains: before }, { domains: req.body.domains });
      });
    },
  );

  app.put<{ Params: { id: number }; Body: { rowVer: string; roles: string[] } }>(
    '/api/admin/companies/:id/roles',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          required: ['rowVer', 'roles'],
          additionalProperties: false,
          properties: { rowVer: ROW_VER, roles: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 50 } } },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, COMPANY_WRITE);
      const c = await findCompany(req.params.id);
      const found = req.body.roles.length ? await app.db.select({ id: role.roleId, code: role.code }).from(role).where(inArray(role.code, req.body.roles)) : [];
      const missing = req.body.roles.filter((r) => !found.some((f) => f.code === r));
      if (missing.length)
        throw new GwError(
          'VALIDATION_FAILED',
          '角色不存在',
          missing.map((m) => ({ field: 'roles', message: m })),
        );
      const before = (await companyOut([c]))[0]!.roles.map((r) => r.code);
      const members = await membersOf(c.companyId);
      const out = await updateCompany(c.companyId, req.body.rowVer, actor.name, {}, async (tx) => {
        await tx.delete(roleCompany).where(eq(roleCompany.companyId, c.companyId));
        for (const f of found) await tx.insert(roleCompany).values({ roleId: f.id, companyId: c.companyId, createdBy: actor.name });
        await bumpUsers(tx, members, actor.name);
        await writeAudit(tx, actor, 'company.roles', 'company', c.compName, { roles: before }, { roles: req.body.roles });
      });
      await invalidatePv(members);
      return out;
    },
  );

  // ───────── 本機帳號 ─────────

  app.get<{ Querystring: { status?: string; q?: string; page?: number; pageSize?: number } }>(
    '/api/admin/local-accounts',
    {
      schema: {
        querystring: { type: 'object', properties: { status: { type: 'string', maxLength: 100 }, q: { type: 'string', maxLength: 100 }, ...PAGING } },
      },
    },
    async (req) => {
      await authorize(req, LOCAL_READ);
      const { q, page = 1, pageSize = 50 } = req.query;
      const statuses = (req.query.status ?? '')
        .split(',')
        .filter((s): s is (typeof LOCAL_STATUSES)[number] => (LOCAL_STATUSES as readonly string[]).includes(s));
      const conds: (SQL | undefined)[] = [];
      if (statuses.length) conds.push(inArray(localCredential.status, statuses));
      if (q?.trim()) conds.push(or(like(user.employeeNo, likeOf(q.trim())), like(user.displayName, likeOf(q.trim()))));
      const where = and(...conds);
      const [[total], rows] = await Promise.all([
        app.db.select({ n: count() }).from(localCredential).innerJoin(user, eq(user.userId, localCredential.userId)).where(where),
        app.db
          .select({
            userId: user.userId,
            employeeNo: user.employeeNo,
            displayName: user.displayName,
            email: user.email,
            orgName: user.orgName,
            department: user.department,
            isDisabled: user.isDisabled,
            status: localCredential.status,
            registeredVia: localCredential.registeredVia,
            failedCount: localCredential.failedCount,
            lockedAt: localCredential.lockedAt,
            mustChangePassword: localCredential.mustChangePassword,
            passwordChangedAt: localCredential.passwordChangedAt,
            approvedBy: localCredential.approvedBy,
            approvedAt: localCredential.approvedAt,
            managerNotifiedAt: localCredential.managerNotifiedAt,
            createdAt: localCredential.createdAt,
            lastLoginAt: user.lastLoginAt,
          })
          .from(localCredential)
          .innerJoin(user, eq(user.userId, localCredential.userId))
          .where(where)
          .orderBy(desc(localCredential.createdAt))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
      ]);
      return { total: total?.n ?? 0, page, pageSize, items: rows };
    },
  );

  const activation = (r: { employeeNo: string; userId: number; token: string }) => ({
    employeeNo: r.employeeNo,
    userId: r.userId,
    link: localAdmin.activationLink(config.publicBaseUrl, r.token),
    expiresInHours: localAdmin.ACTIVATE_TTL_HOURS,
  });

  app.post<{ Body: { employeeNo: string } }>(
    '/api/admin/local-accounts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['employeeNo'],
          additionalProperties: false,
          properties: { employeeNo: { type: 'string', minLength: 2, maxLength: 20 } },
        },
      },
    },
    async (req, reply) => {
      const actor = await authorize(req, LOCAL_WRITE);
      const r = await localAdmin.createLocalAccount({ ...localDeps, ad: app.ad, ext: app.ext }, req.body.employeeNo, actor);
      return reply.code(201).send(activation(r));
    },
  );

  /** :id(user_id 或工號)→ 工號 */
  const empOf = async (ref: string) => (await findUser(ref)).employeeNo;

  app.post<{ Params: { id: string } }>('/api/admin/local-accounts/:id/approve', { schema: { params: REF_PARAMS } }, async (req) => {
    const actor = await authorize(req, LOCAL_WRITE);
    return activation(await localAdmin.approveLocalAccount(localDeps, await empOf(req.params.id), actor));
  });

  app.post<{ Params: { id: string } }>('/api/admin/local-accounts/:id/reset-password', { schema: { params: REF_PARAMS } }, async (req) => {
    const actor = await authorize(req, LOCAL_WRITE);
    const r = await localAdmin.resetLocalPassword(localDeps, await empOf(req.params.id), actor);
    return { employeeNo: r.employeeNo, temporaryPassword: r.temporaryPassword, mustChangePassword: true, revokedSessions: r.revokedSessions };
  });

  app.post<{ Params: { id: string } }>('/api/admin/local-accounts/:id/unlock', { schema: { params: REF_PARAMS } }, async (req) => {
    const actor = await authorize(req, LOCAL_WRITE);
    return localAdmin.unlockLocalAccount(localDeps, await empOf(req.params.id), actor);
  });

  app.post<{ Params: { id: string } }>('/api/admin/local-accounts/:id/disable', { schema: { params: REF_PARAMS } }, async (req) => {
    const actor = await authorize(req, LOCAL_WRITE);
    return localAdmin.disableLocalAccount(localDeps, await empOf(req.params.id), actor);
  });
};

export default users;
