/*
  BPM(EFGP)唯讀帳號與 view — SQL Server 2019(10.10.130.190,Navicat「BPM 190正式區」,資料庫 NaNa)
  以 sa 於 Navicat 選 master 後執行。欄位依 bff/src/db/external/bpm.ts(DATABASE.md §8.2)。
  JOIN 與主管邏輯沿用 GeneralBackend controllers/GeneralControlle.js 已驗證的查詢(REFERENCES.md §1.2),差異:
    - 包含已離職人員(不過濾 leaveDate):同步需要據此標記 resigned
    - 單位主管、職稱改 LEFT JOIN:單位未設主管時不漏掉該員工
    - 另 LEFT JOIN FunctionLevel 取職級(Functions.approvalLevelOID)
  NaNa 是 BPM 系統資料庫,建立 view 前請先知會 BPM 負責人。
  密碼請自行替換,不要寫回此檔。
*/

-- ============================================================
-- 1. 登入帳號
-- ============================================================
CREATE LOGIN [bpm_reader] WITH PASSWORD = N'<請自訂強密碼>', DEFAULT_DATABASE = [NaNa], CHECK_POLICY = ON;
GO

USE [NaNa];
GO

-- ============================================================
-- 2. view(每人只取主要任職 isMain = 1)
-- ============================================================
CREATE VIEW [dbo].[vw_gn_employee]
AS
SELECT
    EFGP_USER.id                                AS employee_no,
    EFGP_USER.userName                          AS display_name,
    EFGP_USER.mailAddress                       AS email,
    ORG_UNIT.id                                 AS dept_code,
    ORG_UNIT.organizationUnitName               AS department,
    org.organizationName                        AS org_name,
    FunDef.functionDefinitionName               AS title,
    CAST(FunLevel.levelValue AS nvarchar(10))   AS job_level,
    CASE
        WHEN ISNULL(SpecBoss.id, Boss.id) = EFGP_USER.id THEN
            CASE WHEN UpBoss.id <> EFGP_USER.id THEN UpBoss.id ELSE Up2Boss.id END
        ELSE ISNULL(SpecBoss.id, Boss.id)
    END                                         AS manager_employee_no,
    EFGP_USER.leaveDate                         AS leave_date
FROM dbo.Users AS EFGP_USER
    INNER JOIN dbo.Functions AS Fun              ON Fun.occupantOID = EFGP_USER.OID AND Fun.isMain = 1
    INNER JOIN dbo.OrganizationUnit AS ORG_UNIT  ON ORG_UNIT.OID = Fun.organizationUnitOID
    INNER JOIN dbo.Organization AS org           ON org.OID = ORG_UNIT.organizationOID
    LEFT OUTER JOIN dbo.FunctionDefinition AS FunDef ON FunDef.OID = Fun.definitionOID
    LEFT OUTER JOIN dbo.FunctionLevel AS FunLevel    ON FunLevel.OID = Fun.approvalLevelOID
    LEFT OUTER JOIN dbo.Users AS Boss            ON Boss.OID = ORG_UNIT.managerOID
    LEFT OUTER JOIN dbo.Users AS SpecBoss        ON SpecBoss.OID = Fun.specifiedManagerOID
    LEFT OUTER JOIN dbo.OrganizationUnit AS UP_UNIT  ON UP_UNIT.OID = ORG_UNIT.superUnitOID
    LEFT OUTER JOIN dbo.Users AS UpBoss          ON UpBoss.OID = UP_UNIT.managerOID
    LEFT OUTER JOIN dbo.OrganizationUnit AS UP2_UNIT ON UP2_UNIT.OID = UP_UNIT.superUnitOID
    LEFT OUTER JOIN dbo.Users AS Up2Boss         ON Up2Boss.OID = UP2_UNIT.managerOID;
GO

-- ============================================================
-- 3. 唯讀使用者
-- ============================================================
CREATE USER [bpm_reader] FOR LOGIN [bpm_reader];
GRANT SELECT ON [dbo].[vw_gn_employee] TO [bpm_reader];
GO

-- ============================================================
-- 4. 驗證
-- ============================================================
EXECUTE AS USER = 'bpm_reader';
SELECT TOP 5 * FROM dbo.vw_gn_employee WHERE leave_date IS NULL ORDER BY employee_no;
-- 同一工號出現多筆 = 有多個 isMain = 1 的任職,需與 BPM 負責人確認
SELECT employee_no, COUNT(*) AS n FROM dbo.vw_gn_employee GROUP BY employee_no HAVING COUNT(*) > 1;
SELECT HAS_PERMS_BY_NAME('dbo.Users', 'OBJECT', 'SELECT') AS can_read_base_table;  -- 應為 0
REVERT;
GO
