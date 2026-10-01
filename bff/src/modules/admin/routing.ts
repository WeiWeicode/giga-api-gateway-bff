/**
 * 路由設定管理 API(PRD §8.7、P2-1,供 W4 IT 管理介面):API Key 或登入者皆可。
 *
 *   GET    /api/admin/upstreams                      上游清單(含本區位址、路由數)          gw.admin.upstream.read
 *   GET    /api/admin/upstreams/:id                  上游明細                              gw.admin.upstream.read
 *   POST   /api/admin/upstreams                      新增上游(targets 為本區位址)          gw.admin.upstream.write
 *   PATCH  /api/admin/upstreams/:id                  修改上游(帶 targets 時取代本區位址)  gw.admin.upstream.write
 *   DELETE /api/admin/upstreams/:id?rowVer=          停用上游(仍有路由使用時拒絕)          gw.admin.upstream.write
 *   POST   /api/admin/upstreams/:id/health-check     逐一檢查本區位址的健康檢查路徑        gw.admin.upstream.read
 *   GET    /api/admin/routes                         路由清單(篩選、分頁)                  gw.admin.route.read
 *   GET    /api/admin/routes/:id                     路由明細(含聚合步驟)                  gw.admin.route.read
 *   POST   /api/admin/routes                         新增路由(草稿)                        gw.admin.route.write
 *   PATCH  /api/admin/routes/:id                     修改路由(已發佈者改為草稿)            gw.admin.route.write
 *   DELETE /api/admin/routes/:id?rowVer=             停用路由(下次發佈生效)                gw.admin.route.write
 *   PUT    /api/admin/routes/:id/steps               取代聚合步驟                          gw.admin.route.write
 *   GET/POST/PATCH/DELETE /api/admin/rate-limit-policies[/:id]   限流政策                  讀 gw.admin.route.read、寫 gw.admin.route.write
 *
 * - 修改與刪除需帶 rowVer(樂觀鎖,ROWVERSION 的 hex);不符回 409 VERSION_CONFLICT。
 * - 只寫資料庫,不更新 Redis:路由快照由發佈(releases.ts)組成,上游、政策的修改也在下次發佈時生效(PRD §8.4.3)。
 * - 每筆寫入與 gw.audit_log 同一交易(actor 為實際操作人)。
 */
import { and, asc, count, eq, inArray, like, ne, or, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { aggregateStep, apiRoute, auditLog, permission, rateLimitPolicy, rowVerFromHex, rowVerToHex, upstream, upstreamTarget } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { createAuthorizer, type Actor } from './authorize.js';
import type { Tx } from './route-import.js';
import {
  AUTH_MODES,
  checkPublicPath,
  checkRouteFields,
  checkSteps,
  checkSystemCode,
  checkTargetUrl,
  KEY_BY,
  ROUTE_METHODS,
  ROUTE_TYPES,
  STEP_METHODS,
  type FieldError,
} from './routing-rules.js';

const UP_READ = 'gw.admin.upstream.read';
const UP_WRITE = 'gw.admin.upstream.write';
const ROUTE_READ = 'gw.admin.route.read';
const ROUTE_WRITE = 'gw.admin.route.write';
const HEALTH_TIMEOUT_MS = 3000;
const STATUSES = ['draft', 'published', 'deprecated', 'disabled'] as const;

const str = (max: number, extra: object = {}) => ({ type: 'string', minLength: 1, maxLength: max, ...extra });
const nullableStr = (max: number, extra: object = {}) => ({ type: ['string', 'null'], maxLength: max, ...extra });
const intRange = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const nullableInt = (minimum: number, maximum: number) => ({ type: ['integer', 'null'], minimum, maximum });
const ROW_VER = { type: 'string', pattern: '^[0-9a-fA-F]{16}$' };
const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const DELETE_QS = { type: 'object', required: ['rowVer'], properties: { rowVer: ROW_VER } };
const SYSTEM_PATTERN = '^[a-z][a-z0-9-]{1,29}$';

const upstreamProps = {
  name: str(100),
  systemCode: str(30, { pattern: SYSTEM_PATTERN }),
  protocol: { type: 'string', enum: ['http', 'https'] },
  lbStrategy: { type: 'string', enum: ['round_robin', 'least_conn'] },
  timeoutMs: intRange(100, 120_000),
  retryCount: intRange(0, 5),
  circuitFailThreshold: intRange(1, 1000),
  healthCheckPath: nullableStr(200, { pattern: '^/' }),
  tlsVerify: { type: 'boolean' },
  forwardCookies: { type: 'boolean' },
  owner: nullableStr(64),
  project: nullableStr(100),
  archatlasNodeId: nullableStr(50),
  description: nullableStr(500),
  isEnabled: { type: 'boolean' },
  targets: {
    type: 'array',
    maxItems: 20,
    items: {
      type: 'object',
      required: ['baseUrl'],
      additionalProperties: false,
      properties: { baseUrl: str(300), weight: intRange(1, 100), isEnabled: { type: 'boolean' } },
    },
  },
} as const;

const routeProps = {
  name: str(100),
  systemCode: str(30, { pattern: SYSTEM_PATTERN }),
  method: { type: 'string', enum: ROUTE_METHODS },
  publicPath: str(300),
  routeType: { type: 'string', enum: ROUTE_TYPES },
  upstreamId: { type: ['integer', 'null'], minimum: 1 },
  upstreamMethod: { type: ['string', 'null'], enum: [...STEP_METHODS, null] },
  upstreamPath: nullableStr(300, { pattern: '^/' }),
  authMode: { type: 'string', enum: AUTH_MODES },
  permissionCode: nullableStr(100),
  rateLimitPolicyId: { type: ['integer', 'null'], minimum: 1 },
  cacheTtlSec: nullableInt(1, 86_400),
  cacheScope: { type: ['string', 'null'], enum: ['user', 'shared', null] },
  timeoutMs: nullableInt(100, 120_000),
  maxBodyKb: nullableInt(1, 10_240),
  requestHeadersAdd: { type: ['object', 'null'], additionalProperties: { type: 'string', maxLength: 500 }, maxProperties: 20 },
  responseHeadersRemove: { type: ['array', 'null'], maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 } },
  mockResponse: {},
  auditLevel: { type: 'string', enum: ['none', 'meta', 'body'] },
  priority: intRange(0, 32_767),
  versionTag: nullableStr(20),
  tags: nullableStr(200),
  owner: nullableStr(64),
  description: nullableStr(1000),
  gherkin: { type: ['string', 'null'], maxLength: 100_000 },
} as const;

