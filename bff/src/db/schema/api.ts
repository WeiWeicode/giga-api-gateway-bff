/** API 管理(DATABASE.md §2) */
import { sql } from 'drizzle-orm';
import { bit, datetime2, index, int, nvarchar, smallint, tinyint, uniqueIndex, varchar, char } from 'drizzle-orm/mssql-core';
import { auditColumns, createdAt, gw, utcNow } from './common.js';
import { permission } from './identity.js';

export const upstream = gw.table(
  'upstream',
  {
    upstreamId: int('upstream_id').identity().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    name: nvarchar('name', { length: 100 }).notNull(),
    systemCode: varchar('system_code', { length: 30 }).notNull(),
    protocol: varchar('protocol', { length: 10 }).notNull().default('http'),
    lbStrategy: varchar('lb_strategy', { length: 20 }).notNull().default('round_robin'),
    timeoutMs: int('timeout_ms').notNull().default(10000),
    retryCount: tinyint('retry_count').notNull().default(1),
    circuitFailThreshold: smallint('circuit_fail_threshold').notNull().default(10),
    healthCheckPath: varchar('health_check_path', { length: 200 }),
    tlsVerify: bit('tls_verify').notNull().default(true),
    forwardCookies: bit('forward_cookies').notNull().default(false),
    owner: nvarchar('owner', { length: 64 }),
    archatlasNodeId: varchar('archatlas_node_id', { length: 50 }),
    isEnabled: bit('is_enabled').notNull().default(true),
    description: nvarchar('description', { length: 500 }),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_upstream_code').on(t.code)],
);

export const upstreamTarget = gw.table(
  'upstream_target',
  {
    targetId: int('target_id').identity().primaryKey(),
    upstreamId: int('upstream_id')
      .notNull()
      .references(() => upstream.upstreamId),
    baseUrl: varchar('base_url', { length: 300 }).notNull(),
    weight: smallint('weight').notNull().default(1),
    environment: varchar('environment', { length: 10 }).notNull(),
    isEnabled: bit('is_enabled').notNull().default(true),
    ...auditColumns(),
  },
  (t) => [index('ix_upstream_target_upstream').on(t.upstreamId)],
);

export const rateLimitPolicy = gw.table(
  'rate_limit_policy',
  {
    policyId: int('policy_id').identity().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    limitCount: int('limit_count').notNull(),
    windowSec: int('window_sec').notNull(),
    keyBy: varchar('key_by', { length: 20 }).notNull(),
    burst: int('burst'),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_rate_limit_policy_code').on(t.code)],
);

export const apiImportBatch = gw.table('api_import_batch', {
  batchId: int('batch_id').identity().primaryKey(),
  sourceType: varchar('source_type', { length: 10 }).notNull(),
  fileName: nvarchar('file_name', { length: 260 }).notNull(),
  fileHash: char('file_hash', { length: 64 }).notNull(),
  upstreamId: int('upstream_id').references(() => upstream.upstreamId),
  status: varchar('status', { length: 12 }).notNull(),
  total: int('total').notNull().default(0),
  created: int('created').notNull().default(0),
  updated: int('updated').notNull().default(0),
  skipped: int('skipped').notNull().default(0),
  errors: int('errors').notNull().default(0),
  ...auditColumns(),
});

export const apiImportItem = gw.table(
  'api_import_item',
  {
    itemId: int('item_id').identity().primaryKey(),
    batchId: int('batch_id')
      .notNull()
      .references(() => apiImportBatch.batchId),
    rowNo: int('row_no').notNull(),
    routeCode: varchar('route_code', { length: 100 }),
    action: varchar('action', { length: 10 }).notNull(),
    payload: nvarchar('payload', { length: 'max' }),
    errorMessage: nvarchar('error_message', { length: 1000 }),
  },
  (t) => [index('ix_api_import_item_batch').on(t.batchId)],
);

export const apiRoute = gw.table(
  'api_route',
  {
    routeId: int('route_id').identity().primaryKey(),
    routeCode: varchar('route_code', { length: 100 }).notNull(),
    name: nvarchar('name', { length: 100 }).notNull(),
    systemCode: varchar('system_code', { length: 30 }).notNull(),
    method: varchar('method', { length: 10 }).notNull(),
    publicPath: varchar('public_path', { length: 300 }).notNull(),
    routeType: varchar('route_type', { length: 20 }).notNull(),
    upstreamId: int('upstream_id').references(() => upstream.upstreamId),
    upstreamMethod: varchar('upstream_method', { length: 10 }),
    upstreamPath: varchar('upstream_path', { length: 300 }),
    authMode: varchar('auth_mode', { length: 20 }).notNull(),
    permissionCode: varchar('permission_code', { length: 100 }).references(() => permission.code),
    rateLimitPolicyId: int('rate_limit_policy_id').references(() => rateLimitPolicy.policyId),
    cacheTtlSec: int('cache_ttl_sec'),
    cacheScope: varchar('cache_scope', { length: 10 }),
    timeoutMs: int('timeout_ms'),
    maxBodyKb: int('max_body_kb'),
    requestHeadersAdd: nvarchar('request_headers_add', { length: 'max' }),
    responseHeadersRemove: nvarchar('response_headers_remove', { length: 'max' }),
    mockResponse: nvarchar('mock_response', { length: 'max' }),
    auditLevel: varchar('audit_level', { length: 10 }).notNull().default('none'),
    priority: smallint('priority').notNull().default(100),
    status: varchar('status', { length: 12 }).notNull().default('draft'),
    deprecatedAt: datetime2('deprecated_at', { precision: 3 }),
    versionTag: varchar('version_tag', { length: 20 }),
    tags: nvarchar('tags', { length: 200 }),
    owner: nvarchar('owner', { length: 64 }),
    source: varchar('source', { length: 20 }).notNull().default('manual'),
    importBatchId: int('import_batch_id').references(() => apiImportBatch.batchId),
    description: nvarchar('description', { length: 1000 }),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('uq_api_route_code').on(t.routeCode),
    uniqueIndex('uq_api_route_method_path_active')
      .on(t.method, t.publicPath)
      .where(sql`[status] <> 'disabled'`),
    index('ix_api_route_system_status').on(t.systemCode, t.status),
    index('ix_api_route_upstream').on(t.upstreamId),
    index('ix_api_route_permission').on(t.permissionCode),
  ],
);

export const aggregateStep = gw.table(
  'aggregate_step',
  {
    stepId: int('step_id').identity().primaryKey(),
    routeId: int('route_id')
      .notNull()
      .references(() => apiRoute.routeId),
    stepKey: varchar('step_key', { length: 50 }).notNull(),
    stepOrder: smallint('step_order').notNull(),
    upstreamId: int('upstream_id')
      .notNull()
      .references(() => upstream.upstreamId),
    method: varchar('method', { length: 10 }).notNull(),
    pathTemplate: varchar('path_template', { length: 300 }).notNull(),
    required: bit('required').notNull().default(false),
    timeoutMs: int('timeout_ms').notNull().default(5000),
    permissionCode: varchar('permission_code', { length: 100 }).references(() => permission.code),
    transform: nvarchar('transform', { length: 'max' }),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_aggregate_step_route_key').on(t.routeId, t.stepKey)],
);

export const configRelease = gw.table('config_release', {
  releaseId: int('release_id').identity().primaryKey(),
  snapshot: nvarchar('snapshot', { length: 'max' }).notNull(),
  diffSummary: nvarchar('diff_summary', { length: 'max' }),
  note: nvarchar('note', { length: 500 }),
  publishedBy: nvarchar('published_by', { length: 64 }).notNull(),
  publishedAt: datetime2('published_at', { precision: 3 }).notNull().default(utcNow),
  rolledBackFrom: int('rolled_back_from'),
  createdAt: createdAt(),
});
