/**
 * 權限設定管理 API(PRD §8.7、P2-3a,供 GigaItApp):API Key 或登入者皆可,讀 gw.admin.rbac.read、寫 gw.admin.rbac.write。
 *
 *   GET    /api/admin/permissions?tree=1&app=&system=      權限清單 / 依 kind、parent_code、sort 的權限樹
 *   GET    /api/admin/roles                                角色清單(含權限、規則、AD 群組、公司數)
 *   GET    /api/admin/roles/:role/permissions              角色的權限代碼(:role 為角色代碼或 id)
 *   PUT    /api/admin/roles/:role/permissions              取代角色的權限
 *   GET    /api/admin/roles/:role/rules                    指派規則
 *   POST   /api/admin/roles/:role/rules                    新增規則
 *   PATCH  /api/admin/roles/:role/rules/:ruleId            修改規則
 *   DELETE /api/admin/roles/:role/rules/:ruleId            刪除規則
 *   GET    /api/admin/departments                          部門樹(含人數)
 *   GET    /api/admin/apps                                 應用登記(維護以 CLI apply)
 *   POST   /api/admin/rbac/preview                         權限試算(與登入計算同一函式)
 *   (角色 / 權限的新增、修改、刪除與 AD 群組對應見 roles.ts;存取反查見 access.ts)
 *
 * 寫入:同一交易寫入資料與 gw.audit_log(actor 為實際操作人),遞增全體 perm_version,提交後清除 pv 快取(DATABASE.md §7.2)。
 */
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  app as appTable,
  company,
  department,
  permission,
  role,
  roleAdGroup,
  roleCompany,
  rolePermission,
  roleRule,
  rowVerToHex,
  user,
} from '../../db/schema/index.js';
import type { AppConfig } from '../../config.js';
import { isGrantableKind } from '../../cli/openapi.js';
import { GwError } from '../../errors.js';
import { ApiKeyService } from '../auth/api-key.js';
import { isValidEmpNo, normalizeEmpNo } from '../auth/profile.js';
import { openCompanyIds } from '../rbac/login-companies.js';
import {
  appsOf,
  bumpAllPermVersions,
  expandIncludes,
  includesOf,
  permissionsOf,
  loadUserFacts,
  resolveDirectGrants,
  resolveRoles,
  type AuthzFacts,
} from '../rbac/permission.js';
import { hasCondition, parseJobLevels } from '../rbac/rules.js';
import { audit } from './route-import.js';

const READ = 'gw.admin.rbac.read';
const WRITE = 'gw.admin.rbac.write';
/** 內建超級管理員的權限不開放以 API 修改,避免誤操作後無人能管理權限 */
const PROTECTED_ROLES = new Set(['gw-super-admin']);

interface RuleBody {
  companyId?: number | null;
  deptCode?: string | null;
  includeSubDepts?: boolean;
  jobLevels?: string[] | null;
  title?: string | null;
  description?: string | null;
  isEnabled?: boolean;
}

const nullableStr = (max: number) => ({ type: ['string', 'null'], maxLength: max });
const ruleProps = {
  companyId: { type: ['integer', 'null'] },
  deptCode: nullableStr(30),
  includeSubDepts: { type: 'boolean' },
  jobLevels: { type: ['array', 'null'], maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 10 } },
  title: nullableStr(100),
  description: nullableStr(200),
  isEnabled: { type: 'boolean' },
} as const;

type PermNode = { code: string; name: string; kind: string; sort: number | null; icon: string | null; children: PermNode[] };
type DeptNode = { deptCode: string; name: string; companyId: number | null; userCount: number; children: DeptNode[] };

