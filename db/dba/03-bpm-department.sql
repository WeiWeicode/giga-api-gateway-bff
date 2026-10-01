/*
  BPM(EFGP)部門樹唯讀 view — SQL Server 2019(10.10.130.190,資料庫 NaNa)
  Gateway 部門同步(gw.department,PRD §8.3.1 指派規則「部門含下層」)使用。欄位依 bff/src/db/external/bpm.ts 的 bpmDepartment。
  以 sa 於 Navicat 選 NaNa 後執行;NaNa 是 BPM 系統資料庫,建立 view 前請先知會 BPM 負責人。
  dept_code 與 vw_gn_employee.dept_code 同為 OrganizationUnit.id,兩者可直接對應。
*/

USE [NaNa];
GO

CREATE VIEW [dbo].[vw_gn_department]
AS
SELECT
    ORG_UNIT.id                       AS dept_code,
    ORG_UNIT.organizationUnitName     AS dept_name,
    UP_UNIT.id                        AS parent_dept_code,
    org.organizationName              AS org_name,
    CAST(ORG_UNIT.OID AS nvarchar(50)) AS unit_oid
FROM dbo.OrganizationUnit AS ORG_UNIT
    INNER JOIN dbo.Organization AS org              ON org.OID = ORG_UNIT.organizationOID
    LEFT OUTER JOIN dbo.OrganizationUnit AS UP_UNIT ON UP_UNIT.OID = ORG_UNIT.superUnitOID;
GO

GRANT SELECT ON [dbo].[vw_gn_department] TO [bpm_reader];
GO
