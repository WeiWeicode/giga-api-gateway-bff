/** 身分與權限、公司與本機帳號(DATABASE.md §3、§3.1) */
import { sql } from 'drizzle-orm';
import { bit, char, datetime2, index, int, nvarchar, primaryKey, smallint, uniqueIndex, varchar } from 'drizzle-orm/mssql-core';
import { auditColumns, createdAt, gw, uniqueidentifier } from './common.js';

export const user = gw.table(
  'user',
  {
    userId: int('user_id').identity().primaryKey(),
    employeeNo: varchar('employee_no', { length: 20 }).notNull(),
    isVirtual: bit('is_virtual').notNull().default(false),
    baseEmployeeNo: varchar('base_employee_no', { length: 20 }),
    authType: varchar('auth_type', { length: 10 }),
    adObjectGuid: uniqueidentifier('ad_object_guid'),
    adDomain: varchar('ad_domain', { length: 30 }),
    upn: varchar('upn', { length: 128 }),
    displayName: nvarchar('display_name', { length: 100 }).notNull(),
    email: varchar('email', { length: 128 }),
    deptCode: varchar('dept_code', { length: 30 }),
    department: nvarchar('department', { length: 100 }),
    orgName: nvarchar('org_name', { length: 100 }),
    title: nvarchar('title', { length: 100 }),
    jobLevel: varchar('job_level', { length: 10 }),
    managerEmployeeNo: varchar('manager_employee_no', { length: 20 }),
    employmentStatus: varchar('employment_status', { length: 10 }),
    profileSource: varchar('profile_source', { length: 10 }).notNull(),
    profileHash: char('profile_hash', { length: 64 }),
    profileSyncedAt: datetime2('profile_synced_at', { precision: 3 }),
    adGroups: nvarchar('ad_groups', { length: 'max' }),
    notifyPref: nvarchar('notify_pref', { length: 200 }),
    permVersion: int('perm_version').notNull().default(1),
    isDisabled: bit('is_disabled').notNull().default(false),
    lastLoginAt: datetime2('last_login_at', { precision: 3 }),
    lastLoginIp: varchar('last_login_ip', { length: 45 }),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('uq_user_employee_no').on(t.employeeNo),
    uniqueIndex('uq_user_ad_object_guid')
      .on(t.adObjectGuid)
      .where(sql`[ad_object_guid] IS NOT NULL`),
    index('ix_user_base_employee_no').on(t.baseEmployeeNo),
  ],
);