const policyProps = {
  limitCount: intRange(1, 1_000_000),
  windowSec: intRange(1, 86_400),
  keyBy: { type: 'string', enum: KEY_BY },
  burst: nullableInt(1, 1_000_000),
} as const;

interface TargetInput {
  baseUrl: string;
  weight?: number;
  isEnabled?: boolean;
}
type UpstreamBody = Partial<Omit<typeof upstream.$inferInsert, 'upstreamId' | 'rowVer' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>> & {
  targets?: TargetInput[];
  rowVer?: string;
};
interface RouteBody {
  routeCode?: string;
  name?: string;
  systemCode?: string;
  method?: string;
  publicPath?: string;
  routeType?: string;
  upstreamId?: number | null;
  upstreamMethod?: string | null;
  upstreamPath?: string | null;
  authMode?: string;
  permissionCode?: string | null;
  rateLimitPolicyId?: number | null;
  cacheTtlSec?: number | null;
  cacheScope?: string | null;
  timeoutMs?: number | null;
  maxBodyKb?: number | null;
  requestHeadersAdd?: Record<string, string> | null;
  responseHeadersRemove?: string[] | null;
  mockResponse?: unknown;
  auditLevel?: string;
  priority?: number;
  versionTag?: string | null;
  tags?: string | null;
  owner?: string | null;
  description?: string | null;
  gherkin?: string | null;
  status?: 'draft' | 'deprecated';
  rowVer?: string;
}
interface StepBody {
  stepKey: string;
  stepOrder: number;
  upstreamId: number;
  method: string;
  pathTemplate: string;
  required?: boolean;
  timeoutMs?: number;
  permissionCode?: string | null;
}
type PolicyBody = { code?: string; limitCount?: number; windowSec?: number; keyBy?: string; burst?: number | null; rowVer?: string };

const fail = (errors: FieldError[]) => {
  if (errors.length) throw new GwError('VALIDATION_FAILED', undefined, errors);
};
const notFound = (what: string, id: number | string) => new GwError('VALIDATION_FAILED', `${what}不存在`, [{ field: 'id', message: String(id) }]);
const pick = <T extends object>(o: T, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined));
/** JSON 欄位:undefined = 不修改,null = 清除 */
const jsonCol = (v: unknown) => (v === undefined ? undefined : v === null ? null : JSON.stringify(v));
const parseJson = (raw: string | null) => (raw == null ? null : (JSON.parse(raw) as unknown));

/** 輸出時以 hex 表示 row_ver */
const withVer = <T extends { rowVer: Buffer }>(r: T) => ({ ...r, rowVer: rowVerToHex(r.rowVer) });

function verOf(hex: string): Buffer {
  try {
    return rowVerFromHex(hex);
  } catch {
    throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'rowVer', message: '格式錯誤' }]);
  }
}

