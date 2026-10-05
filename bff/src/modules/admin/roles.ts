/**
 * 角色、權限與 AD 群組對應的寫入 API(PRD §8.7、P2-3):讀取 gw.admin.rbac.read、寫入 gw.admin.rbac.write。
 * (查詢、角色權限取代、指派規則等見 rbac.ts)
 *
 *   POST   /api/admin/roles                        新增角色
 *   PATCH  /api/admin/roles/:role                  修改名稱、說明(需 rowVer)
 *   DELETE /api/admin/roles/:role?rowVer=          刪除角色(內建角色不可刪;一併移除其權限、規則、AD 群組、公司與個別指派)
 *   GET    /api/admin/roles/:role/ad-groups        AD 群組對應
 *   PUT    /api/admin/roles/:role/ad-groups        取代 AD 群組對應(群組 DN 清單)
 *   POST   /api/admin/permissions                  新增權限(畫面權限 kind / parent / sort;API 權限多由 OpenAPI x-permissions 匯入)
 *   PATCH  /api/admin/permissions/:code            修改名稱、說明、kind、上層、排序(需 rowVer)
 *   DELETE /api/admin/permissions/:code?rowVer=    刪除權限(gw.admin.* 不可刪;仍被路由、聚合步驟、應用或下層權限使用時拒絕;一併移除部門 / 個人權限)
 *
 * - :role 為角色代碼或 role_id。寫入與 gw.audit_log 同一交易。
 * - 影響使用者權限的變更(刪除角色、AD 群組對應、刪除已授予的權限)遞增全體 perm_version,提交後清除 pv 快取(DATABASE.md §7.2)。
 * - 防止提權:AD 群組對應的角色所含權限須是操作人本身具備的;gw-super-admin 的 AD 群組不開放以 API 修改(維持 CLI apply)。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { ICON, permissionDeclError, PERMISSION_KINDS } from '../../cli/openapi.js';
import {
  aggregateStep,
  apiClient,
  apiClientPermission,
  apiRoute,
  deptPermission,
  app as appTable,
  permission,
  role,
  roleAdGroup,
  roleCompany,
  rolePermission,
  roleRule,
  rowVerFromHex,
  rowVerToHex,
  userPermission,
  userRole,
} from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { clientKey } from '../auth/api-key.js';
import { bumpAllPermVersions } from '../rbac/permission.js';
import { writeAudit } from './audit-log.js';
import { createAuthorizer, type Actor } from './authorize.js';
import { permParts, type Tx } from './route-import.js';

const READ = 'gw.admin.rbac.read';
const WRITE = 'gw.admin.rbac.write';
const PROTECTED_ROLES = new Set(['gw-super-admin']);
const ROW_VER = { type: 'string', pattern: '^[0-9a-fA-F]{16}$' };
const ROLE_PARAMS = { type: 'object', required: ['role'], properties: { role: { type: 'string', minLength: 1, maxLength: 50 } } };
const CODE_PARAMS = { type: 'object', required: ['code'], properties: { code: { type: 'string', minLength: 1, maxLength: 100 } } };
const DELETE_QS = { type: 'object', required: ['rowVer'], properties: { rowVer: ROW_VER } };

function verOf(hex: string): Buffer {
  try {
    return rowVerFromHex(hex);
  } catch {
    throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'rowVer', message: '格式錯誤' }]);
  }
}

/** AD 群組 DN:需含 CN= 或 OU= 等 RDN(與登入時寫入 gw.user.ad_groups 的 DN 比對) */
const isDn = (v: string) => /^(CN|OU|DC)=[^,]+(,\s*(CN|OU|DC|O|L|ST|C)=[^,]+)*$/i.test(v.trim());

