/*
  LOS / 舊單一入口(PortalSolar)唯讀帳號與 view — SQL Server 2012(10.10.130.220,Navicat「開發平台」)
  以 sa 於 Navicat 選 master 後執行。欄位依 bff/src/db/external/los.ts、portal.ts(DATABASE.md §8.2、§9.1)。

  原則:
    - 帳號只授權 SELECT 指定 view,不可讀基底資料表(dbo 擁有的 view 經擁有權鏈結讀取基底表)
    - LOS view 不含個資欄位(ID、ID2、ID3、BossPID、BirthDate、Sex、PhoneNo、EmployeeCard、CPF39、CPF32、IsLeavePay)
    - PortalSolar view 不含 EName(舊註冊以明文寫入確認密碼)
  密碼請自行替換,不要寫回此檔。
*/

-- ============================================================
-- 0. 先確認 LOS 欄位型別(結果決定第 2 段 JobDate / LeaveDate / IsVUser 的寫法)
-- ============================================================
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM [LOS].INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'EmployeeInfo'
  AND COLUMN_NAME IN ('UserID','UserName','EMail','CompName','CompFullName','CompDB','EFDept','EFDeptName',
                      'JobName','JobLevel','BossID','BossEMail','JobDate','LeaveDate','IsVUser');
GO

-- ============================================================
-- 1. 登入帳號
-- ============================================================
CREATE LOGIN [los_reader]    WITH PASSWORD = N'<請自訂強密碼>', DEFAULT_DATABASE = [LOS],         CHECK_POLICY = ON;
CREATE LOGIN [portal_reader] WITH PASSWORD = N'<請自訂強密碼>', DEFAULT_DATABASE = [PortalSolar], CHECK_POLICY = ON;
GO

-- ============================================================
-- 2. LOS:view + 唯讀使用者
-- ============================================================
USE [LOS];
GO
/*
  JobDate / LeaveDate:BFF 以 d/M/yyyy 字串解析(profile.ts parseLosDate,允許前導 0)。
    - 第 0 段顯示為 nvarchar / varchar → 維持下方寫法
    - 顯示為 datetime / date → 改為 CONVERT(varchar(10), JobDate, 103) AS JobDate(LeaveDate 同理)
  IsVUser:BFF 需要 bit 且不可為 NULL;若第 0 段顯示為字元型(如 'Y'/'N'),改為 CASE WHEN IsVUser = 'Y' THEN 1 ELSE 0 END
*/
CREATE VIEW [dbo].[vw_gn_employee]
AS
SELECT
    UserID,
    UserName,
    EMail,
    CompName,
    CompFullName,
    CompDB,
    EFDept,
    EFDeptName,
    JobName,
    JobLevel,
    BossID,
    BossEMail,
    CONVERT(varchar(10), JobDate, 103)   AS JobDate,    -- 實際型別為 date(2026-09-30 確認),轉為 dd/MM/yyyy
    CONVERT(varchar(10), LeaveDate, 103) AS LeaveDate,
    ISNULL(CAST(IsVUser AS bit), 0) AS IsVUser
FROM [dbo].[EmployeeInfo];
GO
CREATE USER [los_reader] FOR LOGIN [los_reader];
GRANT SELECT ON [dbo].[vw_gn_employee] TO [los_reader];
GO

-- ============================================================
-- 3. PortalSolar:view + 唯讀使用者
-- ============================================================
USE [PortalSolar];
GO
CREATE VIEW [dbo].[vw_gn_login_data]
AS
SELECT PID, PNum, CName, Certify
FROM [dbo].[LoginData];
GO
CREATE USER [portal_reader] FOR LOGIN [portal_reader];
GRANT SELECT ON [dbo].[vw_gn_login_data] TO [portal_reader];
GO

-- ============================================================
-- 4. 驗證(sa 執行;模擬唯讀帳號,應讀得到 view、讀不到基底表)
-- ============================================================
USE [LOS];
GO
EXECUTE AS USER = 'los_reader';
SELECT TOP 5 UserID, UserName, CompName, JobDate, LeaveDate, IsVUser FROM dbo.vw_gn_employee;
SELECT HAS_PERMS_BY_NAME('dbo.EmployeeInfo', 'OBJECT', 'SELECT') AS can_read_base_table;  -- 應為 0
REVERT;
GO
USE [PortalSolar];
GO
EXECUTE AS USER = 'portal_reader';
SELECT COUNT(*) AS login_rows FROM dbo.vw_gn_login_data;
SELECT HAS_PERMS_BY_NAME('dbo.LoginData', 'OBJECT', 'SELECT') AS can_read_base_table;       -- 應為 0
REVERT;
GO
