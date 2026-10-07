CREATE TABLE [gw].[notify_announcement] (
	[announcement_id] bigint IDENTITY(1, 1),
	[title] nvarchar(200) NOT NULL,
	[body_html] nvarchar(max) NOT NULL,
	[body_text] nvarchar(4000) NOT NULL,
	[link_url] varchar(500),
	[level] varchar(10) NOT NULL,
	[audience] nvarchar(4000) NOT NULL,
	[channels] varchar(100) NOT NULL,
	[require_ack] bit NOT NULL CONSTRAINT [notify_announcement_require_ack_default] DEFAULT ((0)),
	[publish_at] datetime2(3),
	[expire_at] datetime2(3),
	[status] varchar(10) NOT NULL,
	[published_by] nvarchar(64),
	[publisher_title] nvarchar(100),
	[target_count] int,
	[revoked_at] datetime2(3),
	[revoked_by] nvarchar(64),
	[idempotency_key] varchar(100),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [notify_announcement_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [notify_announcement_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [notify_announcement_pkey] PRIMARY KEY([announcement_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[notify_announcement_asset] (
	[asset_id] bigint IDENTITY(1, 1),
	[announcement_id] bigint,
	[content_type] varchar(30) NOT NULL,
	[file_name] nvarchar(200),
	[size_bytes] int NOT NULL,
	[data] varbinary(max) NOT NULL,
	[created_by] nvarchar(64) NOT NULL,
	[created_at] datetime2(3) NOT NULL CONSTRAINT [notify_announcement_asset_created_at_default] DEFAULT (sysutcdatetime()),
	CONSTRAINT [notify_announcement_asset_pkey] PRIMARY KEY([asset_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[notify_receipt] (
	[announcement_id] bigint,
	[user_id] int,
	[first_seen_at] datetime2(3) NOT NULL CONSTRAINT [notify_receipt_first_seen_at_default] DEFAULT (sysutcdatetime()),
	[seen_via] varchar(10),
	[read_at] datetime2(3),
	[ack_at] datetime2(3),
	CONSTRAINT [pk_notify_receipt] PRIMARY KEY([announcement_id],[user_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[notify_setting] (
	[setting_key] varchar(50),
	[setting_value] nvarchar(2000) NOT NULL,
	[created_at] datetime2(3) NOT NULL CONSTRAINT [notify_setting_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [notify_setting_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [notify_setting_pkey] PRIMARY KEY([setting_key])
);
--> statement-breakpoint
CREATE TABLE [gw].[notify_webhook_subscription] (
	[subscription_id] int IDENTITY(1, 1),
	[app_code] varchar(30) NOT NULL,
	[events] nvarchar(500) NOT NULL,
	[target_type] varchar(10) NOT NULL,
	[upstream_code] varchar(50),
	[path] varchar(200),
	[url] varchar(500),
	[secret_ref] varchar(100),
	[is_enabled] bit NOT NULL CONSTRAINT [notify_webhook_subscription_is_enabled_default] DEFAULT ((1)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [notify_webhook_subscription_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [notify_webhook_subscription_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [notify_webhook_subscription_pkey] PRIMARY KEY([subscription_id])
);
--> statement-breakpoint
ALTER TABLE [gw].[notify_log] ADD [announcement_id] bigint;--> statement-breakpoint
ALTER TABLE [gw].[notify_announcement_asset] ADD CONSTRAINT [notify_announcement_asset_announcement_id_notify_announcement_announcement_id_fk] FOREIGN KEY ([announcement_id]) REFERENCES [gw].[notify_announcement]([announcement_id]);--> statement-breakpoint
ALTER TABLE [gw].[notify_receipt] ADD CONSTRAINT [notify_receipt_announcement_id_notify_announcement_announcement_id_fk] FOREIGN KEY ([announcement_id]) REFERENCES [gw].[notify_announcement]([announcement_id]);--> statement-breakpoint
ALTER TABLE [gw].[notify_receipt] ADD CONSTRAINT [notify_receipt_user_id_user_user_id_fk] FOREIGN KEY ([user_id]) REFERENCES [gw].[user]([user_id]);--> statement-breakpoint
CREATE INDEX [ix_notify_announcement_status_publish] ON [gw].[notify_announcement] ([status],[publish_at]);--> statement-breakpoint
CREATE INDEX [ix_notify_announcement_created_by] ON [gw].[notify_announcement] ([created_by]);--> statement-breakpoint
CREATE INDEX [ix_notify_announcement_asset_announcement] ON [gw].[notify_announcement_asset] ([announcement_id]);--> statement-breakpoint
CREATE INDEX [ix_notify_log_announcement] ON [gw].[notify_log] ([announcement_id]);--> statement-breakpoint
CREATE INDEX [ix_notify_receipt_user] ON [gw].[notify_receipt] ([user_id]);--> statement-breakpoint
CREATE UNIQUE INDEX [uq_notify_webhook_subscription_app] ON [gw].[notify_webhook_subscription] ([app_code]);