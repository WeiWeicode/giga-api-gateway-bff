/*
  稽核表保存排程(IMPL-PLAN W3-1.6、DATABASE.md §0、§5、§8.5)— SQL Server 2012 Standard(不支援資料表分割,改以分批刪除)
  以 sa 於 Navicat 選 msdb 後執行;測試區(giganexus_gw_test)與正式區(giganexus_gw)各建一個作業(修改 @db 後再執行一次)。

  保存期限:
    gw.api_access_log        180 天
    gw.auth_log              1 年
    gw.employee_sync_run     1 年
    gw.local_account_token   逾期(expires_at)30 天
  gw.audit_log 至少保存 3 年,本作業不刪除。

  作法:每天 02:30 執行,每批 TOP (5000) 刪除、批次間 WAITFOR 1 秒,避免長時間鎖表與交易記錄暴增;
  稽核表依 occurred_at 叢集索引,刪除最舊的資料不影響新寫入。
  gw_app 只有 INSERT / SELECT(DENY DELETE),本作業以 SQL Agent 作業擁有者(sa)執行。
  SQL Server Agent 服務須為執行中;執行後於 SQL Server Agent → 作業 → 「GigaNexus 稽核表保存 - <資料庫>」→ 啟動作業 測試一次。
*/

USE [msdb];
GO

DECLARE @db SYSNAME = N'giganexus_gw_test';   -- 正式區改為 giganexus_gw
DECLARE @job SYSNAME = N'GigaNexus 稽核表保存 - ' + @db;
DECLARE @jobId UNIQUEIDENTIFIER;

-- 重新執行時先刪除同名作業(2012 不支援 DROP … IF EXISTS)
IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = @job)
  EXEC msdb.dbo.sp_delete_job @job_name = @job, @delete_unused_schedule = 1;

EXEC msdb.dbo.sp_add_job
  @job_name = @job,
  @enabled = 1,
  @description = N'IMPL-PLAN W3-1.6:api_access_log 180 天、auth_log 與 employee_sync_run 1 年、逾期 30 天的 local_account_token,分批刪除',
  @owner_login_name = N'sa',
  @job_id = @jobId OUTPUT;

EXEC msdb.dbo.sp_add_jobstep
  @job_id = @jobId,
  @step_name = N'分批刪除過期資料',
  @subsystem = N'TSQL',
  @database_name = @db,
  @retry_attempts = 1,
  @retry_interval = 10,
  @command = N'
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
DECLARE @batch INT = 5000, @n INT;
DECLARE @now DATETIME2(3) = SYSUTCDATETIME();

-- gw.api_access_log:180 天
SET @n = 1;
WHILE @n > 0
BEGIN
  DELETE TOP (@batch) FROM gw.api_access_log WHERE occurred_at < DATEADD(DAY, -180, @now);
  SET @n = @@ROWCOUNT;
  IF @n > 0 WAITFOR DELAY ''00:00:01'';
END;

-- gw.auth_log:1 年
SET @n = 1;
WHILE @n > 0
BEGIN
  DELETE TOP (@batch) FROM gw.auth_log WHERE occurred_at < DATEADD(YEAR, -1, @now);
  SET @n = @@ROWCOUNT;
  IF @n > 0 WAITFOR DELAY ''00:00:01'';
END;

-- gw.employee_sync_run:1 年(每小時一筆,量小,一次刪除)
DELETE FROM gw.employee_sync_run WHERE started_at < DATEADD(YEAR, -1, @now);

-- gw.local_account_token:逾期 30 天(驗證 / 啟用 / 重設連結)
SET @n = 1;
WHILE @n > 0
BEGIN
  DELETE TOP (@batch) FROM gw.local_account_token WHERE expires_at < DATEADD(DAY, -30, @now);
  SET @n = @@ROWCOUNT;
END;
';

EXEC msdb.dbo.sp_add_jobschedule
  @job_id = @jobId,
  @name = N'每天 02:30',
  @enabled = 1,
  @freq_type = 4,              -- 每天
  @freq_interval = 1,
  @active_start_time = 023000;

EXEC msdb.dbo.sp_add_jobserver @job_id = @jobId, @server_name = N'(local)';
GO

-- 確認作業與排程
SELECT j.name, j.enabled, s.name AS schedule_name, s.active_start_time
FROM msdb.dbo.sysjobs j
JOIN msdb.dbo.sysjobschedules js ON js.job_id = j.job_id
JOIN msdb.dbo.sysschedules s ON s.schedule_id = js.schedule_id
WHERE j.name LIKE N'GigaNexus 稽核表保存%';
GO
