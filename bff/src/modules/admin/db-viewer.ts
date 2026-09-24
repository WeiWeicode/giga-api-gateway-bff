/**
 * 資料庫檢視(demo,唯讀):供 IT 管理介面範例瀏覽 giganexus_gw 各資料表。
 * 不是 PRD §8.7 的正式管理 API;只在 dev / test 註冊(app.ts),正式區不提供。
 *
 *   GET /api/admin/db/tables                        可檢視的資料表與筆數(只列出目前使用者有權限者)
 *   GET /api/admin/db/tables/:table?page&pageSize   分頁資料(BACKEND-GUIDE §5.2:page 從 1 開始、pageSize 上限 100)
 *
 * 每張表對應既有的 gw.admin.*.read 權限;密碼、Token、API Key 雜湊等欄位一律不回傳。
 */
import { desc, is, sql } from 'drizzle-orm';
import { getTableConfig, MsSqlTable, type MsSqlColumn } from 'drizzle-orm/mssql-core';
import type { FastifyPluginAsync } from 'fastify';
import * as schema from '../../db/schema/index.js';
import { GwError } from '../../errors.js';

/** 資料表 → 檢視所需權限(PRD §8.7) */
const TABLE_PERMISSIONS: Record<string, string> = {
  upstream: 'gw.admin.upstream.read',
  upstream_target: 'gw.admin.upstream.read',
  api_route: 'gw.admin.route.read',
  aggregate_step: 'gw.admin.route.read',
  rate_limit_policy: 'gw.admin.route.read',
  config_release: 'gw.admin.route.read',
  api_import_batch: 'gw.admin.route.read',
  api_import_item: 'gw.admin.route.read',
  role: 'gw.admin.rbac.read',
  permission: 'gw.admin.rbac.read',
  role_permission: 'gw.admin.rbac.read',
  role_ad_group: 'gw.admin.rbac.read',
  role_company: 'gw.admin.rbac.read',
  user_role: 'gw.admin.rbac.read',
  user: 'gw.admin.user.read',
  user_company: 'gw.admin.user.read',
  employee_sync_run: 'gw.admin.user.read',
  company: 'gw.admin.company.read',
  company_ad_domain: 'gw.admin.company.read',
  local_credential: 'gw.admin.local.read',
  local_account_token: 'gw.admin.local.read',
  api_client: 'gw.admin.client.read',
  api_client_permission: 'gw.admin.client.read',
  notify_template: 'gw.admin.notify.read',
  notify_log: 'gw.admin.notify.read',
  notify_message: 'gw.admin.notify.read',
  webhook_endpoint: 'gw.admin.notify.read',
  webhook_log: 'gw.admin.notify.read',
  audit_log: 'gw.admin.audit.read',
  auth_log: 'gw.admin.audit.read',
  api_access_log: 'gw.admin.audit.read',
};

/** 不回傳的欄位(雜湊與密碼歷史) */
const HIDDEN_COLUMNS = new Set(['password_hash', 'password_history', 'token_hash', 'key_hash']);

interface TableInfo {
  name: string;
  table: MsSqlTable;
  columns: MsSqlColumn[];
  orderBy: MsSqlColumn;
  permission: string;
}

const TABLES = new Map<string, TableInfo>();
for (const value of Object.values(schema)) {
  if (!is(value, MsSqlTable)) continue;
  const cfg = getTableConfig(value);
  const permission = TABLE_PERMISSIONS[cfg.name];
  if (!permission) continue;
  const columns = cfg.columns.filter((c) => !HIDDEN_COLUMNS.has(c.name));
  // 依主鍵(或第一個欄位)由新到舊排序
  const orderBy = cfg.columns.find((c) => c.primary) ?? cfg.primaryKeys[0]?.columns[0] ?? cfg.columns[0]!;
  TABLES.set(cfg.name, { name: cfg.name, table: value, columns, orderBy, permission });
}

/** ROWVERSION 等二進位欄位以 hex 表示 */
function serialize(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('hex') : v]));
}

const dbViewer: FastifyPluginAsync = async (app) => {
  app.get('/api/admin/db/tables', async (req) => {
    const p = await req.requirePrincipal();
    const perms = new Set(await app.perms.list(p.userId, p.claims.pv));
    const visible = [...TABLES.values()].filter((t) => perms.has(t.permission));
    if (!visible.length) throw new GwError('PERMISSION_DENIED');
    const items = await Promise.all(
      visible.map(async (t) => {
        const [r] = await app.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(t.table);
        return { name: t.name, rows: r?.n ?? 0, permission: t.permission };
      }),
    );
    return { items: items.sort((a, b) => a.name.localeCompare(b.name)) };
  });

  app.get<{ Params: { table: string }; Querystring: { page?: number; pageSize?: number } }>(
    '/api/admin/db/tables/:table',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        },
      },
    },
    async (req) => {
      const p = await req.requirePrincipal();
      const t = TABLES.get(req.params.table);
      if (!t) throw new GwError('ROUTE_NOT_FOUND', '找不到此資料表');
      if (!(await app.perms.has(p.userId, p.claims.pv, t.permission))) throw new GwError('PERMISSION_DENIED');

      const page = req.query.page ?? 1;
      const pageSize = req.query.pageSize ?? 20;
      const selection = Object.fromEntries(t.columns.map((c) => [c.name, c]));
      const [rows, [count]] = await Promise.all([
        app.db
          .select(selection)
          .from(t.table)
          .orderBy(desc(t.orderBy))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
        app.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(t.table),
      ]);
      return {
        table: t.name,
        columns: t.columns.map((c) => c.name),
        items: rows.map((r) => serialize(r as Record<string, unknown>)),
        total: count?.n ?? 0,
        page,
        pageSize,
      };
    },
  );
};

export default dbViewer;
