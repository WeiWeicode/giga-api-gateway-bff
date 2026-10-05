CREATE TABLE [gw].[dept_permission] (
	[dept_code] varchar(30),
	[permission_id] int,
	[job_tier] varchar(20),
	[include_sub_depts] bit NOT NULL CONSTRAINT [dept_permission_include_sub_depts_default] DEFAULT ((1)),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [dept_permission_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	CONSTRAINT [pk_dept_permission] PRIMARY KEY([dept_code],[permission_id],[job_tier])
);
--> statement-breakpoint
CREATE TABLE [gw].[user_permission] (
	[user_id] int,
	[permission_id] int,
	[valid_to] datetime2(3),
	[reason] nvarchar(200),
	[created_at] datetime2(3) NOT NULL CONSTRAINT [user_permission_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	CONSTRAINT [pk_user_permission] PRIMARY KEY([user_id],[permission_id])
);
--> statement-breakpoint
ALTER TABLE [gw].[dept_permission] ADD CONSTRAINT [dept_permission_dept_code_department_dept_code_fk] FOREIGN KEY ([dept_code]) REFERENCES [gw].[department]([dept_code]);--> statement-breakpoint
ALTER TABLE [gw].[dept_permission] ADD CONSTRAINT [dept_permission_permission_id_permission_permission_id_fk] FOREIGN KEY ([permission_id]) REFERENCES [gw].[permission]([permission_id]);--> statement-breakpoint
ALTER TABLE [gw].[user_permission] ADD CONSTRAINT [user_permission_user_id_user_user_id_fk] FOREIGN KEY ([user_id]) REFERENCES [gw].[user]([user_id]);--> statement-breakpoint
ALTER TABLE [gw].[user_permission] ADD CONSTRAINT [user_permission_permission_id_permission_permission_id_fk] FOREIGN KEY ([permission_id]) REFERENCES [gw].[permission]([permission_id]);--> statement-breakpoint
CREATE INDEX [ix_dept_permission_permission] ON [gw].[dept_permission] ([permission_id]);--> statement-breakpoint
CREATE INDEX [ix_user_permission_permission] ON [gw].[user_permission] ([permission_id]);