/*
  M0 正式複驗用的整合測試庫(IMPL-PLAN §2 M0、COMPANY-ENV-PLAN §6)— SQL Server 2012(10.10.130.220,Navicat「開發平台」)
  以 sa 於 Navicat 選 master 後執行一次。

  為什麼要另建:`npm run test:int` 每次執行會清空並重建 GW_TEST_DB_NAME 的 schema gw(scripts/reset-test-db.ts),
  不可指向測試區正在使用的 giganexus_gw_test。名稱必須含 `_test`(reset-test-db.ts 的防呆)。

  帳號沿用測試區的 gw_app / gw_migrate(LOGIN 已存在),權限與 giganexus_gw_test 相同:
    - gw_migrate:db_ddladmin + schema gw / drizzle CONTROL(建表、清空重建)
    - gw_app:經 gw_app_role 讀寫 schema gw;稽核表的 DENY UPDATE, DELETE 由 migration 檔尾自行加上
  執行後在開發機 bff/.env 設 GW_TEST_DB_NAME=giganexus_gw_poc_test,再 `npm run test:int`。
*/

CREATE DATABASE [giganexus_gw_poc_test];
GO
ALTER DATABASE [giganexus_gw_poc_test] SET COMPATIBILITY_LEVEL = 110;
GO

USE [giganexus_gw_poc_test];
GO
CREATE SCHEMA [gw] AUTHORIZATION [dbo];
GO
CREATE SCHEMA [drizzle] AUTHORIZATION [dbo];
GO

CREATE USER [gw_migrate] FOR LOGIN [gw_migrate];
EXEC sp_addrolemember N'db_ddladmin', N'gw_migrate';
GRANT CONTROL ON SCHEMA::[gw] TO [gw_migrate];
GRANT CONTROL ON SCHEMA::[drizzle] TO [gw_migrate];
GO

CREATE ROLE [gw_app_role];
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::[gw] TO [gw_app_role];
CREATE USER [gw_app] FOR LOGIN [gw_app];
EXEC sp_addrolemember N'gw_app_role', N'gw_app';
GO

-- 確認
SELECT name, compatibility_level FROM sys.databases WHERE name = N'giganexus_gw_poc_test';
SELECT r.name AS role_name, m.name AS member
FROM sys.database_role_members rm
JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id;
GO
