/*
  0001 init — 由 drizzle-kit generate 產生,人工審查 SQL Server 2012 相容性後調整(DATABASE.md §7.4)

  人工調整:
    1. 語句順序改為「資料表 → 索引 → 外鍵」:drizzle-kit 先建 FK 再建唯一索引,
       參照 [gw].[permission]([code]) 的 FK 需要該唯一索引先存在,否則執行失敗。
    2. audit_log / auth_log / api_access_log:主鍵改 NONCLUSTERED,occurred_at 改叢集索引
       (Standard 版無分割,以 occurred_at 範圍分批刪除,DATABASE.md §0)。
    3. 檔尾:稽核表對 gw_app_role DENY UPDATE, DELETE(只可新增與查詢,DATABASE.md §5)。
  已執行 `npm run db:check-2012`:無 2016+ 語法。
*/
CREATE TABLE [gw].[aggregate_step] (
	[step_id] int IDENTITY(1, 1),
	[route_id] int NOT NULL,
	[step_key] varchar(50) NOT NULL,
	[step_order] smallint NOT NULL,
	[upstream_id] int NOT NULL,
	[method] varchar(10) NOT NULL,
	[path_template] varchar(300) NOT NULL,
	[required] bit NOT NULL CONSTRAINT [aggregate_step_required_default] DEFAULT ((0)),
	[timeout_ms] int NOT NULL CONSTRAINT [aggregate_step_timeout_ms_default] DEFAULT ((5000)),
	[permission_code] varchar(100),
	[transform] nvarchar(max),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [aggregate_step_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [aggregate_step_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [aggregate_step_pkey] PRIMARY KEY([step_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[api_import_batch] (
	[batch_id] int IDENTITY(1, 1),
	[source_type] varchar(10) NOT NULL,
	[file_name] nvarchar(260) NOT NULL,
	[file_hash] char(64) NOT NULL,
	[upstream_id] int,
	[status] varchar(12) NOT NULL,
	[total] int NOT NULL CONSTRAINT [api_import_batch_total_default] DEFAULT ((0)),
	[created] int NOT NULL CONSTRAINT [api_import_batch_created_default] DEFAULT ((0)),
	[updated] int NOT NULL CONSTRAINT [api_import_batch_updated_default] DEFAULT ((0)),
	[skipped] int NOT NULL CONSTRAINT [api_import_batch_skipped_default] DEFAULT ((0)),
	[errors] int NOT NULL CONSTRAINT [api_import_batch_errors_default] DEFAULT ((0)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [api_import_batch_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [api_import_batch_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [api_import_batch_pkey] PRIMARY KEY([batch_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[api_import_item] (
	[item_id] int IDENTITY(1, 1),
	[batch_id] int NOT NULL,
	[row_no] int NOT NULL,
	[route_code] varchar(100),
	[action] varchar(10) NOT NULL,
	[payload] nvarchar(max),
	[error_message] nvarchar(1000),
	CONSTRAINT [api_import_item_pkey] PRIMARY KEY([item_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[api_route] (
	[route_id] int IDENTITY(1, 1),
	[route_code] varchar(100) NOT NULL,
	[name] nvarchar(100) NOT NULL,
	[system_code] varchar(30) NOT NULL,
	[method] varchar(10) NOT NULL,
	[public_path] varchar(300) NOT NULL,
	[route_type] varchar(20) NOT NULL,
	[upstream_id] int,
	[upstream_method] varchar(10),
	[upstream_path] varchar(300),
	[auth_mode] varchar(20) NOT NULL,
	[permission_code] varchar(100),
	[rate_limit_policy_id] int,
	[cache_ttl_sec] int,
	[cache_scope] varchar(10),
	[timeout_ms] int,
	[max_body_kb] int,
	[request_headers_add] nvarchar(max),
	[response_headers_remove] nvarchar(max),
	[mock_response] nvarchar(max),
	[audit_level] varchar(10) NOT NULL CONSTRAINT [api_route_audit_level_default] DEFAULT ('none'),
	[priority] smallint NOT NULL CONSTRAINT [api_route_priority_default] DEFAULT ((100)),
	[status] varchar(12) NOT NULL CONSTRAINT [api_route_status_default] DEFAULT ('draft'),
	[deprecated_at] datetime2(3),
	[version_tag] varchar(20),
	[tags] nvarchar(200),
	[owner] nvarchar(64),
	[source] varchar(20) NOT NULL CONSTRAINT [api_route_source_default] DEFAULT ('manual'),
	[import_batch_id] int,
	[description] nvarchar(1000),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [api_route_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [api_route_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [api_route_pkey] PRIMARY KEY([route_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[config_release] (
	[release_id] int IDENTITY(1, 1),
	[snapshot] nvarchar(max) NOT NULL,
	[diff_summary] nvarchar(max),
	[note] nvarchar(500),
	[published_by] nvarchar(64) NOT NULL,
	[published_at] datetime2(3) NOT NULL CONSTRAINT [config_release_published_at_default] DEFAULT (sysutcdatetime()),
	[rolled_back_from] int,
	[created_at] datetime2(3) NOT NULL CONSTRAINT [config_release_created_at_default] DEFAULT (sysutcdatetime()),
	CONSTRAINT [config_release_pkey] PRIMARY KEY([release_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[rate_limit_policy] (
	[policy_id] int IDENTITY(1, 1),
	[code] varchar(50) NOT NULL,
	[limit_count] int NOT NULL,
	[window_sec] int NOT NULL,
	[key_by] varchar(20) NOT NULL,
	[burst] int,
	[created_at] datetime2(3) NOT NULL CONSTRAINT [rate_limit_policy_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [rate_limit_policy_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [rate_limit_policy_pkey] PRIMARY KEY([policy_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[upstream] (
	[upstream_id] int IDENTITY(1, 1),
	[code] varchar(50) NOT NULL,
	[name] nvarchar(100) NOT NULL,
	[system_code] varchar(30) NOT NULL,
	[protocol] varchar(10) NOT NULL CONSTRAINT [upstream_protocol_default] DEFAULT ('http'),
	[lb_strategy] varchar(20) NOT NULL CONSTRAINT [upstream_lb_strategy_default] DEFAULT ('round_robin'),
	[timeout_ms] int NOT NULL CONSTRAINT [upstream_timeout_ms_default] DEFAULT ((10000)),
	[retry_count] tinyint NOT NULL CONSTRAINT [upstream_retry_count_default] DEFAULT ((1)),
	[circuit_fail_threshold] smallint NOT NULL CONSTRAINT [upstream_circuit_fail_threshold_default] DEFAULT ((10)),
	[health_check_path] varchar(200),
	[tls_verify] bit NOT NULL CONSTRAINT [upstream_tls_verify_default] DEFAULT ((1)),
	[forward_cookies] bit NOT NULL CONSTRAINT [upstream_forward_cookies_default] DEFAULT ((0)),
	[owner] nvarchar(64),
	[archatlas_node_id] varchar(50),
	[is_enabled] bit NOT NULL CONSTRAINT [upstream_is_enabled_default] DEFAULT ((1)),
	[description] nvarchar(500),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [upstream_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [upstream_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [upstream_pkey] PRIMARY KEY([upstream_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[upstream_target] (
	[target_id] int IDENTITY(1, 1),
	[upstream_id] int NOT NULL,
	[base_url] varchar(300) NOT NULL,
	[weight] smallint NOT NULL CONSTRAINT [upstream_target_weight_default] DEFAULT ((1)),
	[environment] varchar(10) NOT NULL,
	[is_enabled] bit NOT NULL CONSTRAINT [upstream_target_is_enabled_default] DEFAULT ((1)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [upstream_target_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [upstream_target_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [upstream_target_pkey] PRIMARY KEY([target_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[api_client] (
	[client_id] int IDENTITY(1, 1),
	[code] varchar(50) NOT NULL,
	[name] nvarchar(100) NOT NULL,
	[key_prefix] char(8) NOT NULL,
	[key_hash] varchar(200) NOT NULL,
	[allowed_ips] varchar(500),
	[expires_at] datetime2(3),
	[is_enabled] bit NOT NULL CONSTRAINT [api_client_is_enabled_default] DEFAULT ((1)),
	[last_used_at] datetime2(3),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [api_client_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [api_client_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [api_client_pkey] PRIMARY KEY([client_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[api_client_permission] (
	[client_id] int,
	[permission_id] int,
	CONSTRAINT [pk_api_client_permission] PRIMARY KEY([client_id],[permission_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[company] (
	[company_id] int IDENTITY(1, 1),
	[comp_name] nvarchar(20) NOT NULL,
	[comp_full_name] nvarchar(100),
	[comp_db] varchar(20),
	[bpm_org_oid] varchar(50),
	[emp_prefix] varchar(5),
	[is_enabled] bit NOT NULL CONSTRAINT [company_is_enabled_default] DEFAULT ((1)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [company_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [company_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [company_pkey] PRIMARY KEY([company_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[company_ad_domain] (
	[company_id] int,
	[domain_code] varchar(30),
	[try_order] smallint NOT NULL,
	CONSTRAINT [pk_company_ad_domain] PRIMARY KEY([company_id],[domain_code])
);
--> statement-breakpoint
CREATE TABLE [gw].[local_account_token] (
	[token_id] int IDENTITY(1, 1),
	[user_id] int NOT NULL,
	[purpose] varchar(20) NOT NULL,
	[token_hash] char(64) NOT NULL,
	[expires_at] datetime2(3) NOT NULL,
	[used_at] datetime2(3),
	[created_ip] varchar(45),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [local_account_token_created_at_default] DEFAULT (sysutcdatetime()),
	CONSTRAINT [local_account_token_pkey] PRIMARY KEY([token_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[local_credential] (
	[user_id] int,
	[password_hash] varchar(200),
	[status] varchar(20) NOT NULL,
	[failed_count] smallint NOT NULL CONSTRAINT [local_credential_failed_count_default] DEFAULT ((0)),
	[locked_at] datetime2(3),
	[must_change_password] bit NOT NULL CONSTRAINT [local_credential_must_change_password_default] DEFAULT ((0)),
	[password_changed_at] datetime2(3),
	[password_history] nvarchar(1000),
	[registered_via] varchar(20) NOT NULL,
	[legacy_migrated_at] datetime2(3),
	[approved_by] nvarchar(64),
	[approved_at] datetime2(3),
	[manager_notified_at] datetime2(3),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [local_credential_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [local_credential_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [local_credential_pkey] PRIMARY KEY([user_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[permission] (
	[permission_id] int IDENTITY(1, 1),
	[code] varchar(100) NOT NULL,
	[name] nvarchar(100) NOT NULL,
	[system_code] varchar(30) NOT NULL,
	[resource] varchar(50) NOT NULL,
	[action] varchar(30) NOT NULL,
	[description] nvarchar(500),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [permission_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [permission_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [permission_pkey] PRIMARY KEY([permission_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[role] (
	[role_id] int IDENTITY(1, 1),
	[code] varchar(50) NOT NULL,
	[name] nvarchar(100) NOT NULL,
	[description] nvarchar(500),
	[is_system] bit NOT NULL CONSTRAINT [role_is_system_default] DEFAULT ((0)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [role_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [role_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [role_pkey] PRIMARY KEY([role_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[role_ad_group] (
	[role_id] int,
	[ad_group_dn] nvarchar(400),
	[ad_group_guid] uniqueidentifier,
	[created_at] datetime2(3) NOT NULL CONSTRAINT [role_ad_group_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	CONSTRAINT [pk_role_ad_group] PRIMARY KEY([role_id],[ad_group_dn])
);
--> statement-breakpoint
CREATE TABLE [gw].[role_company] (
	[role_id] int,
	[company_id] int,
	[created_at] datetime2(3) NOT NULL CONSTRAINT [role_company_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	CONSTRAINT [pk_role_company] PRIMARY KEY([role_id],[company_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[role_permission] (
	[role_id] int,
	[permission_id] int,
	[created_at] datetime2(3) NOT NULL CONSTRAINT [role_permission_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	CONSTRAINT [pk_role_permission] PRIMARY KEY([role_id],[permission_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[user] (
	[user_id] int IDENTITY(1, 1),
	[employee_no] varchar(20) NOT NULL,
	[is_virtual] bit NOT NULL CONSTRAINT [user_is_virtual_default] DEFAULT ((0)),
	[base_employee_no] varchar(20),
	[auth_type] varchar(10),
	[ad_object_guid] uniqueidentifier,
	[ad_domain] varchar(30),
	[upn] varchar(128),
	[display_name] nvarchar(100) NOT NULL,
	[email] varchar(128),
	[dept_code] varchar(30),
	[department] nvarchar(100),
	[org_name] nvarchar(100),
	[title] nvarchar(100),
	[job_level] varchar(10),
	[manager_employee_no] varchar(20),
	[employment_status] varchar(10),
	[profile_source] varchar(10) NOT NULL,
	[profile_hash] char(64),
	[profile_synced_at] datetime2(3),
	[ad_groups] nvarchar(max),
	[notify_pref] nvarchar(200),
	[perm_version] int NOT NULL CONSTRAINT [user_perm_version_default] DEFAULT ((1)),
	[is_disabled] bit NOT NULL CONSTRAINT [user_is_disabled_default] DEFAULT ((0)),
	[last_login_at] datetime2(3),
	[last_login_ip] varchar(45),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [user_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [user_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [user_pkey] PRIMARY KEY([user_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[user_company] (
	[user_id] int,
	[company_id] int,
	[via_employee_no] varchar(20),
	[dept_code] varchar(30),
	[department] nvarchar(100),
	[is_virtual] bit NOT NULL CONSTRAINT [user_company_is_virtual_default] DEFAULT ((0)),
	[is_primary] bit NOT NULL CONSTRAINT [user_company_is_primary_default] DEFAULT ((0)),
	CONSTRAINT [pk_user_company] PRIMARY KEY([user_id],[company_id],[via_employee_no])
);
--> statement-breakpoint
CREATE TABLE [gw].[user_role] (
	[user_id] int,
	[role_id] int,
	[valid_from] datetime2(3) NOT NULL,
	[valid_to] datetime2(3),
	[reason] nvarchar(200),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [user_role_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	CONSTRAINT [pk_user_role] PRIMARY KEY([user_id],[role_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[notify_log] (
	[log_id] bigint IDENTITY(1, 1),
	[template_code] varchar(50),
	[channel] varchar(10) NOT NULL,
	[recipient_user_id] int,
	[recipient_address] nvarchar(200),
	[status] varchar(10) NOT NULL,
	[retry_count] smallint NOT NULL CONSTRAINT [notify_log_retry_count_default] DEFAULT ((0)),
	[provider_msg_id] varchar(200),
	[error_message] nvarchar(2000),
	[idempotency_key] varchar(100),
	[requested_by] nvarchar(64),
	[queued_at] datetime2(3) NOT NULL CONSTRAINT [notify_log_queued_at_default] DEFAULT (sysutcdatetime()),
	[sent_at] datetime2(3),
	CONSTRAINT [notify_log_pkey] PRIMARY KEY([log_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[notify_message] (
	[message_id] bigint IDENTITY(1, 1),
	[user_id] int NOT NULL,
	[title] nvarchar(200) NOT NULL,
	[body] nvarchar(2000),
	[link_url] varchar(500),
	[is_read] bit NOT NULL CONSTRAINT [notify_message_is_read_default] DEFAULT ((0)),
	[read_at] datetime2(3),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [notify_message_created_at_default] DEFAULT (sysutcdatetime()),
	CONSTRAINT [notify_message_pkey] PRIMARY KEY([message_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[notify_template] (
	[template_id] int IDENTITY(1, 1),
	[code] varchar(50) NOT NULL,
	[name] nvarchar(100) NOT NULL,
	[channels] nvarchar(200) NOT NULL,
	[email_subject] nvarchar(200),
	[email_body] nvarchar(max),
	[inapp_body] nvarchar(2000),
	[is_enabled] bit NOT NULL CONSTRAINT [notify_template_is_enabled_default] DEFAULT ((1)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [notify_template_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [notify_template_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [notify_template_pkey] PRIMARY KEY([template_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[webhook_endpoint] (
	[endpoint_id] int IDENTITY(1, 1),
	[source_code] varchar(30) NOT NULL,
	[verify_method] varchar(20) NOT NULL,
	[secret_ref] varchar(100),
	[signature_header] varchar(100),
	[allowed_ips] varchar(500),
	[dispatch_type] varchar(10) NOT NULL,
	[dispatch_target] varchar(200),
	[is_enabled] bit NOT NULL CONSTRAINT [webhook_endpoint_is_enabled_default] DEFAULT ((1)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [webhook_endpoint_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [webhook_endpoint_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [webhook_endpoint_pkey] PRIMARY KEY([endpoint_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[webhook_log] (
	[log_id] bigint IDENTITY(1, 1),
	[endpoint_id] int,
	[request_id] varchar(64),
	[idempotency_key] varchar(100),
	[remote_ip] varchar(45),
	[verified] bit NOT NULL,
	[status_code] smallint,
	[payload] nvarchar(max),
	[received_at] datetime2(3) NOT NULL CONSTRAINT [webhook_log_received_at_default] DEFAULT (sysutcdatetime()),
	[processed_at] datetime2(3),
	[error_message] nvarchar(2000),
	CONSTRAINT [webhook_log_pkey] PRIMARY KEY([log_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[api_access_log] (
	[log_id] bigint IDENTITY(1, 1),
	[occurred_at] datetime2(3) NOT NULL CONSTRAINT [api_access_log_occurred_at_default] DEFAULT (sysutcdatetime()),
	[request_id] varchar(64),
	[route_code] varchar(100),
	[user_id] int,
	[client_id] int,
	[method] varchar(10) NOT NULL,
	[path] nvarchar(1000) NOT NULL,
	[status] smallint NOT NULL,
	[duration_ms] int NOT NULL,
	[body] nvarchar(max),
	CONSTRAINT [api_access_log_pkey] PRIMARY KEY NONCLUSTERED([log_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[audit_log] (
	[audit_id] bigint IDENTITY(1, 1),
	[occurred_at] datetime2(3) NOT NULL CONSTRAINT [audit_log_occurred_at_default] DEFAULT (sysutcdatetime()),
	[actor_user_id] int,
	[actor_name] nvarchar(100),
	[actor_ip] varchar(45),
	[action] varchar(60) NOT NULL,
	[entity_type] varchar(40) NOT NULL,
	[entity_id] varchar(100),
	[before_json] nvarchar(max),
	[after_json] nvarchar(max),
	[request_id] varchar(64),
	CONSTRAINT [audit_log_pkey] PRIMARY KEY NONCLUSTERED([audit_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[auth_log] (
	[log_id] bigint IDENTITY(1, 1),
	[occurred_at] datetime2(3) NOT NULL CONSTRAINT [auth_log_occurred_at_default] DEFAULT (sysutcdatetime()),
	[username] nvarchar(128) NOT NULL,
	[user_id] int,
	[auth_method] varchar(10),
	[event] varchar(30) NOT NULL,
	[reason] nvarchar(200),
	[ip] varchar(45),
	[user_agent] nvarchar(400),
	CONSTRAINT [auth_log_pkey] PRIMARY KEY NONCLUSTERED([log_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[employee_sync_run] (
	[run_id] int IDENTITY(1, 1),
	[trigger_type] varchar(10) NOT NULL,
	[started_at] datetime2(3) NOT NULL CONSTRAINT [employee_sync_run_started_at_default] DEFAULT (sysutcdatetime()),
	[finished_at] datetime2(3),
	[status] varchar(12) NOT NULL,
	[bpm_rows] int,
	[los_rows] int,
	[created] int NOT NULL CONSTRAINT [employee_sync_run_created_default] DEFAULT ((0)),
	[updated] int NOT NULL CONSTRAINT [employee_sync_run_updated_default] DEFAULT ((0)),
	[unchanged] int NOT NULL CONSTRAINT [employee_sync_run_unchanged_default] DEFAULT ((0)),
	[resigned_flagged] int NOT NULL CONSTRAINT [employee_sync_run_resigned_flagged_default] DEFAULT ((0)),
	[error_message] nvarchar(2000),
	[triggered_by] nvarchar(64),
	CONSTRAINT [employee_sync_run_pkey] PRIMARY KEY([run_id])
);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_aggregate_step_route_key] ON [gw].[aggregate_step] ([route_id],[step_key]);
--> statement-breakpoint
CREATE INDEX [ix_api_import_item_batch] ON [gw].[api_import_item] ([batch_id]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_api_route_code] ON [gw].[api_route] ([route_code]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_api_route_method_path_active] ON [gw].[api_route] ([method],[public_path]) WHERE [status] <> 'disabled';
--> statement-breakpoint
CREATE INDEX [ix_api_route_system_status] ON [gw].[api_route] ([system_code],[status]);
--> statement-breakpoint
CREATE INDEX [ix_api_route_upstream] ON [gw].[api_route] ([upstream_id]);
--> statement-breakpoint
CREATE INDEX [ix_api_route_permission] ON [gw].[api_route] ([permission_code]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_rate_limit_policy_code] ON [gw].[rate_limit_policy] ([code]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_upstream_code] ON [gw].[upstream] ([code]);
--> statement-breakpoint
CREATE INDEX [ix_upstream_target_upstream] ON [gw].[upstream_target] ([upstream_id]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_api_client_code] ON [gw].[api_client] ([code]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_api_client_key_prefix] ON [gw].[api_client] ([key_prefix]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_company_comp_name] ON [gw].[company] ([comp_name]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_local_account_token_hash] ON [gw].[local_account_token] ([token_hash]);
--> statement-breakpoint
CREATE INDEX [ix_local_account_token_user_purpose] ON [gw].[local_account_token] ([user_id],[purpose]);
--> statement-breakpoint
CREATE INDEX [ix_local_credential_status] ON [gw].[local_credential] ([status]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_permission_code] ON [gw].[permission] ([code]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_role_code] ON [gw].[role] ([code]);
--> statement-breakpoint
CREATE INDEX [ix_role_permission_permission] ON [gw].[role_permission] ([permission_id]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_user_employee_no] ON [gw].[user] ([employee_no]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_user_ad_object_guid] ON [gw].[user] ([ad_object_guid]) WHERE [ad_object_guid] IS NOT NULL;
--> statement-breakpoint
CREATE INDEX [ix_user_base_employee_no] ON [gw].[user] ([base_employee_no]);
--> statement-breakpoint
CREATE INDEX [ix_user_company_company] ON [gw].[user_company] ([company_id]);
--> statement-breakpoint
CREATE INDEX [ix_user_role_role] ON [gw].[user_role] ([role_id]);
--> statement-breakpoint
CREATE INDEX [ix_notify_log_queued_at] ON [gw].[notify_log] ([queued_at]);
--> statement-breakpoint
CREATE INDEX [ix_notify_log_recipient] ON [gw].[notify_log] ([recipient_user_id]);
--> statement-breakpoint
CREATE INDEX [ix_notify_log_idempotency] ON [gw].[notify_log] ([idempotency_key]);
--> statement-breakpoint
CREATE INDEX [ix_notify_message_user_read] ON [gw].[notify_message] ([user_id],[is_read],[created_at]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_notify_template_code] ON [gw].[notify_template] ([code]);
--> statement-breakpoint
CREATE UNIQUE INDEX [uq_webhook_endpoint_source] ON [gw].[webhook_endpoint] ([source_code]);
--> statement-breakpoint
CREATE INDEX [ix_webhook_log_received_at] ON [gw].[webhook_log] ([received_at]);
--> statement-breakpoint
CREATE CLUSTERED INDEX [ix_api_access_log_occurred_at] ON [gw].[api_access_log] ([occurred_at]);
--> statement-breakpoint
CREATE CLUSTERED INDEX [ix_audit_log_occurred_at] ON [gw].[audit_log] ([occurred_at]);
--> statement-breakpoint
CREATE INDEX [ix_audit_log_entity] ON [gw].[audit_log] ([entity_type],[entity_id]);
--> statement-breakpoint
CREATE CLUSTERED INDEX [ix_auth_log_occurred_at] ON [gw].[auth_log] ([occurred_at]);
--> statement-breakpoint
CREATE INDEX [ix_auth_log_user] ON [gw].[auth_log] ([user_id],[occurred_at]);
--> statement-breakpoint
ALTER TABLE [gw].[aggregate_step] ADD CONSTRAINT [aggregate_step_route_id_api_route_route_id_fk] FOREIGN KEY ([route_id]) REFERENCES [gw].[api_route]([route_id]);
--> statement-breakpoint
ALTER TABLE [gw].[aggregate_step] ADD CONSTRAINT [aggregate_step_upstream_id_upstream_upstream_id_fk] FOREIGN KEY ([upstream_id]) REFERENCES [gw].[upstream]([upstream_id]);
--> statement-breakpoint
ALTER TABLE [gw].[aggregate_step] ADD CONSTRAINT [aggregate_step_permission_code_permission_code_fk] FOREIGN KEY ([permission_code]) REFERENCES [gw].[permission]([code]);
--> statement-breakpoint
ALTER TABLE [gw].[api_import_batch] ADD CONSTRAINT [api_import_batch_upstream_id_upstream_upstream_id_fk] FOREIGN KEY ([upstream_id]) REFERENCES [gw].[upstream]([upstream_id]);
--> statement-breakpoint
ALTER TABLE [gw].[api_import_item] ADD CONSTRAINT [api_import_item_batch_id_api_import_batch_batch_id_fk] FOREIGN KEY ([batch_id]) REFERENCES [gw].[api_import_batch]([batch_id]);
--> statement-breakpoint
ALTER TABLE [gw].[api_route] ADD CONSTRAINT [api_route_upstream_id_upstream_upstream_id_fk] FOREIGN KEY ([upstream_id]) REFERENCES [gw].[upstream]([upstream_id]);
--> statement-breakpoint
ALTER TABLE [gw].[api_route] ADD CONSTRAINT [api_route_permission_code_permission_code_fk] FOREIGN KEY ([permission_code]) REFERENCES [gw].[permission]([code]);
--> statement-breakpoint
ALTER TABLE [gw].[api_route] ADD CONSTRAINT [api_route_rate_limit_policy_id_rate_limit_policy_policy_id_fk] FOREIGN KEY ([rate_limit_policy_id]) REFERENCES [gw].[rate_limit_policy]([policy_id]);
--> statement-breakpoint
ALTER TABLE [gw].[api_route] ADD CONSTRAINT [api_route_import_batch_id_api_import_batch_batch_id_fk] FOREIGN KEY ([import_batch_id]) REFERENCES [gw].[api_import_batch]([batch_id]);
--> statement-breakpoint
ALTER TABLE [gw].[upstream_target] ADD CONSTRAINT [upstream_target_upstream_id_upstream_upstream_id_fk] FOREIGN KEY ([upstream_id]) REFERENCES [gw].[upstream]([upstream_id]);
--> statement-breakpoint
ALTER TABLE [gw].[api_client_permission] ADD CONSTRAINT [api_client_permission_client_id_api_client_client_id_fk] FOREIGN KEY ([client_id]) REFERENCES [gw].[api_client]([client_id]);
--> statement-breakpoint
ALTER TABLE [gw].[api_client_permission] ADD CONSTRAINT [api_client_permission_permission_id_permission_permission_id_fk] FOREIGN KEY ([permission_id]) REFERENCES [gw].[permission]([permission_id]);
--> statement-breakpoint
ALTER TABLE [gw].[company_ad_domain] ADD CONSTRAINT [company_ad_domain_company_id_company_company_id_fk] FOREIGN KEY ([company_id]) REFERENCES [gw].[company]([company_id]);
--> statement-breakpoint
ALTER TABLE [gw].[local_account_token] ADD CONSTRAINT [local_account_token_user_id_user_user_id_fk] FOREIGN KEY ([user_id]) REFERENCES [gw].[user]([user_id]);
--> statement-breakpoint
ALTER TABLE [gw].[local_credential] ADD CONSTRAINT [local_credential_user_id_user_user_id_fk] FOREIGN KEY ([user_id]) REFERENCES [gw].[user]([user_id]);
--> statement-breakpoint
ALTER TABLE [gw].[role_ad_group] ADD CONSTRAINT [role_ad_group_role_id_role_role_id_fk] FOREIGN KEY ([role_id]) REFERENCES [gw].[role]([role_id]);
--> statement-breakpoint
ALTER TABLE [gw].[role_company] ADD CONSTRAINT [role_company_role_id_role_role_id_fk] FOREIGN KEY ([role_id]) REFERENCES [gw].[role]([role_id]);
--> statement-breakpoint
ALTER TABLE [gw].[role_company] ADD CONSTRAINT [role_company_company_id_company_company_id_fk] FOREIGN KEY ([company_id]) REFERENCES [gw].[company]([company_id]);
--> statement-breakpoint
ALTER TABLE [gw].[role_permission] ADD CONSTRAINT [role_permission_role_id_role_role_id_fk] FOREIGN KEY ([role_id]) REFERENCES [gw].[role]([role_id]);
--> statement-breakpoint
ALTER TABLE [gw].[role_permission] ADD CONSTRAINT [role_permission_permission_id_permission_permission_id_fk] FOREIGN KEY ([permission_id]) REFERENCES [gw].[permission]([permission_id]);
--> statement-breakpoint
ALTER TABLE [gw].[user_company] ADD CONSTRAINT [user_company_user_id_user_user_id_fk] FOREIGN KEY ([user_id]) REFERENCES [gw].[user]([user_id]);
--> statement-breakpoint
ALTER TABLE [gw].[user_company] ADD CONSTRAINT [user_company_company_id_company_company_id_fk] FOREIGN KEY ([company_id]) REFERENCES [gw].[company]([company_id]);
--> statement-breakpoint
ALTER TABLE [gw].[user_role] ADD CONSTRAINT [user_role_user_id_user_user_id_fk] FOREIGN KEY ([user_id]) REFERENCES [gw].[user]([user_id]);
--> statement-breakpoint
ALTER TABLE [gw].[user_role] ADD CONSTRAINT [user_role_role_id_role_role_id_fk] FOREIGN KEY ([role_id]) REFERENCES [gw].[role]([role_id]);
--> statement-breakpoint
ALTER TABLE [gw].[notify_message] ADD CONSTRAINT [notify_message_user_id_user_user_id_fk] FOREIGN KEY ([user_id]) REFERENCES [gw].[user]([user_id]);
--> statement-breakpoint
ALTER TABLE [gw].[webhook_log] ADD CONSTRAINT [webhook_log_endpoint_id_webhook_endpoint_endpoint_id_fk] FOREIGN KEY ([endpoint_id]) REFERENCES [gw].[webhook_endpoint]([endpoint_id]);
--> statement-breakpoint
IF DATABASE_PRINCIPAL_ID(N'gw_app_role') IS NOT NULL
BEGIN
    DENY UPDATE, DELETE ON [gw].[audit_log] TO [gw_app_role];
    DENY UPDATE, DELETE ON [gw].[auth_log] TO [gw_app_role];
    DENY UPDATE, DELETE ON [gw].[api_access_log] TO [gw_app_role];
END
