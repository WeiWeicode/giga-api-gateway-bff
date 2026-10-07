/** 通知與 Webhook(DATABASE.md §4;LINE 相關欄位暫緩不建立);公告(NOTIFY-PLAN §6.1) */
import { bigint, bit, datetime2, index, int, nvarchar, primaryKey, smallint, uniqueIndex, varbinary, varchar } from 'drizzle-orm/mssql-core';
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
    /** 公告 Email(NOTIFY-PLAN §6.3):對應 gw.notify_announcement,發布紀錄以此統計寄送進度 */
    announcementId: bigint('announcement_id', { mode: 'number' }),
    queuedAt: datetime2('queued_at', { precision: 3 }).notNull().default(utcNow),
    sentAt: datetime2('sent_at', { precision: 3 }),
  },
  (t) => [
    index('ix_notify_log_queued_at').on(t.queuedAt),
    index('ix_notify_log_recipient').on(t.recipientUserId),
    index('ix_notify_log_idempotency').on(t.idempotencyKey),
    index('ix_notify_log_announcement').on(t.announcementId),
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

/* ---------- 公告(NOTIFY-PLAN §6.1) ---------- */

/** 公告:一則一筆,對象與管道為 JSON 文字(SQL Server 2012 沒有 JSON 函式,比對在應用層) */
export const notifyAnnouncement = gw.table(
  'notify_announcement',
  {
    announcementId: bigint('announcement_id', { mode: 'number' }).identity().primaryKey(),
    title: nvarchar('title', { length: 200 }).notNull(),
    /** 白名單清洗後的 HTML(modules/notify/html.ts) */
    bodyHtml: nvarchar('body_html', { length: 'max' }).notNull(),
    /** 由 HTML 轉出的純文字:Toast、Windows 通知、托盤、關鍵字搜尋 */
    bodyText: nvarchar('body_text', { length: 4000 }).notNull(),
    linkUrl: varchar('link_url', { length: 500 }),
    /** info / important / urgent */
    level: varchar('level', { length: 10 }).notNull(),
    /** 對象 JSON(modules/notify/audience.ts) */
    audience: nvarchar('audience', { length: 4000 }).notNull(),
    /** 管道 JSON 陣列:portal / itapp / agent / email */
    channels: varchar('channels', { length: 100 }).notNull(),
    requireAck: bit('require_ack').notNull().default(false),
    /** 發布(或排程)時間;草稿為 NULL */
    publishAt: datetime2('publish_at', { precision: 3 }),
    /** 到期:不再提醒、不出現在收件匣;NULL = 不到期。公告查詢仍可查到 */
    expireAt: datetime2('expire_at', { precision: 3 }),
    /** draft / scheduled / published / revoked */
    status: varchar('status', { length: 10 }).notNull(),
    publishedBy: nvarchar('published_by', { length: 64 }),
    /** 顯示用發布單位,例「總經理室」 */
    publisherTitle: nvarchar('publisher_title', { length: 100 }),
    /** 發布時對象人數快照(已讀率分母) */
    targetCount: int('target_count'),
    revokedAt: datetime2('revoked_at', { precision: 3 }),
    revokedBy: nvarchar('revoked_by', { length: 64 }),
    idempotencyKey: varchar('idempotency_key', { length: 100 }),
    ...auditColumns(),
  },
  (t) => [index('ix_notify_announcement_status_publish').on(t.status, t.publishAt), index('ix_notify_announcement_created_by').on(t.createdBy)],
);

/** 公告內文圖片(編輯器上傳);announcement_id 為 NULL = 草稿中尚未綁定 */
export const notifyAnnouncementAsset = gw.table(
  'notify_announcement_asset',
  {
    assetId: bigint('asset_id', { mode: 'number' }).identity().primaryKey(),
    announcementId: bigint('announcement_id', { mode: 'number' }).references(() => notifyAnnouncement.announcementId),
    contentType: varchar('content_type', { length: 30 }).notNull(),
    fileName: nvarchar('file_name', { length: 200 }),
    sizeBytes: int('size_bytes').notNull(),
    data: varbinary('data', { length: 'max' }).notNull(),
    createdBy: nvarchar('created_by', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_notify_announcement_asset_announcement').on(t.announcementId)],
);

/** 已讀回條:使用者第一次看到才寫入(不預先展開對象) */
export const notifyReceipt = gw.table(
  'notify_receipt',
  {
    announcementId: bigint('announcement_id', { mode: 'number' })
      .notNull()
      .references(() => notifyAnnouncement.announcementId),
    userId: int('user_id')
      .notNull()
      .references(() => user.userId),
    firstSeenAt: datetime2('first_seen_at', { precision: 3 }).notNull().default(utcNow),
    /** portal / itapp / agent / email */
    seenVia: varchar('seen_via', { length: 10 }),
    readAt: datetime2('read_at', { precision: 3 }),
    ackAt: datetime2('ack_at', { precision: 3 }),
  },
  (t) => [primaryKey({ name: 'pk_notify_receipt', columns: [t.announcementId, t.userId] }), index('ix_notify_receipt_user').on(t.userId)],
);

/** 通知設定(NOTIFY-PLAN §6.9):值為 JSON 文字,鍵見 modules/notify/settings.ts */
export const notifySetting = gw.table('notify_setting', {
  settingKey: varchar('setting_key', { length: 50 }).primaryKey(),
  settingValue: nvarchar('setting_value', { length: 2000 }).notNull(),
  ...auditColumns(),
});

/** 應用間訊息交換:BFF 發出的 Webhook 訂閱(NOTIFY-PLAN §5.2) */
export const notifyWebhookSubscription = gw.table(
  'notify_webhook_subscription',
  {
    subscriptionId: int('subscription_id').identity().primaryKey(),
    appCode: varchar('app_code', { length: 30 }).notNull(),
    /** 事件 JSON 陣列,例 ["announcement.published","announcement.revoked"] */
    events: nvarchar('events', { length: 500 }).notNull(),
    /** internal = 經路由表上游 + X-Internal-Token;external = HMAC 簽章 */
    targetType: varchar('target_type', { length: 10 }).notNull(),
    upstreamCode: varchar('upstream_code', { length: 50 }),
    path: varchar('path', { length: 200 }),
    url: varchar('url', { length: 500 }),
    secretRef: varchar('secret_ref', { length: 100 }),
    isEnabled: bit('is_enabled').notNull().default(true),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_notify_webhook_subscription_app').on(t.appCode)],
);
