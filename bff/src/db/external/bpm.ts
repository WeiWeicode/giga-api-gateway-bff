/**
 * BPM(EFGP,SQL Server 2019)唯讀 view — 主要人事資料來源(DATABASE.md §8.1–§8.2)。
 * view 由 BPM 負責人提供(P-12);欄位以本機模擬的 dbo.vw_gn_employee 為暫定,確定後更新。
 * drizzle-kit 不處理此檔(不產生、不執行 migration)。
 */
import { datetime, mssqlTable, mssqlView, nvarchar } from 'drizzle-orm/mssql-core';

export const bpmEmployee = mssqlView('vw_gn_employee', {
  employeeNo: nvarchar('employee_no', { length: 50 }).notNull(),
  displayName: nvarchar('display_name', { length: 100 }),
  email: nvarchar('email', { length: 200 }),
  deptCode: nvarchar('dept_code', { length: 50 }),
  department: nvarchar('department', { length: 100 }),
  orgName: nvarchar('org_name', { length: 100 }),
  title: nvarchar('title', { length: 100 }),
  jobLevel: nvarchar('job_level', { length: 10 }),
  managerEmployeeNo: nvarchar('manager_employee_no', { length: 50 }),
  leaveDate: datetime('leave_date'),
}).existing();

/**
 * 部門樹的來源:EFGP 組織資料表(PRD §8.3.1、DATABASE.md §3.2)。
 * 主管決定不在 BPM 新增 table / view,改由 DBA 授權 bpm_reader 唯讀這兩張表(db/dba/03-bpm-org-grant.sql);欄位同 GeneralBackend 已驗證的查詢。
 */
export const bpmOrganizationUnit = mssqlTable('OrganizationUnit', {
  oid: nvarchar('OID', { length: 50 }).notNull(),
  id: nvarchar('id', { length: 50 }).notNull(),
  name: nvarchar('organizationUnitName', { length: 100 }),
  superUnitOid: nvarchar('superUnitOID', { length: 50 }),
  organizationOid: nvarchar('organizationOID', { length: 50 }),
});

export const bpmOrganization = mssqlTable('Organization', {
  oid: nvarchar('OID', { length: 50 }).notNull(),
  name: nvarchar('organizationName', { length: 100 }),
});