const roles: FastifyPluginAsync = async (app) => {
  const authorize = createAuthorizer(app);

  async function findRole(ref: string) {
    const [r] = await app.db
      .select()
      .from(role)
      .where(/^\d+$/.test(ref) ? eq(role.roleId, Number(ref)) : eq(role.code, ref));
    if (!r) throw new GwError('VALIDATION_FAILED', '角色不存在', [{ field: 'role', message: ref }]);
    return r;
  }

  async function findPermission(code: string) {
    const [p] = await app.db.select().from(permission).where(eq(permission.code, code));
    if (!p) throw new GwError('VALIDATION_FAILED', '權限不存在', [{ field: 'code', message: code }]);
    return p;
  }

  /** 寫入 + 稽核同一交易;bump = true 時遞增全體 pv,提交後清除 pv 快取 */
  async function write<T>(actor: Actor, bump: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const result = await app.db.transaction(async (tx) => {
      const r = await fn(tx);
      if (bump) await bumpAllPermVersions(tx, actor.name.slice(0, 64));
      return r;
    });
    if (bump) await app.perms.invalidatePv('all').catch((err: Error) => app.log.warn({ err: err.message }, 'pv 快取清除失敗(15 分鐘內自然過期)'));
    return result;
  }

  const roleOut = (r: typeof role.$inferSelect) => ({
    roleId: r.roleId,
    code: r.code,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
    rowVer: rowVerToHex(r.rowVer),
  });

  const permOut = (p: typeof permission.$inferSelect) => {
    const { rowVer, ...rest } = p;
    return { ...rest, rowVer: rowVerToHex(rowVer) };
  };

  // ───────── 角色 ─────────

  app.post<{ Body: { code: string; name: string; description?: string | null } }>(
    '/api/admin/roles',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'name'],
          additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,49}$' },
            name: { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: ['string', 'null'], maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = await authorize(req, WRITE);
      const b = req.body;
      const [dup] = await app.db.select({ id: role.roleId }).from(role).where(eq(role.code, b.code));
      if (dup) throw new GwError('VALIDATION_FAILED', '角色代碼已存在', [{ field: 'code', message: b.code }]);
      const by = actor.name.slice(0, 64);
      const id = await write(actor, false, async (tx) => {
        const [row] = await tx
          .insert(role)
          .output({ id: role.roleId })
          .values({ code: b.code, name: b.name, description: b.description ?? null, createdBy: by, updatedBy: by });
        await writeAudit(tx, actor, 'role.create', 'role', b.code, null, b);
        return row!.id;
      });
      return reply.code(201).send(roleOut(await findRole(String(id))));
    },
  );

  app.patch<{ Params: { role: string }; Body: { rowVer: string; name?: string; description?: string | null } }>(
    '/api/admin/roles/:role',
    {
      schema: {
        params: ROLE_PARAMS,
        body: {
          type: 'object',
          required: ['rowVer'],
          additionalProperties: false,
          properties: { rowVer: ROW_VER, name: { type: 'string', minLength: 1, maxLength: 100 }, description: { type: ['string', 'null'], maxLength: 500 } },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const cur = await findRole(req.params.role);
      const b = req.body;
      const set = { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}) };
      await write(actor, false, async (tx) => {
        const rows = await tx
          .update(role)
          .set({ ...set, updatedBy: actor.name.slice(0, 64) })
          .output({ inserted: { id: role.roleId } })
          .where(and(eq(role.roleId, cur.roleId), eq(role.rowVer, verOf(b.rowVer))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        await writeAudit(tx, actor, 'role.update', 'role', cur.code, { name: cur.name, description: cur.description }, set);
      });
      return roleOut(await findRole(String(cur.roleId)));
    },
  );

  app.delete<{ Params: { role: string }; Querystring: { rowVer: string } }>(
    '/api/admin/roles/:role',
    { schema: { params: ROLE_PARAMS, querystring: DELETE_QS } },
    async (req, reply) => {
      const actor = await authorize(req, WRITE);
      const cur = await findRole(req.params.role);
      if (cur.isSystem) throw new GwError('PERMISSION_DENIED', `${cur.code} 為內建角色,不可刪除`);
      if (rowVerToHex(cur.rowVer) !== verOf(req.query.rowVer).toString('hex')) throw new GwError('VERSION_CONFLICT');
      await write(actor, true, async (tx) => {
        const [perms, groups, companies, rules, users] = await Promise.all([
          tx
            .select({ code: permission.code })
            .from(rolePermission)
            .innerJoin(permission, eq(permission.permissionId, rolePermission.permissionId))
            .where(eq(rolePermission.roleId, cur.roleId)),
          tx.select({ dn: roleAdGroup.adGroupDn }).from(roleAdGroup).where(eq(roleAdGroup.roleId, cur.roleId)),
          tx.select({ companyId: roleCompany.companyId }).from(roleCompany).where(eq(roleCompany.roleId, cur.roleId)),
          tx.select({ ruleId: roleRule.ruleId }).from(roleRule).where(eq(roleRule.roleId, cur.roleId)),
          tx.select({ userId: userRole.userId }).from(userRole).where(eq(userRole.roleId, cur.roleId)),
        ]);
        // 樂觀鎖:交易內再確認一次版本
        const [still] = await tx
          .select({ id: role.roleId })
          .from(role)
          .where(and(eq(role.roleId, cur.roleId), eq(role.rowVer, cur.rowVer)));
        if (!still) throw new GwError('VERSION_CONFLICT');
        await tx.delete(rolePermission).where(eq(rolePermission.roleId, cur.roleId));
        await tx.delete(roleAdGroup).where(eq(roleAdGroup.roleId, cur.roleId));
        await tx.delete(roleCompany).where(eq(roleCompany.roleId, cur.roleId));
        await tx.delete(roleRule).where(eq(roleRule.roleId, cur.roleId));
        await tx.delete(userRole).where(eq(userRole.roleId, cur.roleId));
        await tx.delete(role).where(eq(role.roleId, cur.roleId));
        await writeAudit(
          tx,
          actor,
          'role.delete',
          'role',
          cur.code,
          {
            ...roleOut(cur),
            permissions: perms.map((p) => p.code),
            adGroups: groups.map((g) => g.dn),
            companyIds: companies.map((c) => c.companyId),
            ruleIds: rules.map((r) => r.ruleId),
            userIds: users.map((u) => u.userId),
          },
          null,
        );
      });
      return reply.code(204).send();
    },
  );

  // ───────── AD 群組對應 ─────────

  app.get<{ Params: { role: string } }>('/api/admin/roles/:role/ad-groups', { schema: { params: ROLE_PARAMS } }, async (req) => {
    await authorize(req, READ);
    const r = await findRole(req.params.role);
    const rows = await app.db
      .select({ dn: roleAdGroup.adGroupDn, createdAt: roleAdGroup.createdAt, createdBy: roleAdGroup.createdBy })
      .from(roleAdGroup)
      .where(eq(roleAdGroup.roleId, r.roleId));
    return { role: r.code, items: rows.sort((a, b) => a.dn.localeCompare(b.dn)) };
  });

  app.put<{ Params: { role: string }; Body: { groups: string[] } }>(
    '/api/admin/roles/:role/ad-groups',
    {
      schema: {
        params: ROLE_PARAMS,
        body: {
          type: 'object',
          required: ['groups'],
          additionalProperties: false,
          properties: { groups: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 3, maxLength: 400 } } },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const r = await findRole(req.params.role);
      if (PROTECTED_ROLES.has(r.code)) throw new GwError('PERMISSION_DENIED', `${r.code} 的 AD 群組不開放以 API 修改`);
      const groups = [...new Map(req.body.groups.map((g) => [g.trim().toLowerCase(), g.trim()])).values()];
      const bad = groups.filter((g) => !isDn(g));
      if (bad.length)
        throw new GwError(
          'VALIDATION_FAILED',
          'AD 群組需為 DN(例:CN=GN-HR-Managers,OU=Groups,DC=gsmc,DC=com,DC=tw)',
          bad.map((g) => ({ field: 'groups', message: g })),
        );
      // 防止提權:不可把自己沒有的權限經由 AD 群組授予他人(或自己)
      const rolePerms = await app.db
        .select({ code: permission.code })
        .from(rolePermission)
        .innerJoin(permission, eq(permission.permissionId, rolePermission.permissionId))
        .where(eq(rolePermission.roleId, r.roleId));
      const own = await actor.permissions();
      const beyond = rolePerms.map((p) => p.code).filter((c) => !own.has(c));
      if (beyond.length) throw new GwError('PERMISSION_DENIED', `角色含有您沒有的權限,不可設定其 AD 群組:${beyond.join(', ')}`);

      const before = (await app.db.select({ dn: roleAdGroup.adGroupDn }).from(roleAdGroup).where(eq(roleAdGroup.roleId, r.roleId))).map((g) => g.dn);
      await write(actor, true, async (tx) => {
        await tx.delete(roleAdGroup).where(eq(roleAdGroup.roleId, r.roleId));
        for (const dn of groups) await tx.insert(roleAdGroup).values({ roleId: r.roleId, adGroupDn: dn, createdBy: actor.name.slice(0, 64) });
        await writeAudit(tx, actor, 'role.ad_groups.replace', 'role', r.code, { groups: before }, { groups });
      });
      return { role: r.code, groups: groups.sort((a, b) => a.localeCompare(b)) };
    },
  );

  // ───────── 權限 ─────────

  const permProps = {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: ['string', 'null'], maxLength: 500 },
    kind: { type: 'string', enum: [...PERMISSION_KINDS] },
    parentCode: { type: ['string', 'null'], maxLength: 100 },
    sort: { type: ['integer', 'null'], minimum: 0, maximum: 32767 },
    icon: { type: ['string', 'null'], maxLength: 30, pattern: ICON.source },
  } as const;

  /** 改成目錄(group)前:不可已被授予(目錄只分組,不可授予) */
  async function assertNotGranted(permissionId: number, code: string) {
    const [[r], [d], [u]] = await Promise.all([
      app.db
        .select({ n: sql<number>`count(*)` })
        .from(rolePermission)
        .where(eq(rolePermission.permissionId, permissionId)),
      app.db
        .select({ n: sql<number>`count(*)` })
        .from(deptPermission)
        .where(eq(deptPermission.permissionId, permissionId)),
      app.db
        .select({ n: sql<number>`count(*)` })
        .from(userPermission)
        .where(eq(userPermission.permissionId, permissionId)),
    ]);
    if (Number(r?.n) + Number(d?.n) + Number(u?.n) > 0)
      throw new GwError('VALIDATION_FAILED', '已授予角色、部門或個人的權限不可改為目錄,請先取消授予', [{ field: 'kind', message: code }]);
  }

  /** 上層須存在,且不可形成循環 */
  async function checkParent(code: string, parentCode: string | null | undefined) {
    if (!parentCode) return;
    if (parentCode === code) throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'parentCode', message: '不可以自己為上層' }]);
    const all = new Map((await app.db.select({ code: permission.code, parent: permission.parentCode }).from(permission)).map((p) => [p.code, p.parent]));
    if (!all.has(parentCode)) throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'parentCode', message: `上層權限不存在:${parentCode}` }]);
    const seen = new Set<string>([code]);
    for (let p: string | null | undefined = parentCode; p; p = all.get(p)) {
      if (seen.has(p)) throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'parentCode', message: '上層關係形成循環' }]);
      seen.add(p);
    }
  }

  app.post<{
    Body: { code: string; name: string; description?: string | null; kind?: string; parentCode?: string | null; sort?: number | null; icon?: string | null };
  }>(
    '/api/admin/permissions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'name'],
          additionalProperties: false,
          properties: { code: { type: 'string', maxLength: 100 }, ...permProps },
        },
      },
    },
    async (req, reply) => {
      const actor = await authorize(req, WRITE);
      const b = req.body;
      const err = permissionDeclError({ code: b.code, name: b.name, kind: b.kind });
      if (err) throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'code', message: err }]);
      const [dup] = await app.db.select({ id: permission.permissionId }).from(permission).where(eq(permission.code, b.code));
      if (dup) throw new GwError('VALIDATION_FAILED', '權限代碼已存在', [{ field: 'code', message: b.code }]);
      await checkParent(b.code, b.parentCode);
      const by = actor.name.slice(0, 64);
      await write(actor, false, async (tx) => {
        await tx.insert(permission).values({
          code: b.code,
          name: b.name,
          ...permParts(b.code),
          description: b.description ?? null,
          kind: b.kind ?? 'api',
          parentCode: b.parentCode ?? null,
          sort: b.sort ?? null,
          icon: b.icon ?? null,
          createdBy: by,
          updatedBy: by,
        });
        await writeAudit(tx, actor, 'permission.create', 'permission', b.code, null, b);
      });
      return reply.code(201).send(permOut(await findPermission(b.code)));
    },
  );

  app.patch<{
    Params: { code: string };
    Body: { rowVer: string; name?: string; description?: string | null; kind?: string; parentCode?: string | null; sort?: number | null; icon?: string | null };
  }>(
    '/api/admin/permissions/:code',
    {
      schema: {
        params: CODE_PARAMS,
        body: { type: 'object', required: ['rowVer'], additionalProperties: false, properties: { rowVer: ROW_VER, ...permProps } },
      },
    },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const cur = await findPermission(req.params.code);
      const { rowVer, ...b } = req.body;
      if (b.parentCode !== undefined) await checkParent(cur.code, b.parentCode);
      if (b.kind === 'group' && cur.kind !== 'group') await assertNotGranted(cur.permissionId, cur.code);
      const set = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
      await write(actor, false, async (tx) => {
        const rows = await tx
          .update(permission)
          .set({ ...set, updatedBy: actor.name.slice(0, 64) })
          .output({ inserted: { id: permission.permissionId } })
          .where(and(eq(permission.permissionId, cur.permissionId), eq(permission.rowVer, verOf(rowVer))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        await writeAudit(
          tx,
          actor,
          'permission.update',
          'permission',
          cur.code,
          { name: cur.name, description: cur.description, kind: cur.kind, parentCode: cur.parentCode, sort: cur.sort, icon: cur.icon },
          set,
        );
      });
      return permOut(await findPermission(cur.code));
    },
  );

  app.delete<{ Params: { code: string }; Querystring: { rowVer: string } }>(
    '/api/admin/permissions/:code',
    { schema: { params: CODE_PARAMS, querystring: DELETE_QS } },
    async (req, reply) => {
      const actor = await authorize(req, WRITE);
      const cur = await findPermission(req.params.code);
      if (cur.code.startsWith('gw.admin.')) throw new GwError('PERMISSION_DENIED', 'Gateway 內建管理權限不可刪除');
      if (rowVerToHex(cur.rowVer) !== verOf(req.query.rowVer).toString('hex')) throw new GwError('VERSION_CONFLICT');
      const [routes, steps, apps, children] = await Promise.all([
        app.db.select({ code: apiRoute.routeCode }).from(apiRoute).where(eq(apiRoute.permissionCode, cur.code)),
        app.db
          .select({ code: apiRoute.routeCode, step: aggregateStep.stepKey })
          .from(aggregateStep)
          .innerJoin(apiRoute, eq(apiRoute.routeId, aggregateStep.routeId))
          .where(eq(aggregateStep.permissionCode, cur.code)),
        app.db.select({ code: appTable.code }).from(appTable).where(eq(appTable.permissionCode, cur.code)),
        app.db.select({ code: permission.code }).from(permission).where(eq(permission.parentCode, cur.code)),
      ]);
      const uses = [
        ...routes.map((r) => ({ field: 'route', message: r.code })),
        ...steps.map((s) => ({ field: 'aggregateStep', message: `${s.code}.${s.step}` })),
        ...apps.map((a) => ({ field: 'app', message: a.code })),
        ...children.map((c) => ({ field: 'childPermission', message: c.code })),
      ];
      if (uses.length) throw new GwError('VALIDATION_FAILED', '權限仍被使用,請先移除參照', uses);

      const [grants, clients, deptGrants, userGrants] = await Promise.all([
        app.db
          .select({ code: role.code })
          .from(rolePermission)
          .innerJoin(role, eq(role.roleId, rolePermission.roleId))
          .where(eq(rolePermission.permissionId, cur.permissionId)),
        app.db
          .select({ code: apiClient.code, keyPrefix: apiClient.keyPrefix })
          .from(apiClientPermission)
          .innerJoin(apiClient, eq(apiClient.clientId, apiClientPermission.clientId))
          .where(eq(apiClientPermission.permissionId, cur.permissionId)),
        app.db
          .select({ deptCode: deptPermission.deptCode, jobTier: deptPermission.jobTier })
          .from(deptPermission)
          .where(eq(deptPermission.permissionId, cur.permissionId)),
        app.db.select({ userId: userPermission.userId }).from(userPermission).where(eq(userPermission.permissionId, cur.permissionId)),
      ]);
      await write(actor, grants.length + deptGrants.length + userGrants.length > 0, async (tx) => {
        const [still] = await tx
          .select({ id: permission.permissionId })
          .from(permission)
          .where(and(eq(permission.permissionId, cur.permissionId), eq(permission.rowVer, cur.rowVer)));
        if (!still) throw new GwError('VERSION_CONFLICT');
        await tx.delete(rolePermission).where(eq(rolePermission.permissionId, cur.permissionId));
        await tx.delete(apiClientPermission).where(eq(apiClientPermission.permissionId, cur.permissionId));
        await tx.delete(deptPermission).where(eq(deptPermission.permissionId, cur.permissionId));
        await tx.delete(userPermission).where(eq(userPermission.permissionId, cur.permissionId));
        await tx.delete(permission).where(eq(permission.permissionId, cur.permissionId));
        await writeAudit(
          tx,
          actor,
          'permission.delete',
          'permission',
          cur.code,
          {
            ...permOut(cur),
            roles: grants.map((g) => g.code),
            apiClients: clients.map((c) => c.code),
            departments: deptGrants,
            users: userGrants.map((u) => u.userId),
          },
          null,
        );
      });
      // API Key 快取含權限範圍:提交後刪除(DATABASE.md §7.2)
      if (clients.length) await app.redis.del(...clients.map((c) => clientKey(c.keyPrefix))).catch(() => undefined);
      return reply.code(204).send();
    },
  );
};

export default roles;
