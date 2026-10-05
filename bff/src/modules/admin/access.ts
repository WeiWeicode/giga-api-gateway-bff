/**
 * 存取反查(PRD §8.7、P2-6):權限 gw.admin.rbac.read。
 *
 *   GET /api/admin/routes/:id/who-can-access         某條路由誰能呼叫:依 auth_mode,列出具備其權限的角色與角色來源(所有登入者、AD 群組、
 *                                                     公司預設、指派規則、個別指派)、直接授予的部門 / 個人(v0.12)及具備該權限的 API Key
 *   GET /api/admin/users/:id/effective-permissions    使用者的有效角色(含來源與命中規則)、權限(含授予的角色)、應用;與登入計算同一函式
 *   GET /api/admin/permissions/:code/who-can-access   同上,以權限代碼查詢(選單 / 按鈕權限沒有對應路由時使用)
 */
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  apiClient,
  apiClientPermission,
  apiRoute,
  company,
  department,
  deptPermission,
  permission,
  role,
  roleAdGroup,
  roleCompany,
  rolePermission,
  roleRule,
  user,
  userPermission,
  userRole,
} from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { normalizeEmpNo } from '../auth/profile.js';
import { appsOf, DEFAULT_ROLE, loadUserFacts, resolveDirectGrants, resolveRoles } from '../rbac/permission.js';
import { parseJobLevels } from '../rbac/rules.js';
import { createAuthorizer } from './authorize.js';

const READ = 'gw.admin.rbac.read';

