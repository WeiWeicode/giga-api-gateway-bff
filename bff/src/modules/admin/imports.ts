/**
 * API 匯入(PRD §8.4.4、§8.7、P2-4):權限 gw.admin.route.import。上傳 → 解析 → 驗證 → 預覽 → 確認寫入草稿 → (另行)發佈。
 *
 *   POST /api/admin/imports                       上傳(multipart:file;OpenAPI 另需 target = 本區上游位址;選填 createPermissions)
 *                                                 → 寫入批次(status = preview,有錯誤為 failed)與逐筆預覽,不寫路由
 *   GET  /api/admin/imports                       匯入批次清單(新到舊)
 *   GET  /api/admin/imports/:id                   批次、逐筆預覽或結果
 *   POST /api/admin/imports/:id/commit            以目前資料庫重新驗證後寫入草稿;仍有錯誤回 400 IMPORT_HAS_ERRORS
 *   GET  /api/admin/imports/template?format=      表格範本(xlsx / csv)
 *
 * 來源依副檔名判斷:.json / .yaml / .yml = OpenAPI(與 CLI import-openapi、後端自動註冊同一套規則,route-import.ts);
 * .xlsx = Excel、.csv = CSV(欄位見 route-table.ts)。表格的權限代碼不存在時,createPermissions = true 才一併建立。
 * 預覽內容存於 gw.api_import_item(row_no = 0、action = meta 為原始內容),提交時重新驗證,避免預覽後資料已變動。
 */
import { createHash } from 'node:crypto';
import multipart from '@fastify/multipart';
import ExcelJS from 'exceljs';
import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from '../../config.js';
import { apiImportBatch, apiImportItem, apiRoute, permission, rateLimitPolicy, upstream } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { createAuthorizer, type Actor } from './authorize.js';
import { audit, permParts, prepareOpenApiImport, previewOpenApiImport, routeAction, writeOpenApiImport, type ImportInput, type Tx } from './route-import.js';
import { csvTemplate, parseCsv, parseRouteTable, TABLE_COLUMNS, TEMPLATE_EXAMPLE, type RowError, type TableRoute } from './route-table.js';

const PERM = 'gw.admin.route.import';
const MAX_FILE = 5 * 1024 * 1024;

type SourceType = 'openapi' | 'excel' | 'csv';
type Meta =
  | { kind: 'openapi'; target: string; doc: Record<string, unknown>; createPermissions: boolean }
  | { kind: 'table'; routes: TableRoute[]; parseErrors: RowError[]; createPermissions: boolean };

interface PreviewItem {
  rowNo: number;
  routeCode: string | null;
  action: 'create' | 'update' | 'unchanged' | 'error';
  errors: string[];
  payload: unknown;
}

function sourceOf(fileName: string): SourceType | null {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'json' || ext === 'yaml' || ext === 'yml') return 'openapi';
  if (ext === 'xlsx') return 'excel';
  if (ext === 'csv') return 'csv';
  return null;
}

async function readExcel(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const width = ws.getRow(1).cellCount;
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    for (let i = 1; i <= width; i++) cells.push(row.getCell(i).text ?? '');
    rows.push(cells);
  });
  return rows;
}

async function excelTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('routes');
  ws.addRow(TABLE_COLUMNS.map((c) => c.key));
  ws.addRow(TABLE_COLUMNS.map((c) => TEMPLATE_EXAMPLE[c.key]));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((col) => (col.width = 22));
  const help = wb.addWorksheet('說明');
  help.addRow(['欄位', '必填', '說明']).font = { bold: true };
  for (const c of TABLE_COLUMNS) help.addRow([c.key, c.required ? '是' : '', c.note]);
  help.getColumn(1).width = 22;
  help.getColumn(3).width = 80;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const tableValues = (r: TableRoute, upstreamId: number | null, policyId: number | null, source: string) => ({
  name: r.name,
  systemCode: r.systemCode,
  method: r.method,
  publicPath: r.publicPath,
  routeType: r.routeType,
  upstreamId: r.routeType === 'proxy' ? upstreamId : null,
  upstreamMethod: r.upstreamMethod,
  upstreamPath: r.upstreamPath,
  authMode: r.authMode,
  permissionCode: r.permissionCode,
  rateLimitPolicyId: policyId,
  cacheTtlSec: r.cacheTtlSec,
  cacheScope: r.cacheScope,
  timeoutMs: r.timeoutMs,
  maxBodyKb: r.maxBodyKb,
  auditLevel: r.auditLevel,
  tags: r.tags,
  owner: r.owner,
  description: r.description,
  mockResponse: r.mockResponse ? JSON.stringify(JSON.parse(r.mockResponse)) : null,
  source,
});

