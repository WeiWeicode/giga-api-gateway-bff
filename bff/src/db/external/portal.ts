/**
 * 舊單一入口 `PortalSolar.LoginData` 唯讀 view(SQL Server 2012)— 只在舊帳號首次登入時讀取(DATABASE.md §9)。
 * view 不含 EName(舊註冊以明文寫入確認密碼)。
 */
import { mssqlView, nvarchar } from 'drizzle-orm/mssql-core';

export const portalLoginData = mssqlView('vw_gn_login_data', {
  pid: nvarchar('PID', { length: 50 }).notNull(),
  pnum: nvarchar('PNum', { length: 50 }),
  cname: nvarchar('CName', { length: 50 }),
  certify: nvarchar('Certify', { length: 50 }),
}).existing();