const rbacRoutes: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  const apiKeys = new ApiKeyService(app.db, app.redis, app.log);

  /** API Key(系統帳號)或登入者;回傳寫入稽核用的操作人 */
  async function authorize(req: FastifyRequest, perm: string): Promise<string> {
    const key = req.headers['x-api-key'];
    if (typeof key === 'string' && key) {
      const c = await apiKeys.verify(key, req.ip);
      if (!c.permissions.has(perm)) throw new GwError('PERMISSION_DENIED');
      return `client:${c.code}`;
    }
    const p = await req.requirePrincipal();
    if (!(await app.perms.has(p.userId, p.claims.pv, perm))) throw new GwError('PERMISSION_DENIED');
    return p.claims.emp;
  }

  async function findRole(ref: string) {
    const [r] = await app.db
      .select()
      .from(role)
      .where(/^\d+$/.test(ref) ? eq(role.roleId, Number(ref)) : eq(role.code, ref));
    if (!r) throw new GwError('VALIDATION_FAILED', '角色不存在', [{ field: 'role', message: ref }]);
    return r;
  }

  /** 寫入:資料 + 稽核 + 全體 pv 遞增同一交易;提交後清除 pv 快取 */
  async function writeRbac<T>(actor: string, fn: (tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0]) => Promise<T>): Promise<T> {
    const result = await app.db.transaction(async (tx) => {
      const r = await fn(tx);
      await bumpAllPermVersions(tx, actor);
      return r;
    });
    await app.perms.invalidatePv('all').catch((err: Error) => app.log.warn({ err: err.message }, 'pv 快取清除失敗(15 分鐘內自然過期)'));
    return result;
  }

  async function validateRule(b: RuleBody) {
    const errors: { field: string; message: string }[] = [];
    if (!hasCondition({ companyId: b.companyId ?? null, deptCode: b.deptCode ?? null, jobLevels: b.jobLevels ?? null, title: b.title ?? null }))
      errors.push({ field: 'rule', message: '至少要有一個條件(公司、部門、職級、職稱)' });
    if (b.companyId != null && !(await app.db.select({ id: company.companyId }).from(company).where(eq(company.companyId, b.companyId))).length)
      errors.push({ field: 'companyId', message: '公司不存在' });
    if (b.deptCode) {
      // 部門代碼須存在於部門樹或人事資料(部門同步尚未執行時仍可依人事資料設定)
      const [d] = await app.db.select({ c: department.deptCode }).from(department).where(eq(department.deptCode, b.deptCode));
      const [u] = d ? [d] : await app.db.select({ c: user.deptCode }).top(1).from(user).where(eq(user.deptCode, b.deptCode));
      if (!u) errors.push({ field: 'deptCode', message: '部門代碼不存在' });
    }
    if (errors.length) throw new GwError('VALIDATION_FAILED', undefined, errors);
  }

  const ruleOut = (r: typeof roleRule.$inferSelect) => ({
    ruleId: r.ruleId,
    companyId: r.companyId,
    deptCode: r.deptCode,
    includeSubDepts: r.includeSubDepts,
    jobLevels: parseJobLevels(r.jobLevels),
    title: r.title,
    description: r.description,
    isEnabled: r.isEnabled,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  });

  app.get<{ Querystring: { tree?: string; app?: string; system?: string } }>(
    '/api/admin/permissions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { tree: { type: 'string', maxLength: 5 }, app: { type: 'string', maxLength: 30 }, system: { type: 'string', maxLength: 30 } },
        },
      },
    },
    async (req) => {
      await authorize(req, READ);
      const rows = await app.db
        .select({
          permissionId: permission.permissionId,
          code: permission.code,
          name: permission.name,
          systemCode: permission.systemCode,
          description: permission.description,
          kind: permission.kind,
          parentCode: permission.parentCode,
          sort: permission.sort,
          icon: permission.icon,
          rowVer: permission.rowVer,
        })
        .from(permission)
        .where(req.query.system ? eq(permission.systemCode, req.query.system) : undefined)
        .orderBy(asc(permission.code));
      // 清單模式含 rowVer(修改 / 刪除權限用,roles.ts)與選單隨附的 API 讀取權限
      if (!['1', 'true'].includes(req.query.tree ?? '')) {
        const inc = await includesOf(app.db);
        return { items: rows.map((r) => ({ ...r, rowVer: rowVerToHex(r.rowVer), includes: inc.get(r.code) ?? [] })) };
      }

      const nodes = new Map<string, PermNode>(
        rows.map((r) => [r.code, { code: r.code, name: r.name, kind: r.kind, sort: r.sort, icon: r.icon, children: [] }]),
      );
      const roots: PermNode[] = [];
      for (const r of rows) {
        const parent = r.parentCode && r.parentCode !== r.code ? nodes.get(r.parentCode) : undefined;
        (parent ? parent.children : roots).push(nodes.get(r.code)!);
      }
      const order = (list: PermNode[]) => {
        list.sort((a, b) => (a.sort ?? 32767) - (b.sort ?? 32767) || a.code.localeCompare(b.code));
        list.forEach((n) => order(n.children));
      };
      order(roots);
      if (!req.query.app) return { items: roots };
      // 以應用的 app 權限為根(PRD §8.7 ?tree=1&app=)
      const [a] = await app.db.select({ permissionCode: appTable.permissionCode }).from(appTable).where(eq(appTable.code, req.query.app));
      if (!a) throw new GwError('VALIDATION_FAILED', '應用不存在', [{ field: 'app', message: req.query.app }]);
      const root = nodes.get(a.permissionCode);
      return { items: root ? [root] : [] };
    },
  );

  app.get('/api/admin/roles', async (req) => {
    await authorize(req, READ);
    const counted = <T extends typeof rolePermission | typeof roleRule | typeof roleAdGroup | typeof roleCompany>(t: T) =>
      app.db
        .select({ roleId: t.roleId, n: count() })
        .from(t as typeof rolePermission)
        .groupBy(t.roleId);
    const [roles, perms, rules, groups, companies] = await Promise.all([
      app.db.select().from(role).orderBy(asc(role.code)),
      counted(rolePermission),
      counted(roleRule),
      counted(roleAdGroup),
      counted(roleCompany),
    ]);
    const n = (list: { roleId: number; n: number }[], id: number) => list.find((x) => x.roleId === id)?.n ?? 0;
    return {
      items: roles.map((r) => ({
        roleId: r.roleId,
        code: r.code,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        permissions: n(perms, r.roleId),
        rules: n(rules, r.roleId),
        adGroups: n(groups, r.roleId),
        companies: n(companies, r.roleId),
        rowVer: rowVerToHex(r.rowVer),
      })),
    };
  });

  app.get<{ Params: { role: string } }>('/api/admin/roles/:role/permissions', async (req) => {
    await authorize(req, READ);
    const r = await findRole(req.params.role);
    const rows = await app.db
      .select({ code: permission.code })
      .from(rolePermission)
      .innerJoin(permission, eq(permission.permissionId, rolePermission.permissionId))
      .where(eq(rolePermission.roleId, r.roleId))
      .orderBy(asc(permission.code));
    return { role: r.code, permissions: rows.map((x) => x.code) };
  });

  app.put<{ Params: { role: string }; Body: { permissions: string[] } }>(
    '/api/admin/roles/:role/permissions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['permissions'],
          additionalProperties: false,
          properties: { permissions: { type: 'array', maxItems: 2000, items: { type: 'string', minLength: 1, maxLength: 100 } } },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const r = await findRole(req.params.role);
      if (PROTECTED_ROLES.has(r.code)) throw new GwError('PERMISSION_DENIED', `${r.code} 的權限不開放以 API 修改`);
      const codes = [...new Set(req.body.permissions)];
      const found = codes.length
        ? await app.db
            .select({ id: permission.permissionId, code: permission.code, kind: permission.kind })
            .from(permission)
            .where(inArray(permission.code, codes))
        : [];
      const unknown = codes.filter((c) => !found.some((f) => f.code === c));
      if (unknown.length)
        throw new GwError(
          'VALIDATION_FAILED',
          '權限代碼不存在',
          unknown.map((c) => ({ field: 'permissions', message: c })),
        );
      const groups = found.filter((f) => !isGrantableKind(f.kind));
      if (groups.length)
        throw new GwError(
          'VALIDATION_FAILED',
          '選單目錄不可授予',
          groups.map((g) => ({ field: 'permissions', message: g.code })),
        );
      await writeRbac(actor, async (tx) => {
        await tx.delete(rolePermission).where(eq(rolePermission.roleId, r.roleId));
        for (const f of found) await tx.insert(rolePermission).values({ roleId: r.roleId, permissionId: f.id, createdBy: actor.slice(0, 64) });
        await audit(tx, actor, 'role.permissions.replace', 'role', r.code, { permissions: codes });
      });
      return { role: r.code, permissions: codes.sort() };
    },
  );

  app.get<{ Params: { role: string } }>('/api/admin/roles/:role/rules', async (req) => {
    await authorize(req, READ);
    const r = await findRole(req.params.role);
    const rows = await app.db.select().from(roleRule).where(eq(roleRule.roleId, r.roleId)).orderBy(asc(roleRule.ruleId));
    return { role: r.code, items: rows.map(ruleOut) };
  });

  app.post<{ Params: { role: string }; Body: RuleBody }>(
    '/api/admin/roles/:role/rules',
    { schema: { body: { type: 'object', additionalProperties: false, properties: ruleProps } } },
    async (req, reply) => {
      const actor = await authorize(req, WRITE);
      const r = await findRole(req.params.role);
      await validateRule(req.body);
      const b = req.body;
      const row = await writeRbac(actor, async (tx) => {
        const [created] = await tx
          .insert(roleRule)
          .output()
          .values({
            roleId: r.roleId,
            companyId: b.companyId ?? null,
            deptCode: b.deptCode || null,
            includeSubDepts: b.includeSubDepts ?? true,
            jobLevels: b.jobLevels?.length ? JSON.stringify(b.jobLevels) : null,
            title: b.title || null,
            description: b.description || null,
            isEnabled: b.isEnabled ?? true,
            createdBy: actor.slice(0, 64),
            updatedBy: actor.slice(0, 64),
          });
        await audit(tx, actor, 'role.rule.create', 'role_rule', String(created!.ruleId), { role: r.code, ...b });
        return created!;
      });
      return reply.code(201).send({ role: r.code, ...ruleOut(row) });
    },
  );

  app.patch<{ Params: { role: string; ruleId: string }; Body: RuleBody }>(
    '/api/admin/roles/:role/rules/:ruleId',
    {
      schema: {
        params: { type: 'object', properties: { role: { type: 'string' }, ruleId: { type: 'string', pattern: '^\\d+$' } } },
        body: { type: 'object', additionalProperties: false, properties: ruleProps },
      },
    },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const r = await findRole(req.params.role);
      const [cur] = await app.db
        .select()
        .from(roleRule)
        .where(and(eq(roleRule.ruleId, Number(req.params.ruleId)), eq(roleRule.roleId, r.roleId)));
      if (!cur) throw new GwError('VALIDATION_FAILED', '規則不存在', [{ field: 'ruleId', message: req.params.ruleId }]);
      const b = req.body;
      const merged: RuleBody = {
        companyId: b.companyId !== undefined ? b.companyId : cur.companyId,
        deptCode: b.deptCode !== undefined ? b.deptCode || null : cur.deptCode,
        includeSubDepts: b.includeSubDepts ?? cur.includeSubDepts,
        jobLevels: b.jobLevels !== undefined ? b.jobLevels : parseJobLevels(cur.jobLevels),
        title: b.title !== undefined ? b.title || null : cur.title,
        description: b.description !== undefined ? b.description || null : cur.description,
        isEnabled: b.isEnabled ?? cur.isEnabled,
      };
      await validateRule(merged);
      const row = await writeRbac(actor, async (tx) => {
        const [updated] = await tx
          .update(roleRule)
          .set({
            companyId: merged.companyId ?? null,
            deptCode: merged.deptCode ?? null,
            includeSubDepts: merged.includeSubDepts!,
            jobLevels: merged.jobLevels?.length ? JSON.stringify(merged.jobLevels) : null,
            title: merged.title ?? null,
            description: merged.description ?? null,
            isEnabled: merged.isEnabled!,
            updatedBy: actor.slice(0, 64),
          })
          .where(eq(roleRule.ruleId, cur.ruleId))
          .output();
        await audit(tx, actor, 'role.rule.update', 'role_rule', String(cur.ruleId), { role: r.code, before: ruleOut(cur), after: merged });
        return updated!;
      });
      return { role: r.code, ...ruleOut(row) };
    },
  );

  app.delete<{ Params: { role: string; ruleId: string } }>('/api/admin/roles/:role/rules/:ruleId', async (req, reply) => {
    const actor = await authorize(req, WRITE);
    const r = await findRole(req.params.role);
    const id = Number(req.params.ruleId);
    const [cur] = Number.isInteger(id)
      ? await app.db
          .select()
          .from(roleRule)
          .where(and(eq(roleRule.ruleId, id), eq(roleRule.roleId, r.roleId)))
      : [];
    if (!cur) throw new GwError('VALIDATION_FAILED', '規則不存在', [{ field: 'ruleId', message: req.params.ruleId }]);
    await writeRbac(actor, async (tx) => {
      await tx.delete(roleRule).where(eq(roleRule.ruleId, cur.ruleId));
      await audit(tx, actor, 'role.rule.delete', 'role_rule', String(cur.ruleId), { role: r.code, before: ruleOut(cur) });
    });
    return reply.code(204).send();
  });

  app.get('/api/admin/departments', async (req) => {
    await authorize(req, READ);
    // 分階段開放:只列開放公司的部門(company_id 為 NULL 的部門不屬任何公司,一併略過)
    const open = await openCompanyIds(app.db, config.loginCompanies);
    if (open && !open.length) return { companies: [], items: [], syncedAt: null };
    const [depts, counts, companies] = await Promise.all([
      app.db
        .select()
        .from(department)
        .where(and(eq(department.isEnabled, true), open ? inArray(department.companyId, open) : undefined)),
      app.db.select({ deptCode: user.deptCode, n: count() }).from(user).where(eq(user.isDisabled, false)).groupBy(user.deptCode),
      app.db
        .select({ companyId: company.companyId, name: company.compName })
        .from(company)
        .where(and(eq(company.isEnabled, true), open ? inArray(company.companyId, open) : undefined))
        .orderBy(asc(company.compName)),
    ]);
    const userCount = new Map(counts.map((c) => [c.deptCode, c.n]));
    const nodes = new Map<string, DeptNode>(
      depts.map((d) => [d.deptCode, { deptCode: d.deptCode, name: d.name, companyId: d.companyId, userCount: userCount.get(d.deptCode) ?? 0, children: [] }]),
    );
    const roots: DeptNode[] = [];
    for (const d of depts) {
      const parent = d.parentDeptCode && d.parentDeptCode !== d.deptCode ? nodes.get(d.parentDeptCode) : undefined;
      (parent ? parent.children : roots).push(nodes.get(d.deptCode)!);
    }
    const order = (list: DeptNode[]) => {
      list.sort((a, b) => a.deptCode.localeCompare(b.deptCode));
      list.forEach((n) => order(n.children));
    };
    order(roots);
    const [last] = await app.db.select({ at: sql<Date | null>`max(${department.syncedAt})` }).from(department);
    return { companies, items: roots, syncedAt: last?.at ?? null };
  });

  app.get('/api/admin/apps', async (req) => {
    await authorize(req, READ);
    const rows = await app.db.select().from(appTable).orderBy(asc(appTable.sort), asc(appTable.code));
    return {
      items: rows.map((a) => ({
        code: a.code,
        name: a.name,
        basePath: a.basePath,
        icon: a.icon,
        sort: a.sort,
        permissionCode: a.permissionCode,
        isEnabled: a.isEnabled,
      })),
    };
  });

  app.post<{ Body: { employeeNo?: string; company?: string; deptCode?: string; jobLevel?: string; title?: string } }>(
    '/api/admin/rbac/preview',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            employeeNo: { type: 'string', minLength: 1, maxLength: 20 },
            company: { type: 'string', maxLength: 20 },
            deptCode: { type: 'string', maxLength: 30 },
            jobLevel: { type: 'string', maxLength: 10 },
            title: { type: 'string', maxLength: 100 },
          },
        },
      },
    },
    async (req) => {
      await authorize(req, READ);
      const b = req.body;
      let facts: AuthzFacts;
      let subject: Record<string, unknown>;
      if (b.employeeNo) {
        // 實際使用者:與登入時的計算完全相同(含 AD 群組、所屬公司、個別指派)
        const emp = normalizeEmpNo(b.employeeNo);
        const [u] = isValidEmpNo(emp) ? await app.db.select({ id: user.userId }).from(user).where(eq(user.employeeNo, emp)) : [];
        if (!u) throw new GwError('VALIDATION_FAILED', '查無使用者', [{ field: 'employeeNo', message: emp }]);
        facts = (await loadUserFacts(app.db, u.id)).facts;
        subject = { employeeNo: emp };
      } else {
        // 假設的人事條件:不含 AD 群組與個別指派
        let companyId: number | null = null;
        if (b.company) {
          const [c] = await app.db.select({ id: company.companyId }).from(company).where(eq(company.compName, b.company));
          if (!c) throw new GwError('VALIDATION_FAILED', '公司不存在', [{ field: 'company', message: b.company }]);
          companyId = c.id;
        }
        facts = {
          userId: null,
          adGroups: [],
          companyIds: companyId === null ? [] : [companyId],
          memberships: [{ companyId, deptCode: b.deptCode || null }],
          jobLevel: b.jobLevel || null,
          title: b.title || null,
        };
        subject = { company: b.company ?? null, deptCode: b.deptCode ?? null, jobLevel: b.jobLevel ?? null, title: b.title ?? null };
      }
      const roles = await resolveRoles(app.db, facts);
      const [fromRoles, direct] = await Promise.all([
        permissionsOf(
          app.db,
          roles.map((r) => r.roleId),
        ),
        resolveDirectGrants(app.db, facts),
      ]);
      // 與登入計算相同:角色 ∪ 部門 / 個人,再加上選單隨附的 API 讀取權限
      const { permissions, includedBy } = await expandIncludes(app.db, [...new Set([...fromRoles, ...direct.map((d) => d.code)])]);
      return {
        subject,
        roles: roles.map((r) => ({ code: r.code, sources: r.sources, ruleIds: r.ruleIds })),
        // 直接授予的部門 / 個人權限(v0.12)
        directGrants: direct,
        // 隨選單取得的 API 讀取權限:權限代碼 → 選單代碼
        includedBy: Object.fromEntries(includedBy),
        permissions,
        apps: await appsOf(app.db, permissions),
      };
    },
  );
};

export default rbacRoutes;
