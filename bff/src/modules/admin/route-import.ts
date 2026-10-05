/**
 * OpenAPI 匯入寫入(PRD §8.4.4、BACKEND-GUIDE.md §6–§7):CLI `import-openapi` 與後端自動註冊(POST /api/admin/registrations)共用。
 *   驗證(必填欄位、限流政策、上游 port、對外路徑衝突)→ 有錯誤:只記錄失敗批次,不寫入任何路由
 *   → 無錯誤:上游 / 上游位址 / 權限代碼 / 路由草稿 / 匯入批次與逐筆結果 / 稽核,同一交易寫入。
 * 只寫草稿,不發佈;線上仍使用目前發佈版本(BACKEND-GUIDE §7.3)。
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { checkUpstreamPort, parseOpenApi, type ParsedSpec, type PermissionDecl } from '../../cli/openapi.js';
import type { GwDatabase } from '../../db/client.js';
import { apiImportBatch, apiImportItem, apiRoute, auditLog, permission, rateLimitPolicy, upstream, upstreamTarget } from '../../db/schema/index.js';

export type Tx = Parameters<Parameters<GwDatabase['transaction']>[0]>[0];

/** 匯入驗證失敗(code 對應 PRD §8.1.1) */
export class ImportError extends Error {
  constructor(
    readonly code: 'IMPORT_HAS_ERRORS' | 'UPSTREAM_PORT_OUT_OF_RANGE',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 權限代碼 → system / resource / action 欄位(gw.admin.route.read → gw / admin / route.read) */
export function permParts(code: string) {
  const [system = 'gw', resource = 'default', ...rest] = code.split('.');
  return { systemCode: system.slice(0, 30), resource: resource.slice(0, 50), action: (rest.join('.') || 'use').slice(0, 30) };
}

/**
 * 建立不存在的權限(首次登記)。已存在者以 GigaItApp「選單管理」為準(2026-10-05 決定):名稱不覆寫;
 * kind / parent / sort 只在尚未設定過(kind = api、無上層、無排序,例如舊版匯入時未宣告)時補上,之後不再覆寫。
 * 回傳新建數量。
 */
export async function ensurePermissions(tx: Tx, perms: PermissionDecl[], actor: string): Promise<number> {
  if (!perms.length) return 0;
  const existing = new Map(
    (
      await tx
        .select({ id: permission.permissionId, code: permission.code, kind: permission.kind, parentCode: permission.parentCode, sort: permission.sort })
        .from(permission)
        .where(
          inArray(
            permission.code,
            perms.map((p) => p.code),
          ),
        )
    ).map((p) => [p.code, p]),
  );
  let created = 0;
  for (const p of perms) {
    const meta = { kind: p.kind ?? 'api', parentCode: p.parent ?? null, sort: p.sort ?? null };
    const cur = existing.get(p.code);
    if (!cur) {
      await tx.insert(permission).values({ code: p.code, name: p.name, ...permParts(p.code), ...meta, createdBy: actor, updatedBy: actor });
      created++;
    } else if (
      (p.kind !== undefined || p.parent !== undefined || p.sort !== undefined) &&
      cur.kind === 'api' &&
      cur.parentCode === null &&
      cur.sort === null &&
      (cur.kind !== meta.kind || cur.parentCode !== meta.parentCode || cur.sort !== meta.sort)
    ) {
      await tx
        .update(permission)
        .set({ ...meta, updatedBy: actor })
        .where(eq(permission.permissionId, cur.id));
    }
  }
  return created;
}

export async function upsertUpstream(
  tx: Tx,
  u: {
    code: string;
    name?: string;
    systemCode: string;
    timeoutMs?: number;
    retryCount?: number;
    circuitFailThreshold?: number;
    healthCheckPath?: string;
    forwardCookies?: boolean;
    /** 開發專案(repo 資料夾名稱);未提供時保留既有值 */
    project?: string | null;
  },
  actor: string,
): Promise<number> {
  const [cur] = await tx.select().from(upstream).where(eq(upstream.code, u.code));
  const values = {
    name: u.name ?? u.code,
    systemCode: u.systemCode,
    timeoutMs: u.timeoutMs ?? cur?.timeoutMs ?? 10_000,
    retryCount: u.retryCount ?? cur?.retryCount ?? 1,
    circuitFailThreshold: u.circuitFailThreshold ?? cur?.circuitFailThreshold ?? 10,
    healthCheckPath: u.healthCheckPath ?? cur?.healthCheckPath ?? '/healthz',
    forwardCookies: u.forwardCookies ?? cur?.forwardCookies ?? false,
    project: u.project ?? cur?.project ?? null,
    updatedBy: actor,
  };
  if (cur) {
    await tx.update(upstream).set(values).where(eq(upstream.upstreamId, cur.upstreamId));
    return cur.upstreamId;
  }
  const [row] = await tx
    .insert(upstream)
    .output({ id: upstream.upstreamId })
    .values({ code: u.code, ...values, createdBy: actor });
  return row!.id;
}

/**
 * 設定上游位址。replace:以 urls 取代該部署區的全部位址(CLI);
 * add:只補上尚未登記的位址(自動註冊:同一服務多台主機各自註冊,不互相覆蓋)。
 * 回傳新增的位址數。
 */
export async function setTargets(tx: Tx, upstreamId: number, env: string, urls: string[], actor: string, mode: 'replace' | 'add' = 'replace'): Promise<number> {
  for (const url of urls)
    if (!checkUpstreamPort(url)) throw new ImportError('UPSTREAM_PORT_OUT_OF_RANGE', `UPSTREAM_PORT_OUT_OF_RANGE:${url} 的 port 不在 51200–51300`);
  const where = and(eq(upstreamTarget.upstreamId, upstreamId), eq(upstreamTarget.environment, env));
  let todo = urls;
  if (mode === 'replace') await tx.delete(upstreamTarget).where(where);
  else {
    const have = new Set((await tx.select({ baseUrl: upstreamTarget.baseUrl }).from(upstreamTarget).where(where)).map((t) => t.baseUrl));
    todo = urls.filter((u) => !have.has(u));
  }
  for (const baseUrl of todo) await tx.insert(upstreamTarget).values({ upstreamId, baseUrl, environment: env, createdBy: actor, updatedBy: actor });
  return todo.length;
}

export async function audit(tx: Tx, actor: string, action: string, entityType: string, entityId: string, after: unknown): Promise<void> {
  await tx.insert(auditLog).values({ actorName: actor, action, entityType, entityId, afterJson: JSON.stringify(after) });
}

export interface ImportInput {
  doc: Record<string, unknown>;
  /** 原始內容,計算 file_hash */
  text: string;
  fileName: string;
  target: string;
  /** 上游位址的部署區:test / prod */
  env: 'test' | 'prod';
  actor: string;
  targetMode?: 'replace' | 'add';
  /** 限定只能匯入此上游(自動註冊:API Key 只能註冊自己的服務);route_code 已屬於其他上游時列為錯誤 */
  lockUpstream?: string;
  auditAction?: string;
}

export interface ImportSummary {
  batchId: number;
  upstream: string;
  created: number;
  updated: number;
  unchanged: number;
  createdPermissions: number;
  addedTargets: number;
}

/** 解析與資料庫檢查後的匯入內容(錯誤附加於 spec.errors) */
export interface PreparedImport {
  spec: ParsedSpec;
  policies: Map<string, number>;
  fileHash: string;
  fileName: string;
}

/** 解析 OpenAPI 並做資料庫相關檢查(限流政策、上游 port、限定上游、對外路徑衝突);不寫入 */
export async function prepareOpenApiImport(db: GwDatabase, input: ImportInput): Promise<PreparedImport> {
  const spec: ParsedSpec = parseOpenApi(input.doc);
  const policies = new Map((await db.select().from(rateLimitPolicy)).map((p) => [p.code, p.policyId]));
  for (const r of spec.routes)
    if (r.rateLimitPolicy && !policies.has(r.rateLimitPolicy))
      spec.errors.push({ operation: r.routeCode, message: `x-rate-limit 政策不存在:${r.rateLimitPolicy}` });
  let targetOk = false;
  try {
    targetOk = checkUpstreamPort(input.target);
  } catch {
    // 不是合法的 URL,同 port 不符處理
  }
  if (!targetOk) spec.errors.push({ operation: '(target)', message: `UPSTREAM_PORT_OUT_OF_RANGE:${input.target}` });
  if (input.lockUpstream !== undefined && spec.upstreamCode !== input.lockUpstream)
    spec.errors.push({ operation: '(root)', message: `x-gateway.upstream 必須是 ${input.lockUpstream}(API Key 所屬服務)` });

  const codes = spec.routes.map((r) => r.routeCode);
  const existing = codes.length
    ? await db
        .select({ code: apiRoute.routeCode, upstreamCode: upstream.code })
        .from(apiRoute)
        .leftJoin(upstream, eq(apiRoute.upstreamId, upstream.upstreamId))
        .where(inArray(apiRoute.routeCode, codes))
    : [];
  if (input.lockUpstream !== undefined)
    for (const e of existing)
      if (e.upstreamCode !== spec.upstreamCode) spec.errors.push({ operation: e.code, message: `route_code 已屬於其他上游:${e.upstreamCode ?? '(無)'}` });

  // 對外路徑衝突(對應唯一索引 uq_api_route_method_path_active)
  const paths = [...new Set(spec.routes.map((r) => r.publicPath))];
  const active = paths.length
    ? await db
        .select({ code: apiRoute.routeCode, method: apiRoute.method, path: apiRoute.publicPath })
        .from(apiRoute)
        .where(and(ne(apiRoute.status, 'disabled'), inArray(apiRoute.publicPath, paths)))
    : [];
  for (const r of spec.routes) {
    const hit = active.find((a) => a.method === r.method && a.path === r.publicPath && a.code !== r.routeCode);
    if (hit) spec.errors.push({ operation: r.routeCode, message: `ROUTE_PATH_CONFLICT:對外路徑與既有路由 ${hit.code} 衝突` });
  }
  return { spec, policies, fileHash: createHash('sha256').update(input.text).digest('hex'), fileName: input.fileName.slice(-260) };
}

/** 匯入後的路由欄位(寫入與預覽比對共用) */
function routeValues(r: ParsedSpec['routes'][number], upstreamId: number | null, policies: Map<string, number>) {
  return {
    name: r.name,
    systemCode: r.systemCode,
    method: r.method,
    publicPath: r.publicPath,
    routeType: 'proxy',
    upstreamId,
    upstreamMethod: null,
    upstreamPath: r.upstreamPath,
    authMode: r.authMode,
    permissionCode: r.permissionCode,
    rateLimitPolicyId: r.rateLimitPolicy ? policies.get(r.rateLimitPolicy)! : null,
    cacheTtlSec: r.cacheTtlSec,
    cacheScope: r.cacheScope,
    timeoutMs: r.timeoutMs,
    auditLevel: r.auditLevel,
    tags: r.tags,
    description: r.description,
    gherkin: r.gherkin,
    source: 'openapi',
  };
}

/** 與既有路由比較:create / update / unchanged(修改已停用的路由也算 update) */
export function routeAction(cur: Record<string, unknown> | undefined, values: Record<string, unknown>): 'create' | 'update' | 'unchanged' {
  if (!cur) return 'create';
  return Object.entries(values).some(([k, v]) => cur[k] !== v) || cur.status === 'disabled' ? 'update' : 'unchanged';
}

/** 預覽:每條路由的預定動作(不寫入) */
export async function previewOpenApiImport(db: GwDatabase, prepared: PreparedImport) {
  const { spec, policies } = prepared;
  const [up] = await db.select({ id: upstream.upstreamId }).from(upstream).where(eq(upstream.code, spec.upstreamCode));
  const codes = spec.routes.map((r) => r.routeCode);
  const existing = new Map((codes.length ? await db.select().from(apiRoute).where(inArray(apiRoute.routeCode, codes)) : []).map((r) => [r.routeCode, r]));
  const failed = new Map<string, string[]>();
  for (const e of spec.errors) failed.set(e.operation, [...(failed.get(e.operation) ?? []), e.message]);
  return spec.routes.map((r) => ({
    routeCode: r.routeCode,
    action: failed.has(r.routeCode)
      ? ('error' as const)
      : routeAction(existing.get(r.routeCode) as Record<string, unknown> | undefined, routeValues(r, up?.id ?? null, policies)),
    errors: failed.get(r.routeCode) ?? [],
    route: r,
  }));
}

/** 記錄失敗批次(只寫批次與錯誤項目,不寫路由) */
export async function recordFailedImport(db: GwDatabase, prepared: PreparedImport, actor: string): Promise<number> {
  const { spec } = prepared;
  return db.transaction(async (tx) => {
    const [batch] = await tx.insert(apiImportBatch).output({ id: apiImportBatch.batchId }).values({
      sourceType: 'openapi',
      fileName: prepared.fileName,
      fileHash: prepared.fileHash,
      status: 'failed',
      total: spec.routes.length,
      errors: spec.errors.length,
      createdBy: actor,
      updatedBy: actor,
    });
    for (const [i, e] of spec.errors.entries())
      await tx
        .insert(apiImportItem)
        .values({ batchId: batch!.id, rowNo: i + 1, routeCode: e.operation.slice(0, 100), action: 'error', errorMessage: e.message.slice(0, 1000) });
    return batch!.id;
  });
}

/**
 * 寫入草稿(上游 / 上游位址 / 權限代碼 / 路由 / 匯入批次與逐筆結果 / 稽核,同一交易)。
 * batchId:管理 API 預覽後提交時沿用預覽建立的批次(清除預覽項目,改寫為結果)。
 */
export async function writeOpenApiImport(db: GwDatabase, input: ImportInput, prepared: PreparedImport, batchId?: number): Promise<ImportSummary> {
  const { spec, policies } = prepared;
  return db.transaction(async (tx) => {
    const upstreamId = await upsertUpstream(tx, { code: spec.upstreamCode, systemCode: spec.systemCode, project: spec.project }, input.actor);
    const addedTargets = await setTargets(tx, upstreamId, input.env, [input.target], input.actor, input.targetMode);
    const createdPerms = await ensurePermissions(tx, spec.permissions, input.actor);
    let id = batchId;
    if (id === undefined) {
      const [batch] = await tx.insert(apiImportBatch).output({ id: apiImportBatch.batchId }).values({
        sourceType: 'openapi',
        fileName: prepared.fileName,
        fileHash: prepared.fileHash,
        upstreamId,
        status: 'committed',
        total: spec.routes.length,
        createdBy: input.actor,
        updatedBy: input.actor,
      });
      id = batch!.id;
    } else {
      await tx.delete(apiImportItem).where(eq(apiImportItem.batchId, id));
      await tx
        .update(apiImportBatch)
        .set({ upstreamId, status: 'committed', total: spec.routes.length, errors: 0, updatedBy: input.actor })
        .where(eq(apiImportBatch.batchId, id));
    }
    const counts = { created: 0, updated: 0, unchanged: 0 };
    for (const [i, r] of spec.routes.entries()) {
      const values = routeValues(r, upstreamId, policies);
      const [cur] = await tx.select().from(apiRoute).where(eq(apiRoute.routeCode, r.routeCode));
      const action = routeAction(cur as Record<string, unknown> | undefined, values);
      if (action === 'create') {
        await tx
          .insert(apiRoute)
          .values({ routeCode: r.routeCode, ...values, status: 'draft', importBatchId: id, createdBy: input.actor, updatedBy: input.actor });
      } else if (action === 'update') {
        // 修改已發佈的路由:存為草稿,線上仍使用目前發佈版本(BACKEND-GUIDE §7.3)
        await tx
          .update(apiRoute)
          .set({ ...values, status: 'draft', importBatchId: id, updatedBy: input.actor })
          .where(eq(apiRoute.routeId, cur!.routeId));
      }
      counts[action === 'create' ? 'created' : action === 'update' ? 'updated' : 'unchanged']++;
      await tx.insert(apiImportItem).values({ batchId: id, rowNo: i + 1, routeCode: r.routeCode, action, payload: JSON.stringify(r) });
    }
    await tx.update(apiImportBatch).set({ created: counts.created, updated: counts.updated, skipped: counts.unchanged }).where(eq(apiImportBatch.batchId, id));
    await audit(tx, input.actor, input.auditAction ?? 'route.import', 'api_import_batch', String(id), {
      upstream: spec.upstreamCode,
      target: input.target,
      env: input.env,
      ...counts,
      createdPerms,
    });
    return { batchId: id, upstream: spec.upstreamCode, ...counts, createdPermissions: createdPerms, addedTargets };
  });
}

/** 驗證 → 寫入草稿(CLI import-openapi 與後端自動註冊)。驗證失敗時記錄失敗批次並丟出 ImportError(IMPORT_HAS_ERRORS,details 為錯誤項目) */
export async function importOpenApiDoc(db: GwDatabase, input: ImportInput): Promise<ImportSummary> {
  const prepared = await prepareOpenApiImport(db, input);
  if (prepared.spec.errors.length) {
    await recordFailedImport(db, prepared, input.actor);
    throw new ImportError('IMPORT_HAS_ERRORS', 'IMPORT_HAS_ERRORS:匯入批次含錯誤項目,未寫入任何路由', prepared.spec.errors);
  }
  return writeOpenApiImport(db, input, prepared);
}
