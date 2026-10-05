/**
 * 部門權限與個人權限(v0.12,2026-10-05):直接授予選單 / Tab / 按鈕權限,不經角色。讀取 gw.admin.rbac.read、寫入 gw.admin.rbac.write。
 *
 *   GET /api/admin/job-tiers                            職級門檻(全員 / 課級 / 理級 / 處級以上)
 *   GET /api/admin/dept-permissions?app=                各部門在此應用直接設定的權限數(部門樹標示用)
 *   GET /api/admin/dept-permissions/:deptCode?app=      部門的直接權限與自上層部門繼承的權限
 *   PUT /api/admin/dept-permissions/:deptCode           { app, includeSubDepts, grants: [{ code, jobTier }] } 取代此部門在此應用的權限
 *   GET /api/admin/user-permissions/:id?app=            個人權限(:id 為 user_id 或工號);有效權限與來源見 GET /api/admin/users/:id/effective-permissions
 *   PUT /api/admin/user-permissions/:id                 { app, grants: [{ code, validTo?, reason? }] } 取代此人在此應用的個人權限(validTo 省略 = 永久)
 *   GET /api/admin/direct-grants                        全部直接授予(部門 + 有效的個人權限),權限查詢的關係圖使用
 *
 * - 權限須屬於該應用的權限樹(應用 → 選單 → Tab → 按鈕);儲存時自動補上層(部門:同職級門檻;個人:取下層最晚的到期日)。
 * - 「含下層部門」為部門的設定,套用到此部門所有應用的權限。
 * - 防止提權:新增或移除的權限須是操作人本身具備的。
 * - 部門權限變更遞增全體 perm_version;個人權限只遞增該使用者。寫入與 gw.audit_log 同一交易。
 */
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { app as appTable, department, deptPermission, permission, user, userPermission } from '../../db/schema/index.js';
import { isGrantableKind } from '../../cli/openapi.js';
import { GwError } from '../../errors.js';
import { normalizeEmpNo } from '../auth/profile.js';
import { isJobTier, JOB_TIERS } from '../rbac/job-tiers.js';
import { bumpAllPermVersions } from '../rbac/permission.js';
import { writeAudit } from './audit-log.js';
import { createAuthorizer, type Actor } from './authorize.js';

const READ = 'gw.admin.rbac.read';
const WRITE = 'gw.admin.rbac.write';

const APP_QS = { type: 'object', required: ['app'], properties: { app: { type: 'string', minLength: 1, maxLength: 30 } } } as const;
const DEPT_PARAMS = { type: 'object', required: ['deptCode'], properties: { deptCode: { type: 'string', minLength: 1, maxLength: 30 } } } as const;
const REF_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 20 } } } as const;

interface DeptBody {
  app: string;
  includeSubDepts: boolean;
  grants: { code: string; jobTier: string }[];
}
interface UserBody {
  app: string;
  grants: { code: string; validTo?: string | null; reason?: string | null }[];
}

