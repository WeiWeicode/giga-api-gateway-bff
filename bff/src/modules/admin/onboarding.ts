/**
 * IT 新員工上手導覽(demo,唯讀):模擬 API 上架流程(BACKEND-GUIDE.md §7–§8),全部只預覽、不寫入資料庫。
 * 不是 PRD §8.7 的正式管理 API;與 db-viewer 相同只在 dev / test 註冊(app.ts)。
 *
 *   GET  /api/admin/demo/catalog               目前的上游、權限、限流政策、角色、線上路由版本
 *   POST /api/admin/demo/openapi-preview       OpenAPI 匯入預覽(與 CLI import-openapi 使用相同的解析與檢查規則)
 *   POST /api/admin/demo/route-preview         手動新增單一路由的預覽與檢查
 *   GET  /api/admin/demo/who-can-access        權限反查:哪些角色、AD 群組、公司、個別使用者擁有此權限(PRD §8.7)
 */
import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { checkUpstreamPort, parseOpenApi, toPublicPath, type ParsedRoute } from '../../cli/openapi.js';
import {
  apiRoute,
  company,
  permission,
  rateLimitPolicy,
  role,
  roleAdGroup,
  roleCompany,
  rolePermission,
  upstream,
  upstreamTarget,
  user,
  userRole,
} from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { VERSION_KEY } from '../../db/sync/release.js';

/** 預覽時比較的欄位(與 CLI 匯入寫入 gw.api_route 的欄位一致) */
const COMPARED = [
  'name',
  'systemCode',
  'method',
  'publicPath',
  'upstreamPath',
  'authMode',
  'permissionCode',
  'cacheTtlSec',
  'cacheScope',
  'timeoutMs',
  'auditLevel',
] as const;
const ROUTE_CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'];

interface ManualRoute {
  routeCode: string;
  name: string;
  systemCode: string;
  method: string;
  publicPath: string;
  routeType: 'proxy' | 'mock';
  upstreamCode?: string;
  upstreamPath?: string;
  authMode: 'public' | 'authenticated' | 'permission';
  permissionCode?: string;
  timeoutMs?: number;
  cacheTtlSec?: number;
  cacheScope?: 'user' | 'shared';
}

