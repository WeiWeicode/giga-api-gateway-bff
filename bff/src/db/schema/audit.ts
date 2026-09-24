/**
 * 稽核與同步紀錄(DATABASE.md §5、§8.5)
 *
 * audit_log / auth_log / api_access_log:
 *   - 主鍵為 NONCLUSTERED,叢集索引建在 occurred_at(Standard 版無分割,以排程分批刪除)。
 *     Drizzle 無法表達叢集設定,由 migration 手動調整(見 db/migrations 審查紀錄)。
 *   - gw_app_role 只有 INSERT / SELECT(migration 內 DENY UPDATE, DELETE)。
 */
import { bigint, datetime2, index, int, nvarchar, smallint, varchar } from 'drizzle-orm/mssql-core';
import { gw, utcNow } from './common.js';

export const auditLog = gw.table(
  'audit_log',
  {
    auditId: bigint('audit_id', { mode: 'number' }).identity().primaryKey(),
    occurredAt: datetime2('occurred_at', { precision: 3 }).notNull().default(utcNow),
    actorUserId: int('actor_user_id'),
    actorName: nvarchar('actor_name', { length: 100 }),
    actorIp: varchar('actor_ip', { length: 45 }),
    action: varchar('action', { length: 60 }).notNull(),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: varchar('entity_id', { length: 100 }),
    beforeJson: nvarchar('before_json', { length: 'max' }),
    afterJson: nvarchar('after_json', { length: 'max' }),
    requestId: varchar('request_id', { length: 64 }),
  },
  (t) => [index('ix_audit_log_occurred_at').on(t.occurredAt), index('ix_audit_log_entity').on(t.entityType, t.entityId)],
);

export const authLog = gw.table(
  'auth_log',
  {
    logId: bigint('log_id', { mode: 'number' }).identity().primaryKey(),
    occurredAt: datetime2('occurred_at', { precision: 3 }).notNull().default(utcNow),
    username: nvarchar('username', { length: 128 }).notNull(),
    userId: int('user_id'),
    authMethod: varchar('auth_method', { length: 10 }),
    event: varchar('event', { length: 30 }).notNull(),
    reason: nvarchar('reason', { length: 200 }),
    ip: varchar('ip', { length: 45 }),
    userAgent: nvarchar('user_agent', { length: 400 }),
  },
  (t) => [index('ix_auth_log_occurred_at').on(t.occurredAt), index('ix_auth_log_user').on(t.userId, t.occurredAt)],
);

export const apiAccessLog = gw.table(
  'api_access_log',
  {
    logId: bigint('log_id', { mode: 'number' }).identity().primaryKey(),
    occurredAt: datetime2('occurred_at', { precision: 3 }).notNull().default(utcNow),
    requestId: varchar('request_id', { length: 64 }),
    routeCode: varchar('route_code', { length: 100 }),
    userId: int('user_id'),
    clientId: int('client_id'),
    method: varchar('method', { length: 10 }).notNull(),
    path: nvarchar('path', { length: 1000 }).notNull(),
    status: smallint('status').notNull(),
    durationMs: int('duration_ms').notNull(),
    body: nvarchar('body', { length: 'max' }),
  },
  (t) => [index('ix_api_access_log_occurred_at').on(t.occurredAt)],
);

export const employeeSyncRun = gw.table('employee_sync_run', {
  runId: int('run_id').identity().primaryKey(),
  triggerType: varchar('trigger_type', { length: 10 }).notNull(),
  startedAt: datetime2('started_at', { precision: 3 }).notNull().default(utcNow),
  finishedAt: datetime2('finished_at', { precision: 3 }),
  status: varchar('status', { length: 12 }).notNull(),
  bpmRows: int('bpm_rows'),
  losRows: int('los_rows'),
  created: int('created').notNull().default(0),
  updated: int('updated').notNull().default(0),
  unchanged: int('unchanged').notNull().default(0),
  resignedFlagged: int('resigned_flagged').notNull().default(0),
  errorMessage: nvarchar('error_message', { length: 2000 }),
  triggeredBy: nvarchar('triggered_by', { length: 64 }),
});