const grants: FastifyPluginAsync = async (app) => {
  const authorize = createAuthorizer(app);

  /** 應用的權限樹:code → { id, parent };parent 限於樹內 */
  async function appScope(appCode: string) {
    const [a] = await app.db.select({ permissionCode: appTable.permissionCode }).from(appTable).where(eq(appTable.code, appCode));
    if (!a) throw new GwError('VALIDATION_FAILED', '應用不存在', [{ field: 'app', message: appCode }]);
    const rows = await app.db
      .select({ id: permission.permissionId, code: permission.code, parent: permission.parentCode, kind: permission.kind })
      .from(permission);
    const children = new Map<string, string[]>();
    for (const r of rows) if (r.parent && r.parent !== r.code) children.set(r.parent, [...(children.get(r.parent) ?? []), r.code]);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const scope = new Map<string, { id: number; parent: string | null; kind: string }>();
    const stack = byCode.has(a.permissionCode) ? [a.permissionCode] : [];
    while (stack.length) {
      const c = stack.pop()!;
      if (scope.has(c)) continue;
      const r = byCode.get(c)!;
      scope.set(c, { id: r.id, parent: c === a.permissionCode ? null : r.parent, kind: r.kind });
      stack.push(...(children.get(c) ?? []));
    }
    /** 上層權限(略過選單目錄:目錄不可授予) */
    const ancestors = (code: string) => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (let p = scope.get(code)?.parent; p && !seen.has(p); p = scope.get(p)?.parent) {
        seen.add(p);
        if (isGrantableKind(scope.get(p)?.kind ?? '')) out.push(p);
      }
      return out;
    };
    const idToCode = new Map([...scope].map(([code, v]) => [v.id, code]));
    return { scope, ancestors, idToCode };
  }

  function assertInScope(codes: string[], scope: Map<string, { kind: string }>) {
    const bad = codes.filter((c) => !scope.has(c) || !isGrantableKind(scope.get(c)!.kind));
    if (bad.length)
      throw new GwError(
        'VALIDATION_FAILED',
        '權限不屬於此應用,或為不可授予的選單目錄',
        bad.map((c) => ({ field: 'grants', message: c })),
      );
  }

  /** 新增或移除的權限須是操作人本身具備的 */
  async function assertCanChange(actor: Actor, changed: string[]) {
    if (!changed.length) return;
    const mine = await actor.permissions();
    const lacking = [...new Set(changed)].filter((c) => !mine.has(c));
    if (lacking.length)
      throw new GwError(
        'PERMISSION_DENIED',
        '不可授予或移除您沒有的權限',
        lacking.map((c) => ({ field: 'grants', message: c })),
      );
  }

  async function findUser(ref: string) {
    const [u] = await app.db
      .select({
        userId: user.userId,
        employeeNo: user.employeeNo,
        displayName: user.displayName,
        deptCode: user.deptCode,
        department: user.department,
        title: user.title,
        jobLevel: user.jobLevel,
      })
      .from(user)
      .where(/^\d+$/.test(ref) ? eq(user.userId, Number(ref)) : eq(user.employeeNo, normalizeEmpNo(ref)));
    if (!u) throw new GwError('VALIDATION_FAILED', '使用者不存在', [{ field: 'id', message: ref }]);
    return u;
  }

  const invalidatePv = (ids: number[] | 'all') =>
    app.perms.invalidatePv(ids).catch((err: Error) => app.log.warn({ err: err.message }, 'pv 快取清除失敗(15 分鐘內自然過期)'));

  app.get('/api/admin/job-tiers', async (req) => {
    await authorize(req, READ);
    return { items: JOB_TIERS };
  });

  // ───────── 部門權限 ─────────

  app.get<{ Querystring: { app: string } }>('/api/admin/dept-permissions', { schema: { querystring: APP_QS } }, async (req) => {
    await authorize(req, READ);
    const { scope } = await appScope(req.query.app);
    const ids = [...scope.values()].map((v) => v.id);
    const rows = ids.length
      ? await app.db
          .select({ deptCode: deptPermission.deptCode, n: sql<number>`count(distinct ${deptPermission.permissionId})` })
          .from(deptPermission)
          .where(inArray(deptPermission.permissionId, ids))
          .groupBy(deptPermission.deptCode)
      : [];
    return { items: rows.map((r) => ({ deptCode: r.deptCode, count: Number(r.n) })) };
  });

  app.get<{ Params: { deptCode: string }; Querystring: { app: string } }>(
    '/api/admin/dept-permissions/:deptCode',
    { schema: { params: DEPT_PARAMS, querystring: APP_QS } },
    async (req) => {
      await authorize(req, READ);
      const depts = await app.db.select({ code: department.deptCode, name: department.name, parent: department.parentDeptCode }).from(department);
      const byCode = new Map(depts.map((d) => [d.code, d]));
      const d = byCode.get(req.params.deptCode);
      if (!d) throw new GwError('VALIDATION_FAILED', '部門不存在', [{ field: 'deptCode', message: req.params.deptCode }]);
      const { idToCode } = await appScope(req.query.app);
      const ancestors: string[] = [];
      for (let p = d.parent; p && p !== d.code && !ancestors.includes(p) && byCode.has(p); p = byCode.get(p)!.parent) ancestors.push(p);

      const rows = await app.db
        .select()
        .from(deptPermission)
        .where(inArray(deptPermission.deptCode, [d.code, ...ancestors]));
      const own = rows.filter((r) => r.deptCode === d.code);
      return {
        deptCode: d.code,
        name: d.name,
        // 尚未設定任何權限時預設含下層
        includeSubDepts: own.length ? own.every((r) => r.includeSubDepts) : true,
        direct: own.filter((r) => idToCode.has(r.permissionId)).map((r) => ({ code: idToCode.get(r.permissionId)!, jobTier: r.jobTier })),
        inherited: rows
          .filter((r) => r.deptCode !== d.code && r.includeSubDepts && idToCode.has(r.permissionId))
          .map((r) => ({
            code: idToCode.get(r.permissionId)!,
            jobTier: r.jobTier,
            fromDept: r.deptCode,
            fromName: byCode.get(r.deptCode)?.name ?? r.deptCode,
          })),
      };
    },
  );

  app.put<{ Params: { deptCode: string }; Body: DeptBody }>(
    '/api/admin/dept-permissions/:deptCode',
    {
      schema: {
        params: DEPT_PARAMS,
        body: {
          type: 'object',
          required: ['app', 'includeSubDepts', 'grants'],
          additionalProperties: false,
          properties: {
            app: { type: 'string', minLength: 1, maxLength: 30 },
            includeSubDepts: { type: 'boolean' },
            grants: {
              type: 'array',
              maxItems: 1000,
              items: {
                type: 'object',
                required: ['code', 'jobTier'],
                additionalProperties: false,
                properties: { code: { type: 'string', minLength: 1, maxLength: 100 }, jobTier: { type: 'string', minLength: 1, maxLength: 20 } },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const b = req.body;
      const [d] = await app.db.select({ code: department.deptCode }).from(department).where(eq(department.deptCode, req.params.deptCode));
      if (!d) throw new GwError('VALIDATION_FAILED', '部門不存在', [{ field: 'deptCode', message: req.params.deptCode }]);
      const badTier = b.grants.filter((g) => !isJobTier(g.jobTier));
      if (badTier.length)
        throw new GwError(
          'VALIDATION_FAILED',
          '職級門檻不存在',
          badTier.map((g) => ({ field: 'jobTier', message: g.jobTier })),
        );
      const { scope, ancestors, idToCode } = await appScope(b.app);
      assertInScope(
        b.grants.map((g) => g.code),
        scope,
      );

      // 自動補上層(同職級門檻)
      const next = new Set<string>();
      for (const g of b.grants) for (const c of [g.code, ...ancestors(g.code)]) next.add(`${c}|${g.jobTier}`);
      const ids = [...scope.values()].map((v) => v.id);
      const current = (await app.db.select().from(deptPermission).where(eq(deptPermission.deptCode, d.code))).filter((r) => idToCode.has(r.permissionId));
      const cur = new Set(current.map((r) => `${idToCode.get(r.permissionId)}|${r.jobTier}`));
      const changed = [...[...next].filter((k) => !cur.has(k)), ...[...cur].filter((k) => !next.has(k))].map((k) => k.split('|')[0]!);
      await assertCanChange(actor, changed);

      await app.db.transaction(async (tx) => {
        if (ids.length) await tx.delete(deptPermission).where(and(eq(deptPermission.deptCode, d.code), inArray(deptPermission.permissionId, ids)));
        for (const k of next) {
          const [code, jobTier] = k.split('|') as [string, string];
          await tx
            .insert(deptPermission)
            .values({ deptCode: d.code, permissionId: scope.get(code)!.id, jobTier, includeSubDepts: b.includeSubDepts, createdBy: actor.name });
        }
        // 含下層為部門設定:套用到此部門所有應用的權限
        await tx.update(deptPermission).set({ includeSubDepts: b.includeSubDepts }).where(eq(deptPermission.deptCode, d.code));
        await writeAudit(
          tx,
          actor,
          'dept.permissions',
          'department',
          d.code,
          { app: b.app, includeSubDepts: current.length ? current.every((r) => r.includeSubDepts) : null, grants: [...cur].sort() },
          { app: b.app, includeSubDepts: b.includeSubDepts, grants: [...next].sort() },
        );
        await bumpAllPermVersions(tx, actor.name);
      });
      await invalidatePv('all');
      return { deptCode: d.code, includeSubDepts: b.includeSubDepts, direct: [...next].map((k) => ({ code: k.split('|')[0]!, jobTier: k.split('|')[1]! })) };
    },
  );

  app.get('/api/admin/direct-grants', async (req) => {
    await authorize(req, READ);
    const now = new Date();
    const [departments, users] = await Promise.all([
      app.db
        .select({
          deptCode: deptPermission.deptCode,
          name: department.name,
          jobTier: deptPermission.jobTier,
          includeSubDepts: deptPermission.includeSubDepts,
          code: permission.code,
        })
        .from(deptPermission)
        .innerJoin(department, eq(department.deptCode, deptPermission.deptCode))
        .innerJoin(permission, eq(permission.permissionId, deptPermission.permissionId))
        .orderBy(asc(deptPermission.deptCode), asc(permission.code)),
      app.db
        .select({ employeeNo: user.employeeNo, name: user.displayName, validTo: userPermission.validTo, code: permission.code })
        .from(userPermission)
        .innerJoin(user, eq(user.userId, userPermission.userId))
        .innerJoin(permission, eq(permission.permissionId, userPermission.permissionId))
        .where(or(isNull(userPermission.validTo), gt(userPermission.validTo, now)))
        .orderBy(asc(user.employeeNo), asc(permission.code)),
    ]);
    return { departments, users };
  });

  // ───────── 個人權限 ─────────

  app.get<{ Params: { id: string }; Querystring: { app: string } }>(
    '/api/admin/user-permissions/:id',
    { schema: { params: REF_PARAMS, querystring: APP_QS } },
    async (req) => {
      await authorize(req, READ);
      const u = await findUser(req.params.id);
      const { idToCode } = await appScope(req.query.app);
      const rows = await app.db.select().from(userPermission).where(eq(userPermission.userId, u.userId));
      return {
        user: u,
        grants: rows
          .filter((r) => idToCode.has(r.permissionId))
          .map((r) => ({ code: idToCode.get(r.permissionId)!, validTo: r.validTo, reason: r.reason, createdBy: r.createdBy, createdAt: r.createdAt })),
      };
    },
  );

  app.put<{ Params: { id: string }; Body: UserBody }>(
    '/api/admin/user-permissions/:id',
    {
      schema: {
        params: REF_PARAMS,
        body: {
          type: 'object',
          required: ['app', 'grants'],
          additionalProperties: false,
          properties: {
            app: { type: 'string', minLength: 1, maxLength: 30 },
            grants: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                required: ['code'],
                additionalProperties: false,
                properties: {
                  code: { type: 'string', minLength: 1, maxLength: 100 },
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
      const actor = await authorize(req, WRITE);
      const b = req.body;
      const u = await findUser(req.params.id);
      const { scope, ancestors, idToCode } = await appScope(b.app);
      assertInScope(
        b.grants.map((g) => g.code),
        scope,
      );
      const now = new Date();
      const next = new Map<string, { validTo: Date | null; reason: string | null }>();
      for (const g of b.grants) {
        const validTo = g.validTo ? new Date(g.validTo) : null;
        if (validTo && validTo <= now) throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'grants', message: `${g.code} 的到期時間需晚於現在` }]);
        next.set(g.code, { validTo, reason: g.reason ?? null });
      }
      // 自動補上層:到期日取下層最晚者(任一永久 = 永久)
      for (const [code, v] of [...next]) {
        for (const a of ancestors(code)) {
          const cur = next.get(a);
          if (!cur) next.set(a, { validTo: v.validTo, reason: v.reason });
          else if (b.grants.every((g) => g.code !== a) && cur.validTo && (!v.validTo || v.validTo > cur.validTo)) cur.validTo = v.validTo;
        }
      }
      const ids = [...scope.values()].map((v) => v.id);
      const current = (await app.db.select().from(userPermission).where(eq(userPermission.userId, u.userId))).filter((r) => idToCode.has(r.permissionId));
      const curCodes = current.map((r) => idToCode.get(r.permissionId)!);
      const changed = [...[...next.keys()].filter((c) => !curCodes.includes(c)), ...curCodes.filter((c) => !next.has(c))];
      await assertCanChange(actor, changed);

      await app.db.transaction(async (tx) => {
        if (ids.length) await tx.delete(userPermission).where(and(eq(userPermission.userId, u.userId), inArray(userPermission.permissionId, ids)));
        for (const [code, v] of next)
          await tx
            .insert(userPermission)
            .values({ userId: u.userId, permissionId: scope.get(code)!.id, validTo: v.validTo, reason: v.reason, createdBy: actor.name });
        await tx
          .update(user)
          .set({ permVersion: sql`${user.permVersion} + 1`, updatedBy: actor.name })
          .where(eq(user.userId, u.userId));
        await writeAudit(
          tx,
          actor,
          'user.permissions',
          'user',
          u.employeeNo,
          { app: b.app, grants: current.map((r) => ({ code: idToCode.get(r.permissionId), validTo: r.validTo, reason: r.reason })) },
          { app: b.app, grants: [...next].map(([code, v]) => ({ code, ...v })) },
        );
      });
      await invalidatePv([u.userId]);
      return { user: u, grants: [...next].map(([code, v]) => ({ code, ...v })) };
    },
  );
};

export default grants;
