/**
 * BPM(EFGP,SQL Server 2019)唯讀 view — 主要人事資料來源(DATABASE.md §8.1–§8.2)。
 * view 由 BPM 負責人提供(P-12);欄位以本機模擬的 dbo.vw_gn_employee 為暫定,確定後更新。
 * drizzle-kit 不處理此檔(不產生、不執行 migration)。
 */
import { datetime, mssqlView, nvarchar } from 'drizzle-orm/mssql-core';

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
 * 部門樹(BPM OrganizationUnit 與上層單位)— gw.department 的來源(PRD §8.3.1、DATABASE.md §3.2)。
 * view 由 db/dba/03-bpm-department.sql 建立(需 BPM 負責人同意)。
 */
export const bpmDepartment = mssqlView('vw_gn_department', {
  deptCode: nvarchar('dept_code', { length: 50 }).notNull(),
  name: nvarchar('dept_name', { length: 100 }),
  parentDeptCode: nvarchar('parent_dept_code', { length: 50 }),
  orgName: nvarchar('org_name', { length: 100 }),
  unitOid: nvarchar('unit_oid', { length: 50 }),
}).existing();
