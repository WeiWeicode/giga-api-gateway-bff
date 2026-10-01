/*
  BPM(EFGP)部門樹:授權 Gateway 唯讀帳號讀取組織資料表 — SQL Server 2019(10.10.130.190,資料庫 NaNa)
  主管決定不在 BPM 新增 table / view(2026-10-01),Gateway 改以 bpm_reader 直接查詢這兩張表
  (欄位與 JOIN 同 GeneralBackend controllers/GeneralControlle.js 已驗證的查詢;PRD §8.3.1 部門含下層)。
  只授予 SELECT,不新增任何物件。以 sa 於 Navicat 選 NaNa 後執行;執行前請先知會 BPM 負責人。
  授權後在開發機執行 npm run gw -- dept:sync 驗證;測試區 worker 每小時自動同步。
*/

USE [NaNa];
GO

GRANT SELECT ON [dbo].[OrganizationUnit] TO [bpm_reader];
GRANT SELECT ON [dbo].[Organization] TO [bpm_reader];
GO
