/**
 * LOS `EmployeeInfo` 唯讀 view(SQL Server 2012)— 補充來源、公司歸屬、兼任帳號(DATABASE.md §8.2)。
 * view 不含個資欄位(ID、BirthDate、Sex、PhoneNo…);日期欄位為 d/M/yyyy 字串,需以固定格式解析。
 */
import { bit, mssqlView, nvarchar } from 'drizzle-orm/mssql-core';

export const losEmployee = mssqlView('vw_gn_employee', {
  userId: nvarchar('UserID', { length: 20 }).notNull(),
  userName: nvarchar('UserName', { length: 50 }),
  email: nvarchar('EMail', { length: 100 }),
  compName: nvarchar('CompName', { length: 20 }),
  compFullName: nvarchar('CompFullName', { length: 100 }),
  compDb: nvarchar('CompDB', { length: 20 }),
  efDept: nvarchar('EFDept', { length: 30 }),
  efDeptName: nvarchar('EFDeptName', { length: 100 }),
  jobName: nvarchar('JobName', { length: 50 }),
  jobLevel: nvarchar('JobLevel', { length: 10 }),
  bossId: nvarchar('BossID', { length: 20 }),
  bossEmail: nvarchar('BossEMail', { length: 100 }),
  jobDate: nvarchar('JobDate', { length: 10 }),
  leaveDate: nvarchar('LeaveDate', { length: 10 }),
  isVUser: bit('IsVUser').notNull(),
}).existing();
