CREATE TABLE [gw].[permission_include] (
	[permission_id] int,
	[included_permission_id] int,
	[created_at] datetime2(3) NOT NULL CONSTRAINT [permission_include_created_at_default] DEFAULT (sysutcdatetime()),
	[created_by] nvarchar(64) NOT NULL,
	CONSTRAINT [pk_permission_include] PRIMARY KEY([permission_id],[included_permission_id])
);
--> statement-breakpoint
ALTER TABLE [gw].[permission_include] ADD CONSTRAINT [permission_include_permission_id_permission_permission_id_fk] FOREIGN KEY ([permission_id]) REFERENCES [gw].[permission]([permission_id]);--> statement-breakpoint
ALTER TABLE [gw].[permission_include] ADD CONSTRAINT [permission_include_included_permission_id_permission_permission_id_fk] FOREIGN KEY ([included_permission_id]) REFERENCES [gw].[permission]([permission_id]);--> statement-breakpoint
CREATE INDEX [ix_permission_include_included] ON [gw].[permission_include] ([included_permission_id]);