const onboarding: FastifyPluginAsync = async (app) => {
  async function requirePerm(req: FastifyRequest, code: string) {
    const p = await req.requirePrincipal();
    if (!(await app.perms.has(p.userId, p.claims.pv, code))) throw new GwError('PERMISSION_DENIED');
    return p;
  }

  /** 對外路徑衝突:同方法、同路徑、未停用、但不是同一個 route_code(對應唯一索引 uq_api_route_method_path_active) */
  async function pathConflicts(items: { routeCode: string; method: string; publicPath: string }[]) {
    if (!items.length) return new Map<string, string>();
    const rows = await app.db
      .select({ code: apiRoute.routeCode, method: apiRoute.method, path: apiRoute.publicPath })
      .from(apiRoute)
      .where(and(ne(apiRoute.status, 'disabled'), inArray(apiRoute.publicPath, [...new Set(items.map((i) => i.publicPath))])));
    const out = new Map<string, string>();
    for (const i of items) {
      const hit = rows.find((r) => r.method === i.method && r.path === i.publicPath && r.code !== i.routeCode);
      if (hit) out.set(i.routeCode, hit.code);
    }
    return out;
  }

  app.get('/api/admin/demo/catalog', async (req) => {
    await requirePerm(req, 'gw.admin.route.read');
    const [ups, targets, perms, policies, roles, routes] = await Promise.all([
      app.db
        .select({ id: upstream.upstreamId, code: upstream.code, name: upstream.name, systemCode: upstream.systemCode, timeoutMs: upstream.timeoutMs })
        .from(upstream),
      app.db.select({ upstreamId: upstreamTarget.upstreamId, baseUrl: upstreamTarget.baseUrl, environment: upstreamTarget.environment }).from(upstreamTarget),
      app.db.select({ code: permission.code, name: permission.name, systemCode: permission.systemCode }).from(permission),
      app.db
        .select({ code: rateLimitPolicy.code, limitCount: rateLimitPolicy.limitCount, windowSec: rateLimitPolicy.windowSec, keyBy: rateLimitPolicy.keyBy })
        .from(rateLimitPolicy),
      app.db.select({ code: role.code, name: role.name }).from(role),
      app.db
        .select({ upstreamId: apiRoute.upstreamId, status: apiRoute.status, n: sql<number>`count(*)`.mapWith(Number) })
        .from(apiRoute)
        .groupBy(apiRoute.upstreamId, apiRoute.status),
    ]);
    const redisVersion = await app.redis.get(VERSION_KEY).catch(() => null);
    return {
      upstreams: ups.map((u) => ({
        ...u,
        targets: targets.filter((t) => t.upstreamId === u.id).map(({ baseUrl, environment }) => ({ baseUrl, environment })),
        routes: routes.filter((r) => r.upstreamId === u.id).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: r.n }), {}),
      })),
      permissions: perms.sort((a, b) => a.code.localeCompare(b.code)),
      policies,
      roles,
      release: {
        liveVersion: app.routeTable.version,
        redisVersion: redisVersion ? Number(redisVersion) : null,
        draftRoutes: routes.filter((r) => r.status === 'draft').reduce((s, r) => s + r.n, 0),
      },
    };
  });

  app.post<{ Body: { spec: unknown; target: string; environment?: string } }>(
    '/api/admin/demo/openapi-preview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['spec', 'target'],
          properties: { spec: {}, target: { type: 'string' }, environment: { type: 'string', enum: ['test', 'prod'] } },
        },
      },
    },
    async (req) => {
      await requirePerm(req, 'gw.admin.route.import');
      let doc: Record<string, unknown>;
      try {
        doc = (typeof req.body.spec === 'string' ? JSON.parse(req.body.spec) : req.body.spec) as Record<string, unknown>;
      } catch {
        throw new GwError('VALIDATION_FAILED', 'OpenAPI 不是合法的 JSON');
      }
      const spec = parseOpenApi(doc);

      const targetOk = (() => {
        try {
          return checkUpstreamPort(req.body.target);
        } catch {
          return false; // 不是合法的 URL
        }
      })();
      if (!targetOk) spec.errors.push({ operation: '(target)', message: `UPSTREAM_PORT_OUT_OF_RANGE:${req.body.target} 的 port 不在 51200–51300` });

      const policies = new Set((await app.db.select({ code: rateLimitPolicy.code }).from(rateLimitPolicy)).map((p) => p.code));
      for (const r of spec.routes)
        if (r.rateLimitPolicy && !policies.has(r.rateLimitPolicy))
          spec.errors.push({ operation: r.routeCode, message: `x-rate-limit 政策不存在:${r.rateLimitPolicy}` });

      const codes = spec.routes.map((r) => r.routeCode);
      const existing = codes.length ? await app.db.select().from(apiRoute).where(inArray(apiRoute.routeCode, codes)) : [];
      const conflicts = await pathConflicts(spec.routes);
      for (const [code, other] of conflicts) spec.errors.push({ operation: code, message: `ROUTE_PATH_CONFLICT:對外路徑與既有路由 ${other} 衝突` });

      const [up] = spec.upstreamCode ? await app.db.select().from(upstream).where(eq(upstream.code, spec.upstreamCode)) : [];
      const permCodes = spec.permissions.map((p) => p.code);
      const knownPerms = new Set(
        permCodes.length ? (await app.db.select({ code: permission.code }).from(permission).where(inArray(permission.code, permCodes))).map((p) => p.code) : [],
      );

      const items = spec.routes.map((r: ParsedRoute) => {
        const cur = existing.find((e) => e.routeCode === r.routeCode);
        const errors = spec.errors.filter((e) => e.operation === r.routeCode).map((e) => e.message);
        const changed = cur ? COMPARED.filter((k) => (cur as Record<string, unknown>)[k] !== (r as unknown as Record<string, unknown>)[k]) : [];
        const action = errors.length ? 'error' : !cur ? 'create' : changed.length || cur.status === 'disabled' ? 'update' : 'unchanged';
        return { ...r, action, changedFields: changed, currentStatus: cur?.status ?? null, errors };
      });
      // 缺少必填欄位的 operation 不會出現在 spec.routes,補成一列 error,讓預覽表格與摘要一致
      const invalidOps = [...new Set(spec.errors.map((e) => e.operation))].filter((op) => !op.startsWith('(') && !spec.routes.some((r) => r.routeCode === op));
      const invalidItems = invalidOps.map((op) => ({
        routeCode: op,
        name: '',
        method: '',
        publicPath: '',
        upstreamPath: '',
        authMode: '',
        permissionCode: null,
        cacheTtlSec: null,
        auditLevel: 'none',
        action: 'error',
        changedFields: [] as string[],
        currentStatus: null,
        errors: spec.errors.filter((e) => e.operation === op).map((e) => e.message),
      }));
      const rootErrors = spec.errors.filter((e) => e.operation.startsWith('('));
      const allItems = [...items, ...invalidItems];
      const count = (a: string) => allItems.filter((i) => i.action === a).length;
      const canCommit = spec.errors.length === 0;

      return {
        upstream: { code: spec.upstreamCode, systemCode: spec.systemCode, exists: !!up, target: req.body.target, environment: req.body.environment ?? 'test' },
        permissions: spec.permissions.map((p) => ({ ...p, exists: knownPerms.has(p.code) })),
        items: allItems,
        errors: rootErrors,
        summary: { total: allItems.length, create: count('create'), update: count('update'), unchanged: count('unchanged'), error: count('error') },
        canCommit,
        // 真正匯入(CLI import-openapi / 第二階段管理 API)時會寫入的資料表
        writes: canCommit
          ? [
              { table: 'upstream', action: up ? '更新設定' : '新增 1 筆', note: `服務代碼 ${spec.upstreamCode}(內部 Token 的 aud)` },
              { table: 'upstream_target', action: '取代該環境的位址', note: req.body.target },
              {
                table: 'permission',
                action: `新增 ${spec.permissions.filter((p) => !knownPerms.has(p.code)).length} 筆`,
                note: '來自 x-permissions,已存在者略過',
              },
              { table: 'api_import_batch', action: '新增 1 筆', note: '匯入批次:檔案雜湊、筆數統計' },
              { table: 'api_import_item', action: `新增 ${items.length} 筆`, note: '逐筆結果:create / update / unchanged' },
              { table: 'api_route', action: `新增 ${count('create')}、更新 ${count('update')}(狀態 draft)`, note: '草稿不影響線上,發佈後才生效' },
              { table: 'audit_log', action: '新增 1 筆', note: 'action = route.import' },
            ]
          : [
              { table: 'api_import_batch', action: '新增 1 筆(status = failed)', note: '匯入批次含錯誤時不寫入任何路由' },
              { table: 'api_import_item', action: `新增 ${spec.errors.length} 筆(action = error)`, note: 'IMPORT_HAS_ERRORS:修正後重新匯入' },
            ],
      };
    },
  );

  app.post<{ Body: ManualRoute }>(
    '/api/admin/demo/route-preview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['routeCode', 'name', 'systemCode', 'method', 'publicPath', 'routeType', 'authMode'],
          properties: {
            routeCode: { type: 'string' },
            name: { type: 'string' },
            systemCode: { type: 'string' },
            method: { type: 'string' },
            publicPath: { type: 'string' },
            routeType: { type: 'string', enum: ['proxy', 'mock'] },
            upstreamCode: { type: 'string' },
            upstreamPath: { type: 'string' },
            authMode: { type: 'string', enum: ['public', 'authenticated', 'permission'] },
            permissionCode: { type: 'string' },
            timeoutMs: { type: 'integer' },
            cacheTtlSec: { type: 'integer' },
            cacheScope: { type: 'string', enum: ['user', 'shared'] },
          },
        },
      },
    },
    async (req) => {
      await requirePerm(req, 'gw.admin.route.read');
      const r = req.body;
      const errors: string[] = [];
      const notes: string[] = [];
      if (!ROUTE_CODE.test(r.routeCode)) errors.push('route_code 格式須為 {system}.{resource}.{action},全小寫');
      if (!METHODS.includes(r.method)) errors.push(`method 必須是 ${METHODS.join(' / ')}`);
      if (!r.publicPath.startsWith(`/api/${r.systemCode}/`)) errors.push(`對外路徑必須以 /api/${r.systemCode}/ 開頭(FRONTEND-GUIDE §3)`);
      if (/^\/api\/(auth|admin)(\/|$)/.test(r.publicPath)) errors.push('/api/auth/*、/api/admin/* 為 BFF 內建,路由表中設定會被忽略');
      if (r.timeoutMs !== undefined && (r.timeoutMs < 100 || r.timeoutMs > 60_000)) errors.push('逾時需介於 100 ~ 60000 ms');
      if (r.cacheTtlSec && (r.method !== 'GET' || !r.cacheScope)) errors.push('GET 快取需同時設定 cache_scope(shared / user)');

      const [[existing], conflicts] = await Promise.all([
        app.db.select({ status: apiRoute.status }).from(apiRoute).where(eq(apiRoute.routeCode, r.routeCode)),
        pathConflicts([r]),
      ]);
      if (conflicts.has(r.routeCode)) errors.push(`ROUTE_PATH_CONFLICT:與既有路由 ${conflicts.get(r.routeCode)} 的 ${r.method} ${r.publicPath} 衝突`);

      let upstreamUrl: string | null = null;
      if (r.routeType === 'proxy') {
        if (!r.upstreamCode) errors.push('proxy 路由必須指定上游');
        else {
          const [up] = await app.db.select().from(upstream).where(eq(upstream.code, r.upstreamCode));
          if (!up) errors.push(`上游不存在:${r.upstreamCode}(需先登記 upstream / upstream_target)`);
          else {
            const [t] = await app.db
              .select({ baseUrl: upstreamTarget.baseUrl })
              .from(upstreamTarget)
              .where(and(eq(upstreamTarget.upstreamId, up.upstreamId), eq(upstreamTarget.environment, 'test')));
            const upstreamPath = r.upstreamPath || r.publicPath.replace(new RegExp(`^/api/${r.systemCode}`), '');
            upstreamUrl = t ? `${t.baseUrl}${upstreamPath}` : null;
            if (!t) notes.push('此上游在測試區沒有位址(upstream_target)');
          }
        }
      } else notes.push('mock 路由只在測試區可用,回傳 mock_response 的固定 JSON(前端先行開發)');

      if (r.authMode === 'permission') {
        if (!r.permissionCode) errors.push('auth_mode = permission 時必須指定權限代碼');
        else {
          const [perm] = await app.db.select({ code: permission.code }).from(permission).where(eq(permission.code, r.permissionCode));
          if (!perm) notes.push(`權限 ${r.permissionCode} 尚不存在:匯入時可「一併建立」,但建立後仍需授權給角色才有人能呼叫`);
        }
      }
      if (existing) notes.push(`route_code 已存在(狀態 ${existing.status}):儲存後會改為草稿,發佈前線上仍使用舊設定`);

      return {
        ok: errors.length === 0,
        errors,
        notes,
        row: {
          route_code: r.routeCode,
          name: r.name,
          system_code: r.systemCode,
          method: r.method,
          public_path: r.publicPath,
          route_type: r.routeType,
          upstream: r.upstreamCode ?? null,
          upstream_path: r.upstreamPath || null,
          auth_mode: r.authMode,
          permission_code: r.authMode === 'permission' ? (r.permissionCode ?? null) : null,
          timeout_ms: r.timeoutMs ?? null,
          cache_ttl_sec: r.cacheTtlSec ?? null,
          cache_scope: r.cacheScope ?? null,
          status: 'draft',
          source: 'manual',
        },
        flow: {
          browser: `${r.method === '*' ? 'GET' : r.method} https://<gateway-ip>${r.publicPath}`,
          upstream: upstreamUrl ? `${r.method === '*' ? 'GET' : r.method} ${upstreamUrl}` : null,
          suggestedPublicPath: r.upstreamPath ? toPublicPath(r.systemCode, r.upstreamPath) : null,
        },
      };
    },
  );

  app.get<{ Querystring: { permission: string } }>(
    '/api/admin/demo/who-can-access',
    { schema: { querystring: { type: 'object', required: ['permission'], properties: { permission: { type: 'string' } } } } },
    async (req) => {
      await requirePerm(req, 'gw.admin.rbac.read');
      const code = req.query.permission;
      const [perm] = await app.db.select().from(permission).where(eq(permission.code, code));
      if (!perm) return { permission: code, exists: false, roles: [] };
      const roles = await app.db
        .select({ id: role.roleId, code: role.code, name: role.name })
        .from(rolePermission)
        .innerJoin(role, eq(role.roleId, rolePermission.roleId))
        .where(eq(rolePermission.permissionId, perm.permissionId));
      const ids = roles.map((r) => r.id);
      const [groups, companies, users] = ids.length
        ? await Promise.all([
            app.db.select({ roleId: roleAdGroup.roleId, dn: roleAdGroup.adGroupDn }).from(roleAdGroup).where(inArray(roleAdGroup.roleId, ids)),
            app.db
              .select({ roleId: roleCompany.roleId, name: company.compName })
              .from(roleCompany)
              .innerJoin(company, eq(company.companyId, roleCompany.companyId))
              .where(inArray(roleCompany.roleId, ids)),
            app.db
              .select({ roleId: userRole.roleId, emp: user.employeeNo, name: user.displayName })
              .from(userRole)
              .innerJoin(user, eq(user.userId, userRole.userId))
              .where(and(inArray(userRole.roleId, ids), or(isNull(userRole.validTo), gt(userRole.validTo, new Date())))),
          ])
        : [[], [], []];
      return {
        permission: code,
        exists: true,
        name: perm.name,
        // employee 角色為所有登入者預設(PRD §8.3)
        roles: roles.map((r) => ({
          code: r.code,
          name: r.name,
          everyone: r.code === 'employee',
          adGroups: groups.filter((g) => g.roleId === r.id).map((g) => g.dn),
          companies: companies.filter((c) => c.roleId === r.id).map((c) => c.name),
          users: users.filter((u) => u.roleId === r.id).map((u) => `${u.emp} ${u.name}`),
        })),
      };
    },
  );
};

export default onboarding;