const routing: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  const authorize = createAuthorizer(app);
  const env = config.gwEnv === 'prod' ? 'prod' : 'test';

  async function writeAudit(tx: Tx, req: FastifyRequest, actor: Actor, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
    await tx.insert(auditLog).values({
      actorUserId: actor.userId,
      actorName: actor.name,
      actorIp: req.ip,
      action,
      entityType,
      entityId,
      beforeJson: before === null ? null : JSON.stringify(before),
      afterJson: after === null ? null : JSON.stringify(after),
      requestId: req.id,
    });
  }

  // ───────── 上游 ─────────

  async function targetsOf(ids: number[]) {
    if (!ids.length) return [];
    return app.db
      .select({
        targetId: upstreamTarget.targetId,
        upstreamId: upstreamTarget.upstreamId,
        baseUrl: upstreamTarget.baseUrl,
        weight: upstreamTarget.weight,
        isEnabled: upstreamTarget.isEnabled,
      })
      .from(upstreamTarget)
      .where(and(inArray(upstreamTarget.upstreamId, ids), eq(upstreamTarget.environment, env)))
      .orderBy(asc(upstreamTarget.targetId));
  }

  async function upstreamDetail(id: number) {
    const [u] = await app.db.select().from(upstream).where(eq(upstream.upstreamId, id));
    if (!u) throw notFound('上游', id);
    const targets = (await targetsOf([id])).map(({ upstreamId: _, ...t }) => t);
    return { ...withVer(u), environment: env, targets };
  }

  function checkTargets(targets: TargetInput[] | undefined): FieldError[] {
    const errors: FieldError[] = [];
    const seen = new Set<string>();
    for (const [i, t] of (targets ?? []).entries()) {
      const r = checkTargetUrl(t.baseUrl);
      if (r === 'invalid') errors.push({ field: `targets[${i}].baseUrl`, message: '需為 http(s)://主機:port,不含路徑' });
      if (seen.has(t.baseUrl)) errors.push({ field: `targets[${i}].baseUrl`, message: '位址重複' });
      seen.add(t.baseUrl);
    }
    return errors;
  }

  /** port 不在 51200–51300 時以專用代碼回應(PRD §8.1.1) */
  function checkTargetPorts(targets: TargetInput[] | undefined) {
    const bad = (targets ?? []).filter((t) => checkTargetUrl(t.baseUrl) === 'port').map((t) => t.baseUrl);
    if (bad.length)
      throw new GwError(
        'UPSTREAM_PORT_OUT_OF_RANGE',
        undefined,
        bad.map((b) => ({ field: 'targets', message: b })),
      );
  }

  async function replaceTargets(tx: Tx, upstreamId: number, targets: TargetInput[], actor: string) {
    await tx.delete(upstreamTarget).where(and(eq(upstreamTarget.upstreamId, upstreamId), eq(upstreamTarget.environment, env)));
    for (const t of targets)
      await tx.insert(upstreamTarget).values({
        upstreamId,
        baseUrl: t.baseUrl,
        weight: t.weight ?? 1,
        isEnabled: t.isEnabled ?? true,
        environment: env,
        createdBy: actor,
        updatedBy: actor,
      });
  }

  app.get('/api/admin/upstreams', async (req) => {
    await authorize(req, UP_READ);
    const [ups, routeCounts] = await Promise.all([
      app.db.select().from(upstream).orderBy(asc(upstream.code)),
      app.db.select({ upstreamId: apiRoute.upstreamId, n: count() }).from(apiRoute).where(ne(apiRoute.status, 'disabled')).groupBy(apiRoute.upstreamId),
    ]);
    const targets = await targetsOf(ups.map((u) => u.upstreamId));
    return {
      environment: env,
      items: ups.map((u) => ({
        ...withVer(u),
        routes: routeCounts.find((c) => c.upstreamId === u.upstreamId)?.n ?? 0,
        targets: targets.filter((t) => t.upstreamId === u.upstreamId).map(({ upstreamId: _, ...t }) => t),
      })),
    };
  });

  app.get<{ Params: { id: number } }>('/api/admin/upstreams/:id', { schema: { params: ID_PARAMS } }, async (req) => {
    await authorize(req, UP_READ);
    return upstreamDetail(req.params.id);
  });

  const UPSTREAM_FIELDS = Object.keys(upstreamProps).filter((k) => k !== 'targets');

  app.post<{ Body: UpstreamBody & { code: string } }>(
    '/api/admin/upstreams',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'name', 'systemCode'],
          additionalProperties: false,
          properties: { code: str(50, { pattern: '^[a-z][a-z0-9-]{1,49}$' }), ...upstreamProps },
        },
      },
    },
    async (req, reply) => {
      const actor = await authorize(req, UP_WRITE);
      const b = req.body;
      fail([...checkSystemCode(b.systemCode!), ...checkTargets(b.targets)]);
      checkTargetPorts(b.targets);
      if ((await app.db.select({ id: upstream.upstreamId }).from(upstream).where(eq(upstream.code, b.code))).length)
        fail([{ field: 'code', message: '上游代碼已存在' }]);
      const id = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(upstream)
          .output({ id: upstream.upstreamId })
          .values({ ...pick(b, UPSTREAM_FIELDS), code: b.code, name: b.name!, systemCode: b.systemCode!, createdBy: actor.name, updatedBy: actor.name });
        if (b.targets) await replaceTargets(tx, row!.id, b.targets, actor.name);
        await writeAudit(tx, req, actor, 'upstream.create', 'upstream', b.code, null, { ...b, environment: env });
        return row!.id;
      });
      return reply.code(201).send(await upstreamDetail(id));
    },
  );

  app.patch<{ Params: { id: number }; Body: UpstreamBody }>(
    '/api/admin/upstreams/:id',
    {
      schema: {
        params: ID_PARAMS,
        body: { type: 'object', required: ['rowVer'], additionalProperties: false, properties: { rowVer: ROW_VER, ...upstreamProps } },
      },
    },
    async (req) => {
      const actor = await authorize(req, UP_WRITE);
      const b = req.body;
      const before = await upstreamDetail(req.params.id);
      fail([...(b.systemCode ? checkSystemCode(b.systemCode) : []), ...checkTargets(b.targets)]);
      checkTargetPorts(b.targets);
      if (b.isEnabled === false) await assertUpstreamUnused(req.params.id);
      await app.db.transaction(async (tx) => {
        const rows = await tx
          .update(upstream)
          .set({ ...pick(b, UPSTREAM_FIELDS), updatedBy: actor.name })
          .output({ inserted: { id: upstream.upstreamId } })
          .where(and(eq(upstream.upstreamId, req.params.id), eq(upstream.rowVer, verOf(b.rowVer!))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        if (b.targets) await replaceTargets(tx, req.params.id, b.targets, actor.name);
        await writeAudit(tx, req, actor, 'upstream.update', 'upstream', before.code, before, { ...b, environment: env });
      });
      return upstreamDetail(req.params.id);
    },
  );

  /** 停用上游前確認沒有未停用的路由或聚合步驟使用它(否則發佈後這些路由會失效) */
  async function assertUpstreamUnused(id: number) {
    const [routes, steps] = await Promise.all([
      app.db
        .select({ code: apiRoute.routeCode })
        .from(apiRoute)
        .where(and(eq(apiRoute.upstreamId, id), ne(apiRoute.status, 'disabled'))),
      app.db
        .select({ code: apiRoute.routeCode })
        .from(aggregateStep)
        .innerJoin(apiRoute, eq(aggregateStep.routeId, apiRoute.routeId))
        .where(and(eq(aggregateStep.upstreamId, id), ne(apiRoute.status, 'disabled'))),
    ]);
    const codes = [...new Set([...routes, ...steps].map((r) => r.code))];
    if (codes.length) fail(codes.map((c) => ({ field: 'routes', message: `仍被路由使用:${c}` })));
  }

  app.delete<{ Params: { id: number }; Querystring: { rowVer: string } }>(
    '/api/admin/upstreams/:id',
    { schema: { params: ID_PARAMS, querystring: DELETE_QS } },
    async (req) => {
      const actor = await authorize(req, UP_WRITE);
      const before = await upstreamDetail(req.params.id);
      await assertUpstreamUnused(req.params.id);
      await app.db.transaction(async (tx) => {
        const rows = await tx
          .update(upstream)
          .set({ isEnabled: false, updatedBy: actor.name })
          .output({ inserted: { id: upstream.upstreamId } })
          .where(and(eq(upstream.upstreamId, req.params.id), eq(upstream.rowVer, verOf(req.query.rowVer))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        await writeAudit(tx, req, actor, 'upstream.disable', 'upstream', before.code, before, { isEnabled: false });
      });
      return upstreamDetail(req.params.id);
    },
  );

  app.post<{ Params: { id: number } }>('/api/admin/upstreams/:id/health-check', { schema: { params: ID_PARAMS } }, async (req) => {
    await authorize(req, UP_READ);
    const u = await upstreamDetail(req.params.id);
    const path = u.healthCheckPath ?? '/healthz';
    const results = await Promise.all(
      u.targets.map(async (t) => {
        const started = Date.now();
        try {
          const res = await fetch(new URL(path, t.baseUrl), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), headers: { 'x-request-id': req.id } });
          await res.body?.cancel();
          return { baseUrl: t.baseUrl, isEnabled: t.isEnabled, ok: res.ok, status: res.status, ms: Date.now() - started };
        } catch (err) {
          const e = err as Error;
          return {
            baseUrl: t.baseUrl,
            isEnabled: t.isEnabled,
            ok: false,
            status: null,
            ms: Date.now() - started,
            error: e.name === 'TimeoutError' ? 'timeout' : e.message,
          };
        }
      }),
    );
    return { upstream: u.code, environment: env, path, results };
  });

  // ───────── 路由 ─────────

  async function routeDetail(id: number) {
    const [r] = await app.db
      .select({ route: apiRoute, upstreamCode: upstream.code, policyCode: rateLimitPolicy.code })
      .from(apiRoute)
      .leftJoin(upstream, eq(apiRoute.upstreamId, upstream.upstreamId))
      .leftJoin(rateLimitPolicy, eq(apiRoute.rateLimitPolicyId, rateLimitPolicy.policyId))
      .where(eq(apiRoute.routeId, id));
    if (!r) throw notFound('路由', id);
    const steps = await app.db
      .select({
        stepKey: aggregateStep.stepKey,
        stepOrder: aggregateStep.stepOrder,
        upstreamId: aggregateStep.upstreamId,
        upstreamCode: upstream.code,
        method: aggregateStep.method,
        pathTemplate: aggregateStep.pathTemplate,
        required: aggregateStep.required,
        timeoutMs: aggregateStep.timeoutMs,
        permissionCode: aggregateStep.permissionCode,
      })
      .from(aggregateStep)
      .innerJoin(upstream, eq(aggregateStep.upstreamId, upstream.upstreamId))
      .where(eq(aggregateStep.routeId, id))
      .orderBy(asc(aggregateStep.stepOrder), asc(aggregateStep.stepKey));
    const x = r.route;
    return {
      ...withVer(x),
      requestHeadersAdd: parseJson(x.requestHeadersAdd),
      responseHeadersRemove: parseJson(x.responseHeadersRemove),
      mockResponse: parseJson(x.mockResponse),
      upstreamCode: r.upstreamCode,
      rateLimitPolicy: r.policyCode,
      steps,
    };
  }

  /** 需查資料庫的檢查:上游、權限、政策存在;對外路徑與其他未停用路由不衝突 */
  async function checkRouteRefs(r: {
    routeId?: number;
    method: string;
    publicPath: string;
    upstreamId: number | null;
    permissionCode: string | null;
    rateLimitPolicyId: number | null;
  }) {
    const errors: FieldError[] = [];
    if (r.upstreamId != null) {
      const [u] = await app.db.select({ isEnabled: upstream.isEnabled }).from(upstream).where(eq(upstream.upstreamId, r.upstreamId));
      if (!u?.isEnabled) errors.push({ field: 'upstreamId', message: '上游不存在或已停用' });
    }
    if (r.permissionCode && !(await app.db.select({ c: permission.code }).from(permission).where(eq(permission.code, r.permissionCode))).length)
      errors.push({ field: 'permissionCode', message: '權限代碼不存在' });
    if (
      r.rateLimitPolicyId != null &&
      !(await app.db.select({ id: rateLimitPolicy.policyId }).from(rateLimitPolicy).where(eq(rateLimitPolicy.policyId, r.rateLimitPolicyId))).length
    )
      errors.push({ field: 'rateLimitPolicyId', message: '限流政策不存在' });
    fail(errors);
    const hits = await app.db
      .select({ routeId: apiRoute.routeId, code: apiRoute.routeCode })
      .from(apiRoute)
      .where(and(eq(apiRoute.method, r.method), eq(apiRoute.publicPath, r.publicPath), ne(apiRoute.status, 'disabled')));
    const hit = hits.find((h) => h.routeId !== r.routeId);
    if (hit) throw new GwError('ROUTE_PATH_CONFLICT', undefined, [{ field: 'publicPath', message: `與既有路由 ${hit.code} 衝突` }]);
  }

  const ROUTE_FIELDS = Object.keys(routeProps).filter((k) => !['requestHeadersAdd', 'responseHeadersRemove', 'mockResponse'].includes(k));
  const routeValues = (b: RouteBody) => ({
    ...pick(b, ROUTE_FIELDS),
    ...pick(
      { requestHeadersAdd: jsonCol(b.requestHeadersAdd), responseHeadersRemove: jsonCol(b.responseHeadersRemove), mockResponse: jsonCol(b.mockResponse) },
      ['requestHeadersAdd', 'responseHeadersRemove', 'mockResponse'],
    ),
  });

  app.get<{ Querystring: { q?: string; system?: string; status?: string; upstreamId?: number; page?: number; pageSize?: number } }>(
    '/api/admin/routes',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 100 },
            system: { type: 'string', maxLength: 30 },
            status: { type: 'string', maxLength: 60 },
            upstreamId: { type: 'integer', minimum: 1 },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => {
      await authorize(req, ROUTE_READ);
      const { page = 1, pageSize = 50 } = req.query;
      const conds: (SQL | undefined)[] = [];
      const statuses = (req.query.status ?? '').split(',').filter((s): s is (typeof STATUSES)[number] => (STATUSES as readonly string[]).includes(s));
      if (statuses.length) conds.push(inArray(apiRoute.status, statuses));
      if (req.query.system) conds.push(eq(apiRoute.systemCode, req.query.system));
      if (req.query.upstreamId) conds.push(eq(apiRoute.upstreamId, req.query.upstreamId));
      const q = req.query.q?.trim();
      if (q) {
        const pat = `%${q.replace(/[[%_]/g, (c) => `[${c}]`)}%`;
        conds.push(
          or(
            like(apiRoute.routeCode, pat),
            like(apiRoute.name, pat),
            like(apiRoute.publicPath, pat),
            like(apiRoute.permissionCode, pat),
            like(apiRoute.tags, pat),
          ),
        );
      }
      const where = and(...conds);
      const [[total], rows] = await Promise.all([
        app.db.select({ n: count() }).from(apiRoute).where(where),
        app.db
          .select({
            routeId: apiRoute.routeId,
            routeCode: apiRoute.routeCode,
            name: apiRoute.name,
            systemCode: apiRoute.systemCode,
            method: apiRoute.method,
            publicPath: apiRoute.publicPath,
            routeType: apiRoute.routeType,
            upstreamCode: upstream.code,
            authMode: apiRoute.authMode,
            permissionCode: apiRoute.permissionCode,
            status: apiRoute.status,
            source: apiRoute.source,
            tags: apiRoute.tags,
            updatedAt: apiRoute.updatedAt,
            updatedBy: apiRoute.updatedBy,
            rowVer: apiRoute.rowVer,
          })
          .from(apiRoute)
          .leftJoin(upstream, eq(apiRoute.upstreamId, upstream.upstreamId))
          .where(where)
          .orderBy(asc(apiRoute.routeCode))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
      ]);
      return { total: total?.n ?? 0, page, pageSize, items: rows.map(withVer) };
    },
  );

  app.get<{ Params: { id: number } }>('/api/admin/routes/:id', { schema: { params: ID_PARAMS } }, async (req) => {
    await authorize(req, ROUTE_READ);
    return routeDetail(req.params.id);
  });

  app.post<{ Body: RouteBody }>(
    '/api/admin/routes',
    {
      schema: {
        body: {
          type: 'object',
          required: ['routeCode', 'name', 'systemCode', 'method', 'publicPath', 'routeType', 'authMode'],
          additionalProperties: false,
          properties: { routeCode: str(100, { pattern: '^[a-z0-9][a-z0-9_-]*(\\.[a-z0-9_-]+)+$' }), ...routeProps },
        },
      },
    },
    async (req, reply) => {
      const actor = await authorize(req, ROUTE_WRITE);
      const b = req.body;
      const values = routeValues(b) as Partial<typeof apiRoute.$inferInsert>;
      const merged = {
        routeType: b.routeType!,
        method: b.method!,
        upstreamId: b.upstreamId ?? null,
        authMode: b.authMode!,
        permissionCode: b.permissionCode ?? null,
        cacheTtlSec: b.cacheTtlSec ?? null,
        cacheScope: b.cacheScope ?? null,
        mockResponse: values.mockResponse ?? null,
        requestHeadersAdd: values.requestHeadersAdd ?? null,
        responseHeadersRemove: values.responseHeadersRemove ?? null,
      };
      fail([...checkSystemCode(b.systemCode!), ...checkPublicPath(b.systemCode!, b.publicPath!), ...checkRouteFields(merged, config.gwEnv)]);
      if ((await app.db.select({ id: apiRoute.routeId }).from(apiRoute).where(eq(apiRoute.routeCode, b.routeCode!))).length)
        fail([{ field: 'routeCode', message: '路由代碼已存在' }]);
      await checkRouteRefs({
        method: b.method!,
        publicPath: b.publicPath!,
        upstreamId: merged.upstreamId,
        permissionCode: merged.permissionCode,
        rateLimitPolicyId: b.rateLimitPolicyId ?? null,
      });
      const id = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(apiRoute)
          .output({ id: apiRoute.routeId })
          .values({
            ...values,
            routeCode: b.routeCode!,
            name: b.name!,
            systemCode: b.systemCode!,
            method: b.method!,
            publicPath: b.publicPath!,
            routeType: b.routeType!,
            authMode: b.authMode!,
            status: 'draft',
            source: 'manual',
            createdBy: actor.name,
            updatedBy: actor.name,
          });
        await writeAudit(tx, req, actor, 'route.create', 'api_route', b.routeCode!, null, b);
        return row!.id;
      });
      return reply.code(201).send(await routeDetail(id));
    },
  );

  app.patch<{ Params: { id: number }; Body: RouteBody }>(
    '/api/admin/routes/:id',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          required: ['rowVer'],
          additionalProperties: false,
          properties: { rowVer: ROW_VER, status: { type: 'string', enum: ['draft', 'deprecated'] }, ...routeProps },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, ROUTE_WRITE);
      const b = req.body;
      const [cur] = await app.db.select().from(apiRoute).where(eq(apiRoute.routeId, req.params.id));
      if (!cur) throw notFound('路由', req.params.id);
      const values = routeValues(b) as Partial<typeof apiRoute.$inferInsert>;
      const m = { ...cur, ...values };
      fail([...checkSystemCode(m.systemCode), ...checkPublicPath(m.systemCode, m.publicPath), ...checkRouteFields(m, config.gwEnv)]);
      // 狀態:明確指定者優先;否則已發佈 → 草稿(線上仍用目前版本,下次發佈生效),草稿 / 棄用 / 停用維持
      const status = b.status ?? (cur.status === 'published' ? 'draft' : cur.status);
      if (status !== 'disabled')
        await checkRouteRefs({
          routeId: cur.routeId,
          method: m.method,
          publicPath: m.publicPath,
          upstreamId: m.upstreamId,
          permissionCode: m.permissionCode,
          rateLimitPolicyId: m.rateLimitPolicyId,
        });
      const deprecatedAt = status === 'deprecated' ? (cur.deprecatedAt ?? new Date()) : null;
      await app.db.transaction(async (tx) => {
        const rows = await tx
          .update(apiRoute)
          .set({ ...values, status, deprecatedAt, updatedBy: actor.name })
          .output({ inserted: { id: apiRoute.routeId } })
          .where(and(eq(apiRoute.routeId, cur.routeId), eq(apiRoute.rowVer, verOf(b.rowVer!))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        await writeAudit(tx, req, actor, 'route.update', 'api_route', cur.routeCode, withVer(cur), { ...b, status });
      });
      return routeDetail(cur.routeId);
    },
  );

  app.delete<{ Params: { id: number }; Querystring: { rowVer: string } }>(
    '/api/admin/routes/:id',
    { schema: { params: ID_PARAMS, querystring: DELETE_QS } },
    async (req) => {
      const actor = await authorize(req, ROUTE_WRITE);
      const [cur] = await app.db.select().from(apiRoute).where(eq(apiRoute.routeId, req.params.id));
      if (!cur) throw notFound('路由', req.params.id);
      await app.db.transaction(async (tx) => {
        const rows = await tx
          .update(apiRoute)
          .set({ status: 'disabled', updatedBy: actor.name })
          .output({ inserted: { id: apiRoute.routeId } })
          .where(and(eq(apiRoute.routeId, cur.routeId), eq(apiRoute.rowVer, verOf(req.query.rowVer))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        await writeAudit(tx, req, actor, 'route.disable', 'api_route', cur.routeCode, { status: cur.status }, { status: 'disabled' });
      });
      return routeDetail(cur.routeId);
    },
  );

  app.put<{ Params: { id: number }; Body: { rowVer: string; steps: StepBody[] } }>(
    '/api/admin/routes/:id/steps',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          required: ['rowVer', 'steps'],
          additionalProperties: false,
          properties: {
            rowVer: ROW_VER,
            steps: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['stepKey', 'stepOrder', 'upstreamId', 'method', 'pathTemplate'],
                additionalProperties: false,
                properties: {
                  stepKey: str(50, { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }),
                  stepOrder: intRange(0, 100),
                  upstreamId: { type: 'integer', minimum: 1 },
                  method: { type: 'string', enum: STEP_METHODS },
                  pathTemplate: str(300),
                  required: { type: 'boolean' },
                  timeoutMs: intRange(100, 120_000),
                  permissionCode: nullableStr(100),
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, ROUTE_WRITE);
      const { steps } = req.body;
      const [cur] = await app.db.select().from(apiRoute).where(eq(apiRoute.routeId, req.params.id));
      if (!cur) throw notFound('路由', req.params.id);
      const errors = checkSteps(steps);
      if (cur.routeType !== 'aggregate') errors.push({ field: 'routeType', message: '只有 aggregate 路由可設定步驟' });
      const upIds = [...new Set(steps.map((s) => s.upstreamId))];
      const enabledUps = new Set(
        upIds.length
          ? (
              await app.db
                .select({ id: upstream.upstreamId })
                .from(upstream)
                .where(and(inArray(upstream.upstreamId, upIds), eq(upstream.isEnabled, true)))
            ).map((u) => u.id)
          : [],
      );
      const permCodes = [...new Set(steps.map((s) => s.permissionCode).filter((c): c is string => !!c))];
      const perms = new Set(
        permCodes.length ? (await app.db.select({ c: permission.code }).from(permission).where(inArray(permission.code, permCodes))).map((p) => p.c) : [],
      );
      steps.forEach((s, i) => {
        if (!enabledUps.has(s.upstreamId)) errors.push({ field: `steps[${i}].upstreamId`, message: '上游不存在或已停用' });
        if (s.permissionCode && !perms.has(s.permissionCode)) errors.push({ field: `steps[${i}].permissionCode`, message: '權限代碼不存在' });
      });
      fail(errors);
      const status = cur.status === 'published' ? 'draft' : cur.status;
      await app.db.transaction(async (tx) => {
        // 以路由的 row_ver 保護整組步驟,並遞增路由版本
        const rows = await tx
          .update(apiRoute)
          .set({ status, updatedBy: actor.name })
          .output({ inserted: { id: apiRoute.routeId } })
          .where(and(eq(apiRoute.routeId, cur.routeId), eq(apiRoute.rowVer, verOf(req.body.rowVer))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        await tx.delete(aggregateStep).where(eq(aggregateStep.routeId, cur.routeId));
        for (const s of steps)
          await tx.insert(aggregateStep).values({
            routeId: cur.routeId,
            stepKey: s.stepKey,
            stepOrder: s.stepOrder,
            upstreamId: s.upstreamId,
            method: s.method,
            pathTemplate: s.pathTemplate,
            required: s.required ?? false,
            timeoutMs: s.timeoutMs ?? 5000,
            permissionCode: s.permissionCode ?? null,
            createdBy: actor.name,
            updatedBy: actor.name,
          });
        await writeAudit(tx, req, actor, 'route.steps', 'api_route', cur.routeCode, null, { steps, status });
      });
      return routeDetail(cur.routeId);
    },
  );

  // ───────── 限流政策 ─────────

  async function policyDetail(id: number) {
    const [p] = await app.db.select().from(rateLimitPolicy).where(eq(rateLimitPolicy.policyId, id));
    if (!p) throw notFound('限流政策', id);
    const [used] = await app.db.select({ n: count() }).from(apiRoute).where(eq(apiRoute.rateLimitPolicyId, id));
    return { ...withVer(p), routes: used?.n ?? 0 };
  }

  app.get('/api/admin/rate-limit-policies', async (req) => {
    await authorize(req, ROUTE_READ);
    const [policies, used] = await Promise.all([
      app.db.select().from(rateLimitPolicy).orderBy(asc(rateLimitPolicy.code)),
      app.db.select({ id: apiRoute.rateLimitPolicyId, n: count() }).from(apiRoute).groupBy(apiRoute.rateLimitPolicyId),
    ]);
    return { items: policies.map((p) => ({ ...withVer(p), routes: used.find((u) => u.id === p.policyId)?.n ?? 0 })) };
  });

  app.post<{ Body: PolicyBody }>(
    '/api/admin/rate-limit-policies',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'limitCount', 'windowSec', 'keyBy'],
          additionalProperties: false,
          properties: { code: str(50, { pattern: '^[a-z0-9][a-z0-9-]*$' }), ...policyProps },
        },
      },
    },
    async (req, reply) => {
      const actor = await authorize(req, ROUTE_WRITE);
      const b = req.body;
      if ((await app.db.select({ id: rateLimitPolicy.policyId }).from(rateLimitPolicy).where(eq(rateLimitPolicy.code, b.code!))).length)
        fail([{ field: 'code', message: '政策代碼已存在' }]);
      const id = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(rateLimitPolicy)
          .output({ id: rateLimitPolicy.policyId })
          .values({
            code: b.code!,
            limitCount: b.limitCount!,
            windowSec: b.windowSec!,
            keyBy: b.keyBy!,
            burst: b.burst ?? null,
            createdBy: actor.name,
            updatedBy: actor.name,
          });
        await writeAudit(tx, req, actor, 'rate_limit.create', 'rate_limit_policy', b.code!, null, b);
        return row!.id;
      });
      return reply.code(201).send(await policyDetail(id));
    },
  );

  app.patch<{ Params: { id: number }; Body: PolicyBody }>(
    '/api/admin/rate-limit-policies/:id',
    {
      schema: {
        params: ID_PARAMS,
        body: { type: 'object', required: ['rowVer'], additionalProperties: false, properties: { rowVer: ROW_VER, ...policyProps } },
      },
    },
    async (req) => {
      const actor = await authorize(req, ROUTE_WRITE);
      const before = await policyDetail(req.params.id);
      await app.db.transaction(async (tx) => {
        const rows = await tx
          .update(rateLimitPolicy)
          .set({ ...pick(req.body, Object.keys(policyProps)), updatedBy: actor.name })
          .output({ inserted: { id: rateLimitPolicy.policyId } })
          .where(and(eq(rateLimitPolicy.policyId, req.params.id), eq(rateLimitPolicy.rowVer, verOf(req.body.rowVer!))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        await writeAudit(tx, req, actor, 'rate_limit.update', 'rate_limit_policy', before.code, before, req.body);
      });
      return policyDetail(req.params.id);
    },
  );

  app.delete<{ Params: { id: number }; Querystring: { rowVer: string } }>(
    '/api/admin/rate-limit-policies/:id',
    { schema: { params: ID_PARAMS, querystring: DELETE_QS } },
    async (req, reply) => {
      const actor = await authorize(req, ROUTE_WRITE);
      const before = await policyDetail(req.params.id);
      // 路由(含已停用)以外鍵參照政策,仍有參照時不可刪除
      if (before.routes) fail([{ field: 'id', message: `仍有 ${before.routes} 條路由使用此政策` }]);
      await app.db.transaction(async (tx) => {
        const rows = await tx
          .delete(rateLimitPolicy)
          .output({ id: rateLimitPolicy.policyId })
          .where(and(eq(rateLimitPolicy.policyId, req.params.id), eq(rateLimitPolicy.rowVer, verOf(req.query.rowVer))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        await writeAudit(tx, req, actor, 'rate_limit.delete', 'rate_limit_policy', before.code, before, null);
      });
      return reply.code(204).send();
    },
  );
};

export default routing;