export const role = gw.table(
  'role',
  {
    roleId: int('role_id').identity().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    name: nvarchar('name', { length: 100 }).notNull(),
    description: nvarchar('description', { length: 500 }),
    isSystem: bit('is_system').notNull().default(false),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_role_code').on(t.code)],
);

export const permission = gw.table(
  'permission',
  {
    permissionId: int('permission_id').identity().primaryKey(),
    code: varchar('code', { length: 100 }).notNull(),
    name: nvarchar('name', { length: 100 }).notNull(),
    systemCode: varchar('system_code', { length: 30 }).notNull(),
    resource: varchar('resource', { length: 50 }).notNull(),
    action: varchar('action', { length: 30 }).notNull(),
    description: nvarchar('description', { length: 500 }),
    /** 權限分類(PRD §8.3.2,v0.7):app / group / menu / tab / button / api;未宣告 = api。group = 選單目錄(只分組命名,不可授予,v0.12) */
    kind: varchar('kind', { length: 10 }).notNull().default('api'),
    /** 上層權限代碼(應用 → 選單 → Tab → 按鈕) */
    parentCode: varchar('parent_code', { length: 100 }),
    sort: smallint('sort'),
    /** 選單圖示名稱(各應用的圖示集,例 settings);目錄與選單使用,v0.12 */
    icon: varchar('icon', { length: 30 }),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_permission_code').on(t.code)],
);

export const rolePermission = gw.table(
  'role_permission',
  {
    roleId: int('role_id')
      .notNull()
      .references(() => role.roleId),
    permissionId: int('permission_id')
      .notNull()
      .references(() => permission.permissionId),
    createdAt: createdAt(),
    createdBy: nvarchar('created_by', { length: 64 }).notNull(),
  },
  (t) => [primaryKey({ name: 'pk_role_permission', columns: [t.roleId, t.permissionId] }), index('ix_role_permission_permission').on(t.permissionId)],
);

export const roleAdGroup = gw.table(
  'role_ad_group',
  {
    roleId: int('role_id')
      .notNull()
      .references(() => role.roleId),
    adGroupDn: nvarchar('ad_group_dn', { length: 400 }).notNull(),
    adGroupGuid: uniqueidentifier('ad_group_guid'),
    createdAt: createdAt(),
    createdBy: nvarchar('created_by', { length: 64 }).notNull(),
  },
  (t) => [primaryKey({ name: 'pk_role_ad_group', columns: [t.roleId, t.adGroupDn] })],
);

export const userRole = gw.table(
  'user_role',
  {
    userId: int('user_id')
      .notNull()
      .references(() => user.userId),
    roleId: int('role_id')
      .notNull()
      .references(() => role.roleId),
    validFrom: datetime2('valid_from', { precision: 3 }).notNull(),
    validTo: datetime2('valid_to', { precision: 3 }),
    reason: nvarchar('reason', { length: 200 }),
    createdAt: createdAt(),
    createdBy: nvarchar('created_by', { length: 64 }).notNull(),
  },
  (t) => [primaryKey({ name: 'pk_user_role', columns: [t.userId, t.roleId] }), index('ix_user_role_role').on(t.roleId)],
);

export const apiClient = gw.table(
  'api_client',
  {
    clientId: int('client_id').identity().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    name: nvarchar('name', { length: 100 }).notNull(),
    keyPrefix: char('key_prefix', { length: 8 }).notNull(),
    keyHash: varchar('key_hash', { length: 200 }).notNull(),
    allowedIps: varchar('allowed_ips', { length: 500 }),
    expiresAt: datetime2('expires_at', { precision: 3 }),
    isEnabled: bit('is_enabled').notNull().default(true),
    lastUsedAt: datetime2('last_used_at', { precision: 3 }),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_api_client_code').on(t.code), uniqueIndex('uq_api_client_key_prefix').on(t.keyPrefix)],
);

export const apiClientPermission = gw.table(
  'api_client_permission',
  {
    clientId: int('client_id')
      .notNull()
      .references(() => apiClient.clientId),
    permissionId: int('permission_id')
      .notNull()
      .references(() => permission.permissionId),
  },
  (t) => [primaryKey({ name: 'pk_api_client_permission', columns: [t.clientId, t.permissionId] })],
);

/* ---------- §3.1 公司與本機帳號 ---------- */

export const company = gw.table(
  'company',
  {
    companyId: int('company_id').identity().primaryKey(),
    compName: nvarchar('comp_name', { length: 20 }).notNull(),
    compFullName: nvarchar('comp_full_name', { length: 100 }),
    compDb: varchar('comp_db', { length: 20 }),
    bpmOrgOid: varchar('bpm_org_oid', { length: 50 }),
    empPrefix: varchar('emp_prefix', { length: 5 }),
    isEnabled: bit('is_enabled').notNull().default(true),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_company_comp_name').on(t.compName)],
);

export const companyAdDomain = gw.table(
  'company_ad_domain',
  {
    companyId: int('company_id')
      .notNull()
      .references(() => company.companyId),
    domainCode: varchar('domain_code', { length: 30 }).notNull(),
    tryOrder: smallint('try_order').notNull(),
  },
  (t) => [primaryKey({ name: 'pk_company_ad_domain', columns: [t.companyId, t.domainCode] })],
);

export const userCompany = gw.table(
  'user_company',
  {
    userId: int('user_id')
      .notNull()
      .references(() => user.userId),
    companyId: int('company_id')
      .notNull()
      .references(() => company.companyId),
    viaEmployeeNo: varchar('via_employee_no', { length: 20 }).notNull(),
    deptCode: varchar('dept_code', { length: 30 }),
    department: nvarchar('department', { length: 100 }),
    isVirtual: bit('is_virtual').notNull().default(false),
    isPrimary: bit('is_primary').notNull().default(false),
  },
  (t) => [primaryKey({ name: 'pk_user_company', columns: [t.userId, t.companyId, t.viaEmployeeNo] }), index('ix_user_company_company').on(t.companyId)],
);

export const roleCompany = gw.table(
  'role_company',
  {
    roleId: int('role_id')
      .notNull()
      .references(() => role.roleId),
    companyId: int('company_id')
      .notNull()
      .references(() => company.companyId),
    createdAt: createdAt(),
    createdBy: nvarchar('created_by', { length: 64 }).notNull(),
  },
  (t) => [primaryKey({ name: 'pk_role_company', columns: [t.roleId, t.companyId] })],
);

export const localCredential = gw.table(
  'local_credential',
  {
    userId: int('user_id')
      .primaryKey()
      .references(() => user.userId),
    passwordHash: varchar('password_hash', { length: 200 }),
    status: varchar('status', { length: 20 }).notNull(),
    failedCount: smallint('failed_count').notNull().default(0),
    lockedAt: datetime2('locked_at', { precision: 3 }),
    mustChangePassword: bit('must_change_password').notNull().default(false),
    passwordChangedAt: datetime2('password_changed_at', { precision: 3 }),
    passwordHistory: nvarchar('password_history', { length: 1000 }),
    registeredVia: varchar('registered_via', { length: 20 }).notNull(),
    legacyMigratedAt: datetime2('legacy_migrated_at', { precision: 3 }),
    approvedBy: nvarchar('approved_by', { length: 64 }),
    approvedAt: datetime2('approved_at', { precision: 3 }),
    managerNotifiedAt: datetime2('manager_notified_at', { precision: 3 }),
    ...auditColumns(),
  },
  (t) => [index('ix_local_credential_status').on(t.status)],
);

export const localAccountToken = gw.table(
  'local_account_token',
  {
    tokenId: int('token_id').identity().primaryKey(),
    userId: int('user_id')
      .notNull()
      .references(() => user.userId),
    purpose: varchar('purpose', { length: 20 }).notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    expiresAt: datetime2('expires_at', { precision: 3 }).notNull(),
    usedAt: datetime2('used_at', { precision: 3 }),
    createdIp: varchar('created_ip', { length: 45 }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_local_account_token_hash').on(t.tokenHash), index('ix_local_account_token_user_purpose').on(t.userId, t.purpose)],
);

/* ---------- §3.2 指派規則、部門樹、應用(v0.7) ---------- */

/** 部門樹(BPM OrganizationUnit,部門同步寫入) */
export const department = gw.table(
  'department',
  {
    deptCode: varchar('dept_code', { length: 30 }).primaryKey(),
    name: nvarchar('name', { length: 100 }).notNull(),
    parentDeptCode: varchar('parent_dept_code', { length: 30 }),
    companyId: int('company_id').references(() => company.companyId),
    bpmUnitOid: varchar('bpm_unit_oid', { length: 50 }),
    isEnabled: bit('is_enabled').notNull().default(true),
    syncedAt: datetime2('synced_at', { precision: 3 }).notNull(),
  },
  (t) => [index('ix_department_parent').on(t.parentDeptCode)],
);

/**
 * 部門權限(v0.12):直接授予部門的選單 / Tab / 按鈕權限,不經角色。
 * job_tier = 職級門檻代碼(all / section / manager / division,對照 rbac/job-tiers.ts);include_sub_depts 含下層部門。
 */
export const deptPermission = gw.table(
  'dept_permission',
  {
    deptCode: varchar('dept_code', { length: 30 })
      .notNull()
      .references(() => department.deptCode),
    permissionId: int('permission_id')
      .notNull()
      .references(() => permission.permissionId),
    jobTier: varchar('job_tier', { length: 20 }).notNull(),
    includeSubDepts: bit('include_sub_depts').notNull().default(true),
    createdAt: createdAt(),
    createdBy: nvarchar('created_by', { length: 64 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_dept_permission', columns: [t.deptCode, t.permissionId, t.jobTier] }),
    index('ix_dept_permission_permission').on(t.permissionId),
  ],
);

/** 個人權限(v0.12):直接授予個人的權限;valid_to NULL = 永久 */
export const userPermission = gw.table(
  'user_permission',
  {
    userId: int('user_id')
      .notNull()
      .references(() => user.userId),
    permissionId: int('permission_id')
      .notNull()
      .references(() => permission.permissionId),
    validTo: datetime2('valid_to', { precision: 3 }),
    reason: nvarchar('reason', { length: 200 }),
    createdAt: createdAt(),
    createdBy: nvarchar('created_by', { length: 64 }).notNull(),
  },
  (t) => [primaryKey({ name: 'pk_user_permission', columns: [t.userId, t.permissionId] }), index('ix_user_permission_permission').on(t.permissionId)],
);

/** 角色指派規則:同一規則內 AND、NULL = 不限;同一角色多條規則 OR */
export const roleRule = gw.table(
  'role_rule',
  {
    ruleId: int('rule_id').identity().primaryKey(),
    roleId: int('role_id')
      .notNull()
      .references(() => role.roleId),
    companyId: int('company_id').references(() => company.companyId),
    deptCode: varchar('dept_code', { length: 30 }),
    includeSubDepts: bit('include_sub_depts').notNull().default(true),
    /** 職級值 JSON 陣列,例 ["5","6"] */
    jobLevels: nvarchar('job_levels', { length: 200 }),
    title: nvarchar('title', { length: 100 }),
    description: nvarchar('description', { length: 200 }),
    isEnabled: bit('is_enabled').notNull().default(true),
    ...auditColumns(),
  },
  (t) => [index('ix_role_rule_role').on(t.roleId)],
);

/** 應用登記(PRD §8.3.3):/api/auth/me 的 apps */
export const app = gw.table(
  'app',
  {
    appId: int('app_id').identity().primaryKey(),
    code: varchar('code', { length: 30 }).notNull(),
    name: nvarchar('name', { length: 50 }).notNull(),
    basePath: varchar('base_path', { length: 100 }).notNull(),
    icon: varchar('icon', { length: 30 }),
    sort: smallint('sort').notNull().default(0),
    permissionCode: varchar('permission_code', { length: 100 }).notNull(),
    isEnabled: bit('is_enabled').notNull().default(true),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('uq_app_code').on(t.code)],
);