const access: FastifyPluginAsync = async (app) => {
  const authorize = createAuthorizer(app);

  /** 具備某權限的角色與其來源,以及具備該權限的 API Key */
  async function whoHas(code: string) {
    const [perm] = await app.db.select().from(permission).where(eq(permission.code, code));
    if (!perm) return { permission: code, exists: false, roles: [], direct: { departments: [], users: [] }, apiClients: [] };
    const roles = await app.db
      .select({ id: role.roleId, code: role.code, name: role.name })
      .from(rolePermission)
      .innerJoin(role, eq(role.roleId, rolePermission.roleId))
      .where(eq(rolePermission.permissionId, perm.permissionId))
      .orderBy(asc(role.code));
    const ids = roles.map((r) => r.id);
    const now = new Date();
    const [groups, companies, rules, users, clients, deptGrants, userGrants] = await Promise.all([
      ids.length ? app.db.select({ roleId: roleAdGroup.roleId, dn: roleAdGroup.adGroupDn }).from(roleAdGroup).where(inArray(roleAdGroup.roleId, ids)) : [],
      ids.length
        ? app.db
            .select({ roleId: roleCompany.roleId, name: company.compName })
            .from(roleCompany)
            .innerJoin(company, eq(company.companyId, roleCompany.companyId))
            .where(inArray(roleCompany.roleId, ids))
        : [],
      ids.length
        ? app.db
            .select()
            .from(roleRule)
            .where(and(inArray(roleRule.roleId, ids), eq(roleRule.isEnabled, true)))
        : [],
      ids.length
        ? app.db
            .select({ roleId: userRole.roleId, employeeNo: user.employeeNo, name: user.displayName, validTo: userRole.validTo })
            .from(userRole)
            .innerJoin(user, eq(user.userId, userRole.userId))
            .where(and(inArray(userRole.roleId, ids), or(isNull(userRole.validTo), gt(userRole.validTo, now))))
        : [],
      app.db
        .select({ code: apiClient.code, name: apiClient.name, isEnabled: apiClient.isEnabled, expiresAt: apiClient.expiresAt })
        .from(apiClientPermission)
        .innerJoin(apiClient, eq(apiClient.clientId, apiClientPermission.clientId))
        .where(eq(apiClientPermission.permissionId, perm.permissionId))
        .orderBy(asc(apiClient.code)),
      app.db
        .select({ deptCode: deptPermission.deptCode, name: department.name, jobTier: deptPermission.jobTier, includeSubDepts: deptPermission.includeSubDepts })
        .from(deptPermission)
        .innerJoin(department, eq(department.deptCode, deptPermission.deptCode))
        .where(eq(deptPermission.permissionId, perm.permissionId))
        .orderBy(asc(deptPermission.deptCode)),
      app.db
        .select({ employeeNo: user.employeeNo, name: user.displayName, validTo: userPermission.validTo, reason: userPermission.reason })
        .from(userPermission)
        .innerJoin(user, eq(user.userId, userPermission.userId))
        .where(and(eq(userPermission.permissionId, perm.permissionId), or(isNull(userPermission.validTo), gt(userPermission.validTo, now))))
        .orderBy(asc(user.employeeNo)),
    ]);
    const companyNames = new Map((await app.db.select({ id: company.companyId, name: company.compName }).from(company)).map((c) => [c.id, c.name]));
    return {
      permission: code,
      exists: true,
      name: perm.name,
      kind: perm.kind,
      roles: roles.map((r) => ({
        code: r.code,
        name: r.name,
        // employee 為所有登入者的預設角色(PRD §8.3)
        everyone: r.code === DEFAULT_ROLE,
        adGroups: groups.filter((g) => g.roleId === r.id).map((g) => g.dn),
        companies: companies.filter((c) => c.roleId === r.id).map((c) => c.name),
        rules: rules
          .filter((x) => x.roleId === r.id)
          .map((x) => ({
            ruleId: x.ruleId,
            company: x.companyId ? (companyNames.get(x.companyId) ?? null) : null,
            deptCode: x.deptCode,
            includeSubDepts: x.includeSubDepts,
            jobLevels: parseJobLevels(x.jobLevels),
            title: x.title,
            description: x.description,
          })),
        users: users.filter((u) => u.roleId === r.id).map(({ roleId: _, ...u }) => u),
      })),
      // 直接授予(v0.12)
      direct: { departments: deptGrants, users: userGrants },
      apiClients: clients.map((c) => ({ ...c, active: c.isEnabled && (!c.expiresAt || c.expiresAt > now) })),
    };
  }

  app.get<{ Params: { id: number } }>(
    '/api/admin/routes/:id/who-can-access',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } } },
    async (req) => {
      await authorize(req, READ);
      const [r] = await app.db
        .select({
          routeCode: apiRoute.routeCode,
          method: apiRoute.method,
          publicPath: apiRoute.publicPath,
          authMode: apiRoute.authMode,
          permissionCode: apiRoute.permissionCode,
          status: apiRoute.status,
        })
        .from(apiRoute)
        .where(eq(apiRoute.routeId, req.params.id));
      if (!r) throw new GwError('VALIDATION_FAILED', '路由不存在', [{ field: 'id', message: String(req.params.id) }]);
      const summary: Record<string, string> = {
        public: '任何人(不需登入)',
        authenticated: '所有登入者',
        permission: `具備權限 ${r.permissionCode} 的使用者`,
        api_key: r.permissionCode ? `具備權限 ${r.permissionCode} 的 API Key(系統對系統)` : '任何有效的 API Key(系統對系統)',
      };
      if (!r.permissionCode) return { route: r, summary: summary[r.authMode] ?? r.authMode, access: null };
      const who = await whoHas(r.permissionCode);
      // api_key 路由只檢查 API Key;permission 路由只檢查使用者(PRD §8.4、P2-5)
      return {
        route: r,
        summary: summary[r.authMode] ?? r.authMode,
        access: r.authMode === 'api_key' ? { ...who, roles: [] } : { ...who, apiClients: [] },
      };
    },
  );

  app.get<{ Params: { code: string } }>(
    '/api/admin/permissions/:code/who-can-access',
    { schema: { params: { type: 'object', required: ['code'], properties: { code: { type: 'string', minLength: 1, maxLength: 100 } } } } },
    async (req) => {
      await authorize(req, READ);
      return whoHas(req.params.code);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/admin/users/:id/effective-permissions',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 20 } } } } },
    async (req) => {
      await authorize(req, READ);
      const ref = req.params.id;
      const [u] = await app.db
        .select({ userId: user.userId, employeeNo: user.employeeNo, displayName: user.displayName, isDisabled: user.isDisabled })
        .from(user)
        .where(/^\d+$/.test(ref) ? eq(user.userId, Number(ref)) : eq(user.employeeNo, normalizeEmpNo(ref)));
      if (!u) throw new GwError('VALIDATION_FAILED', '使用者不存在', [{ field: 'id', message: ref }]);
      const { pv, companyNames, facts } = await loadUserFacts(app.db, u.userId);
      const roles = await resolveRoles(app.db, facts);
      const grants = roles.length
        ? await app.db
            .select({ roleId: rolePermission.roleId, code: permission.code, name: permission.name, kind: permission.kind })
            .from(rolePermission)
            .innerJoin(permission, eq(permission.permissionId, rolePermission.permissionId))
            .where(
              inArray(
                rolePermission.roleId,
                roles.map((r) => r.roleId),
              ),
            )
        : [];
      const roleCode = new Map(roles.map((r) => [r.roleId, r.code]));
      type Entry = {
        code: string;
        name: string;
        kind: string;
        grantedBy: string[];
        /** 直接授予的部門(v0.12) */
        depts: { deptCode: string; jobTier: string; includeSubDepts: boolean }[];
        /** 個人權限(v0.12) */
        personal: { validTo: Date | null; reason: string | null } | null;
      };
      const byCode = new Map<string, Entry>();
      for (const g of grants) {
        const cur = byCode.get(g.code) ?? { code: g.code, name: g.name, kind: g.kind, grantedBy: [], depts: [], personal: null };
        cur.grantedBy.push(roleCode.get(g.roleId)!);
        byCode.set(g.code, cur);
      }
      const direct = await resolveDirectGrants(app.db, facts);
      const missing = [...new Set(direct.map((d) => d.code))].filter((c) => !byCode.has(c));
      if (missing.length)
        for (const p of await app.db
          .select({ code: permission.code, name: permission.name, kind: permission.kind })
          .from(permission)
          .where(inArray(permission.code, missing)))
          byCode.set(p.code, { ...p, grantedBy: [], depts: [], personal: null });
      for (const d of direct) {
        const cur = byCode.get(d.code);
        if (!cur) continue;
        if (d.source === 'dept') cur.depts.push({ deptCode: d.deptCode, jobTier: d.jobTier, includeSubDepts: d.includeSubDepts });
        else cur.personal = { validTo: d.validTo, reason: d.reason };
      }
      const permissions = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
      return {
        user: { ...u, permVersion: pv, companies: companyNames },
        facts: { adGroups: facts.adGroups, memberships: facts.memberships, jobLevel: facts.jobLevel, title: facts.title },
        roles: roles.map((r) => ({ code: r.code, sources: r.sources, ruleIds: r.ruleIds })),
        permissions,
        apps: await appsOf(
          app.db,
          permissions.map((p) => p.code),
        ),
      };
    },
  );
};

export default access;
