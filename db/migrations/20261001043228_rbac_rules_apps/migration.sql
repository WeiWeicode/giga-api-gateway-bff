CREATE TABLE [gw].[app] (
	[app_id] int IDENTITY(1, 1),
	[code] varchar(30) NOT NULL,
	[name] nvarchar(50) NOT NULL,
	[base_path] varchar(100) NOT NULL,
	[icon] varchar(30),
	[sort] smallint NOT NULL CONSTRAINT [app_sort_default] DEFAULT ((0)),
	[permission_code] varchar(100) NOT NULL,
	[is_enabled] bit NOT NULL CONSTRAINT [app_is_enabled_default] DEFAULT ((1)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [app_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [app_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [app_pkey] PRIMARY KEY([app_id])
);
--> statement-breakpoint
CREATE TABLE [gw].[department] (
	[dept_code] varchar(30),
	[name] nvarchar(100) NOT NULL,
	[parent_dept_code] varchar(30),
	[company_id] int,
	[bpm_unit_oid] varchar(50),
	[is_enabled] bit NOT NULL CONSTRAINT [department_is_enabled_default] DEFAULT ((1)),
	[synced_at] datetime2(3) NOT NULL,
	CONSTRAINT [department_pkey] PRIMARY KEY([dept_code])
);
--> statement-breakpoint
CREATE TABLE [gw].[role_rule] (
	[rule_id] int IDENTITY(1, 1),
	[role_id] int NOT NULL,
	[company_id] int,
	[dept_code] varchar(30),
	[include_sub_depts] bit NOT NULL CONSTRAINT [role_rule_include_sub_depts_default] DEFAULT ((1)),
	[job_levels] nvarchar(200),
	[title] nvarchar(100),
	[description] nvarchar(200),
	[is_enabled] bit NOT NULL CONSTRAINT [role_rule_is_enabled_default] DEFAULT ((1)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [role_rule_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	[updated_at] datetime2(3) NOT NULL CONSTRAINT [role_rule_updated_at_default] DEFAULT (sysutcdatetime()),
	[updated_by] nvarchar(64) NOT NULL,
	[row_ver] rowversion NOT NULL,
	CONSTRAINT [role_rule_pkey] PRIMARY KEY([rule_id])
);
--> statement-breakpoint
ALTER TABLE [gw].[permission] ADD [kind] varchar(10) NOT NULL CONSTRAINT [permission_kind_default] DEFAULT ('api');--> statement-breakpoint
ALTER TABLE [gw].[permission] ADD [parent_code] varchar(100);--> statement-breakpoint
ALTER TABLE [gw].[permission] ADD [sort] smallint;--> statement-breakpoint
ALTER TABLE [gw].[department] ADD CONSTRAINT [department_company_id_company_company_id_fk] FOREIGN KEY ([company_id]) REFERENCES [gw].[company]([company_id]);--> statement-breakpoint
ALTER TABLE [gw].[role_rule] ADD CONSTRAINT [role_rule_role_id_role_role_id_fk] FOREIGN KEY ([role_id]) REFERENCES [gw].[role]([role_id]);--> statement-breakpoint
ALTER TABLE [gw].[role_rule] ADD CONSTRAINT [role_rule_company_id_company_company_id_fk] FOREIGN KEY ([company_id]) REFERENCES [gw].[company]([company_id]);--> statement-breakpoint
CREATE UNIQUE INDEX [uq_app_code] ON [gw].[app] ([code]);--> statement-breakpoint
CREATE INDEX [ix_department_parent] ON [gw].[department] ([parent_dept_code]);--> statement-breakpoint
CREATE INDEX [ix_role_rule_role] ON [gw].[role_rule] ([role_id]);