const importsAdmin: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  const authorize = createAuthorizer(app);
  const env = config.gwEnv === 'prod' ? 'prod' : 'test';
  await app.register(multipart, { limits: { fileSize: MAX_FILE, files: 1, fields: 10 } });

  /** 表格匯入的資料庫檢查:上游、權限、限流政策、路徑衝突 */
  async function checkTable(routes: TableRoute[], createPermissions: boolean) {
    const errors: RowError[] = [];
    const ups = new Map(
      (await app.db.select({ id: upstream.upstreamId, code: upstream.code, isEnabled: upstream.isEnabled }).from(upstream)).map((u) => [u.code, u]),
    );
    const policies = new Map(
      (await app.db.select({ id: rateLimitPolicy.policyId, code: rateLimitPolicy.code }).from(rateLimitPolicy)).map((p) => [p.code, p.id]),
    );
    const permCodes = [...new Set(routes.map((r) => r.permissionCode).filter((c): c is string => !!c))];
    const existingPerms = new Set(
      permCodes.length ? (await app.db.select({ code: permission.code }).from(permission).where(inArray(permission.code, permCodes))).map((p) => p.code) : [],
    );
    const paths = [...new Set(routes.map((r) => r.publicPath))];
    const active = paths.length
      ? await app.db
          .select({ code: apiRoute.routeCode, method: apiRoute.method, path: apiRoute.publicPath })
          .from(apiRoute)
          .where(and(ne(apiRoute.status, 'disabled'), inArray(apiRoute.publicPath, paths)))
      : [];
    const missingPerms = new Map<string, string>();
    for (const r of routes) {
      const err = (field: string, message: string) => errors.push({ rowNo: r.rowNo, routeCode: r.routeCode, field, message });
      if (r.routeType === 'proxy') {
        const u = r.upstream ? ups.get(r.upstream) : undefined;
        if (!u) err('upstream', `上游不存在:${r.upstream ?? ''}`);
        else if (!u.isEnabled) err('upstream', `上游已停用:${r.upstream}`);
      }
      if (r.rateLimitPolicy && !policies.has(r.rateLimitPolicy)) err('rate_limit_policy', `限流政策不存在:${r.rateLimitPolicy}`);
      if (r.permissionCode && !existingPerms.has(r.permissionCode)) {
        if (createPermissions) missingPerms.set(r.permissionCode, r.permissionName ?? r.name);
        else err('permission_code', `權限代碼不存在:${r.permissionCode}(可勾選「一併建立」)`);
      }
      const hit = active.find((a) => a.method === r.method && a.path === r.publicPath && a.code !== r.routeCode);
      if (hit) err('public_path', `ROUTE_PATH_CONFLICT:對外路徑與既有路由 ${hit.code} 衝突`);
    }
    return { errors, ups, policies, missingPerms };
  }

  async function existingRoutes(codes: string[]) {
    return new Map((codes.length ? await app.db.select().from(apiRoute).where(inArray(apiRoute.routeCode, codes)) : []).map((r) => [r.routeCode, r]));
  }

  /** 依 meta 驗證並產生逐筆預覽;batchErrors 為不屬於單一路由的錯誤 */
  async function evaluate(meta: Meta, sourceType: SourceType, fileName: string, text: string, actor: string) {
    if (meta.kind === 'openapi') {
      const input: ImportInput = { doc: meta.doc, text, fileName, target: meta.target, env, actor };
      const prepared = await prepareOpenApiImport(app.db, input);
      const preview = await previewOpenApiImport(app.db, prepared);
      const codes = new Set(prepared.spec.routes.map((r) => r.routeCode));
      const items: PreviewItem[] = preview.map((p, i) => ({ rowNo: i + 1, routeCode: p.routeCode, action: p.action, errors: p.errors, payload: p.route }));
      const batchErrors = prepared.spec.errors.filter((e) => !codes.has(e.operation)).map((e) => `${e.operation}:${e.message}`);
      return { items, batchErrors, hasErrors: prepared.spec.errors.length > 0, input, prepared };
    }
    const { errors, ups, policies } = await checkTable(meta.routes, meta.createPermissions);
    const all = [...meta.parseErrors, ...errors];
    const existing = await existingRoutes(meta.routes.map((r) => r.routeCode));
    const items: PreviewItem[] = meta.routes.map((r) => {
      const errs = errors.filter((e) => e.rowNo === r.rowNo).map((e) => `${e.field}:${e.message}`);
      const values = tableValues(r, ups.get(r.upstream ?? '')?.id ?? null, r.rateLimitPolicy ? (policies.get(r.rateLimitPolicy) ?? null) : null, sourceType);
      return {
        rowNo: r.rowNo,
        routeCode: r.routeCode,
        action: errs.length ? 'error' : routeAction(existing.get(r.routeCode) as Record<string, unknown> | undefined, values),
        errors: errs,
        payload: r,
      };
    });
    // 欄位檢查未通過的列不在 routes 中,另列為錯誤項目;第 1 列(欄位名稱)的錯誤屬於整批
    const unparsed = new Map<number, PreviewItem>();
    const batchErrors: string[] = [];
    for (const e of meta.parseErrors) {
      if (e.rowNo === 1) {
        batchErrors.push(`${e.field}:${e.message}`);
        continue;
      }
      const it = unparsed.get(e.rowNo) ?? { rowNo: e.rowNo, routeCode: e.routeCode, action: 'error' as const, errors: [], payload: null };
      it.errors.push(`${e.field}:${e.message}`);
      unparsed.set(e.rowNo, it);
    }
    items.push(...unparsed.values());
    items.sort((a, b) => a.rowNo - b.rowNo);
    return { items, batchErrors, hasErrors: all.length > 0, input: null, prepared: null };
  }

  const summaryOf = (items: PreviewItem[]) => ({
    total: items.length,
    create: items.filter((i) => i.action === 'create').length,
    update: items.filter((i) => i.action === 'update').length,
    unchanged: items.filter((i) => i.action === 'unchanged').length,
    error: items.filter((i) => i.action === 'error').length,
  });

  async function loadBatch(id: number) {
    const [batch] = await app.db.select().from(apiImportBatch).where(eq(apiImportBatch.batchId, id));
    if (!batch) throw new GwError('VALIDATION_FAILED', '匯入批次不存在', [{ field: 'id', message: String(id) }]);
    const items = await app.db.select().from(apiImportItem).where(eq(apiImportItem.batchId, id)).orderBy(asc(apiImportItem.rowNo));
    return { batch, items };
  }

  function batchOut(batch: typeof apiImportBatch.$inferSelect, items: (typeof apiImportItem.$inferSelect)[]) {
    const { rowVer: _r, ...b } = batch;
    const meta = items.find((i) => i.action === 'meta');
    const parsedMeta = meta?.payload ? (JSON.parse(meta.payload) as Meta) : null;
    return {
      ...b,
      target: parsedMeta?.kind === 'openapi' ? parsedMeta.target : null,
      createPermissions: parsedMeta?.createPermissions ?? false,
      errorsSummary: meta?.errorMessage ? (JSON.parse(meta.errorMessage) as string[]) : [],
      items: items
        .filter((i) => i.action !== 'meta')
        .map((i) => ({
          rowNo: i.rowNo,
          routeCode: i.routeCode,
          action: i.action,
          errors: i.errorMessage ? i.errorMessage.split('\n') : [],
          payload: i.payload ? (JSON.parse(i.payload) as unknown) : null,
        })),
    };
  }

  app.get<{ Querystring: { format?: string } }>(
    '/api/admin/imports/template',
    { schema: { querystring: { type: 'object', properties: { format: { type: 'string', enum: ['xlsx', 'csv'], default: 'xlsx' } } } } },
    async (req, reply) => {
      await authorize(req, PERM);
      if (req.query.format === 'csv')
        return reply.type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="gateway-routes-template.csv"').send(csvTemplate());
      return reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', 'attachment; filename="gateway-routes-template.xlsx"')
        .send(await excelTemplate());
    },
  );

  app.post('/api/admin/imports', async (req, reply) => {
    const actor = await authorize(req, PERM);
    if (!req.isMultipart()) throw new GwError('VALIDATION_FAILED', '需以 multipart/form-data 上傳檔案(欄位 file)');
    let file: { name: string; buf: Buffer } | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          if (part.fieldname === 'file') file = { name: part.filename, buf };
        } else fields[part.fieldname] = String(part.value ?? '');
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new GwError('PAYLOAD_TOO_LARGE', `檔案超過 ${MAX_FILE / 1024 / 1024} MB`);
      throw err;
    }
    if (!file) throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'file', message: '必填' }]);
    const sourceType = sourceOf(file.name);
    if (!sourceType) throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'file', message: '只接受 .json / .yaml / .yml(OpenAPI)、.xlsx、.csv' }]);
    const createPermissions = ['1', 'true'].includes((fields.createPermissions ?? '').toLowerCase());
    const text = sourceType === 'excel' ? file.buf.toString('base64') : file.buf.toString('utf8');

    let meta: Meta;
    if (sourceType === 'openapi') {
      const target = fields.target?.trim();
      if (!target)
        throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'target', message: 'OpenAPI 匯入需指定本區上游位址(例 http://10.10.130.124:51291)' }]);
      let doc: unknown;
      try {
        doc = file.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseYaml(text);
      } catch (err) {
        throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'file', message: `無法解析:${(err as Error).message}` }]);
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc))
        throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'file', message: '不是 OpenAPI 文件' }]);
      meta = { kind: 'openapi', target, doc: doc as Record<string, unknown>, createPermissions };
    } else {
      let rows: string[][];
      try {
        rows = sourceType === 'excel' ? await readExcel(file.buf) : parseCsv(text);
      } catch (err) {
        throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'file', message: `無法讀取:${(err as Error).message}` }]);
      }
      const parsed = parseRouteTable(rows, config.gwEnv);
      meta = { kind: 'table', routes: parsed.routes, parseErrors: parsed.errors, createPermissions };
    }

    const fileName = file.name.slice(-260);
    const ev = await evaluate(meta, sourceType, fileName, text, actor.name.slice(0, 64));
    const status = ev.hasErrors ? 'failed' : 'preview';
    const summary = summaryOf(ev.items);
    const batchId = await app.db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(apiImportBatch)
        .output({ id: apiImportBatch.batchId })
        .values({
          sourceType,
          fileName,
          fileHash: createHash('sha256').update(file.buf).digest('hex'),
          status,
          total: summary.total,
          errors: summary.error + ev.batchErrors.length,
          createdBy: actor.name.slice(0, 64),
          updatedBy: actor.name.slice(0, 64),
        });
      await tx.insert(apiImportItem).values({
        batchId: batch!.id,
        rowNo: 0,
        action: 'meta',
        payload: JSON.stringify(meta),
        errorMessage: ev.batchErrors.length ? JSON.stringify(ev.batchErrors).slice(0, 1000) : null,
      });
      for (const it of ev.items)
        await tx.insert(apiImportItem).values({
          batchId: batch!.id,
          rowNo: it.rowNo,
          routeCode: it.routeCode?.slice(0, 100) ?? null,
          action: it.action,
          payload: it.payload === null ? null : JSON.stringify(it.payload),
          errorMessage: it.errors.length ? it.errors.join('\n').slice(0, 1000) : null,
        });
      await audit(tx, actor.name, 'route.import.preview', 'api_import_batch', String(batch!.id), { sourceType, fileName, status, ...summary });
      return batch!.id;
    });
    const { batch, items } = await loadBatch(batchId);
    return reply.code(201).send({ ...batchOut(batch, items), summary, canCommit: status === 'preview' });
  });

  app.get<{ Querystring: { page?: number; pageSize?: number } }>(
    '/api/admin/imports',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        },
      },
    },
    async (req) => {
      await authorize(req, PERM);
      const { page = 1, pageSize = 50 } = req.query;
      const [[total], rows] = await Promise.all([
        app.db.select({ n: count() }).from(apiImportBatch),
        app.db
          .select()
          .from(apiImportBatch)
          .orderBy(desc(apiImportBatch.batchId))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
      ]);
      return { total: total?.n ?? 0, page, pageSize, items: rows.map(({ rowVer: _r, ...b }) => b) };
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/admin/imports/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } } },
    async (req) => {
      await authorize(req, PERM);
      const { batch, items } = await loadBatch(req.params.id);
      return batchOut(batch, items);
    },
  );

  /** 表格匯入寫入草稿(同一交易:權限一併建立、路由、逐筆結果、批次、稽核) */
  async function commitTable(tx: Tx, batchId: number, meta: Extract<Meta, { kind: 'table' }>, sourceType: string, actor: Actor) {
    const by = actor.name.slice(0, 64);
    const { ups, policies, missingPerms } = await checkTable(meta.routes, meta.createPermissions);
    for (const [code, name] of missingPerms)
      await tx.insert(permission).values({ code, name: name.slice(0, 100), ...permParts(code), createdBy: by, updatedBy: by });
    await tx.delete(apiImportItem).where(and(eq(apiImportItem.batchId, batchId), ne(apiImportItem.action, 'meta')));
    const counts = { created: 0, updated: 0, unchanged: 0 };
    for (const r of meta.routes) {
      const values = tableValues(r, ups.get(r.upstream ?? '')?.id ?? null, r.rateLimitPolicy ? (policies.get(r.rateLimitPolicy) ?? null) : null, sourceType);
      const [cur] = await tx.select().from(apiRoute).where(eq(apiRoute.routeCode, r.routeCode));
      const action = routeAction(cur as Record<string, unknown> | undefined, values);
      if (action === 'create')
        await tx.insert(apiRoute).values({ routeCode: r.routeCode, ...values, status: 'draft', importBatchId: batchId, createdBy: by, updatedBy: by });
      else if (action === 'update')
        await tx
          .update(apiRoute)
          .set({ ...values, status: 'draft', importBatchId: batchId, updatedBy: by })
          .where(eq(apiRoute.routeId, cur!.routeId));
      counts[action === 'create' ? 'created' : action === 'update' ? 'updated' : 'unchanged']++;
      await tx.insert(apiImportItem).values({ batchId, rowNo: r.rowNo, routeCode: r.routeCode, action, payload: JSON.stringify(r) });
    }
    await tx
      .update(apiImportBatch)
      .set({ status: 'committed', created: counts.created, updated: counts.updated, skipped: counts.unchanged, errors: 0, updatedBy: by })
      .where(eq(apiImportBatch.batchId, batchId));
    await audit(tx, actor.name, 'route.import', 'api_import_batch', String(batchId), { sourceType, ...counts, createdPerms: [...missingPerms.keys()] });
    return { ...counts, createdPermissions: missingPerms.size };
  }

  app.post<{ Params: { id: number }; Body: { createPermissions?: boolean } }>(
    '/api/admin/imports/:id/commit',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
        body: { type: ['object', 'null'], additionalProperties: false, properties: { createPermissions: { type: 'boolean' } } },
      },
    },
    async (req) => {
      const actor = await authorize(req, PERM);
      const { batch, items } = await loadBatch(req.params.id);
      if (batch.status !== 'preview')
        throw new GwError('VALIDATION_FAILED', batch.status === 'committed' ? '此批次已提交' : '此批次含錯誤,請修正檔案後重新上傳', [
          { field: 'status', message: batch.status },
        ]);
      const metaRow = items.find((i) => i.action === 'meta');
      if (!metaRow?.payload) throw new GwError('VALIDATION_FAILED', '批次缺少原始內容,請重新上傳');
      const meta = JSON.parse(metaRow.payload) as Meta;
      if (req.body?.createPermissions !== undefined) meta.createPermissions = req.body.createPermissions;

      // 重新驗證:預覽之後資料庫可能已變動(路徑衝突、上游停用…)
      const ev = await evaluate(
        meta,
        batch.sourceType as SourceType,
        batch.fileName,
        meta.kind === 'openapi' ? JSON.stringify(meta.doc) : '',
        actor.name.slice(0, 64),
      );
      if (ev.hasErrors)
        throw new GwError('IMPORT_HAS_ERRORS', undefined, [
          ...ev.batchErrors.map((message) => ({ field: '(batch)', message })),
          ...ev.items
            .filter((i) => i.errors.length)
            .flatMap((i) => i.errors.map((message) => ({ field: `row ${i.rowNo} ${i.routeCode ?? ''}`.trim(), message }))),
        ]);

      if (meta.kind === 'openapi') {
        const r = await writeOpenApiImport(app.db, { ...ev.input!, auditAction: 'route.import' }, ev.prepared!, batch.batchId);
        return { ...r, status: 'committed' };
      }
      const r = await app.db.transaction((tx) => commitTable(tx, batch.batchId, meta, batch.sourceType, actor));
      return { batchId: batch.batchId, status: 'committed', ...r };
    },
  );
};

export default importsAdmin;
