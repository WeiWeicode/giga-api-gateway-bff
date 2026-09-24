/** 通知與 Webhook(DATABASE.md §4;LINE 相關欄位暫緩不建立) */
import { bigint, bit, datetime2, index, int, nvarchar, smallint, uniqueIndex, varchar } from 'drizzle-orm/mssql-core';
import { auditColumns, createdAt, gw, utcNow } from './common.js';
import { user } from './identity.js';

export const notifyTemplate = gw.table(
  'notify_template',
  {
    templateId: int('template_id').identity().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    name: nvarchar('name', { length: 100 }).notNull(),
    channels: nvarchar('channels', { length: 200 }).notNull(),
    emailSubject: nvarchar('email_subject', { length: 200 }),
    emailBody: nvarchar('email_body', { length: 'max' }),
    inappBody: nvarchar('inapp_body', { length: 2000 }),
    isEnabled: bit('is_enabled').notNull().default(true),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_notify_template_code').on(t.code)],
);

export const notifyLog = gw.table(
  'notify_log',
  {
    logId: bigint('log_id', { mode: 'number' }).identity().primaryKey(),
    templateCode: varchar('template_code', { length: 50 }),
    channel: varchar('channel', { length: 10 }).notNull(),
    recipientUserId: int('recipient_user_id'),
    recipientAddress: nvarchar('recipient_address', { length: 200 }),
    status: varchar('status', { length: 10 }).notNull(),
    retryCount: smallint('retry_count').notNull().default(0),
    providerMsgId: varchar('provider_msg_id', { length: 200 }),
    errorMessage: nvarchar('error_message', { length: 2000 }),
    idempotencyKey: varchar('idempotency_key', { length: 100 }),
    requestedBy: nvarchar('requested_by', { length: 64 }),
    queuedAt: datetime2('queued_at', { precision: 3 }).notNull().default(utcNow),
    sentAt: datetime2('sent_at', { precision: 3 }),
  },
  (t) => [
    index('ix_notify_log_queued_at').on(t.queuedAt),
    index('ix_notify_log_recipient').on(t.recipientUserId),
    index('ix_notify_log_idempotency').on(t.idempotencyKey),
  ],
);

export const notifyMessage = gw.table(
  'notify_message',
  {
    messageId: bigint('message_id', { mode: 'number' }).identity().primaryKey(),
    userId: int('user_id')
      .notNull()
      .references(() => user.userId),
    title: nvarchar('title', { length: 200 }).notNull(),
    body: nvarchar('body', { length: 2000 }),
    linkUrl: varchar('link_url', { length: 500 }),
    isRead: bit('is_read').notNull().default(false),
    readAt: datetime2('read_at', { precision: 3 }),
    createdAt: createdAt(),
  },
  (t) => [index('ix_notify_message_user_read').on(t.userId, t.isRead, t.createdAt)],
);

export const webhookEndpoint = gw.table(
  'webhook_endpoint',
  {
    endpointId: int('endpoint_id').identity().primaryKey(),
    sourceCode: varchar('source_code', { length: 30 }).notNull(),
    verifyMethod: varchar('verify_method', { length: 20 }).notNull(),
    secretRef: varchar('secret_ref', { length: 100 }),
    signatureHeader: varchar('signature_header', { length: 100 }),
    allowedIps: varchar('allowed_ips', { length: 500 }),
    dispatchType: varchar('dispatch_type', { length: 10 }).notNull(),
    dispatchTarget: varchar('dispatch_target', { length: 200 }),
    isEnabled: bit('is_enabled').notNull().default(true),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_webhook_endpoint_source').on(t.sourceCode)],
);

export const webhookLog = gw.table(
  'webhook_log',
  {
    logId: bigint('log_id', { mode: 'number' }).identity().primaryKey(),
    endpointId: int('endpoint_id').references(() => webhookEndpoint.endpointId),
    requestId: varchar('request_id', { length: 64 }),
    idempotencyKey: varchar('idempotency_key', { length: 100 }),
    remoteIp: varchar('remote_ip', { length: 45 }),
    verified: bit('verified').notNull(),
    statusCode: smallint('status_code'),
    payload: nvarchar('payload', { length: 'max' }),
    receivedAt: datetime2('received_at', { precision: 3 }).notNull().default(utcNow),
    processedAt: datetime2('processed_at', { precision: 3 }),
    errorMessage: nvarchar('error_message', { length: 2000 }),
  },
  (t) => [index('ix_webhook_log_received_at').on(t.receivedAt)],
);
