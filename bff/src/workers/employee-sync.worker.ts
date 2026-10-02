/**
 * 人事同步佇列(employee-sync,DATABASE.md §6、§8.3):
 *   departments  部門樹(BPM OrganizationUnit,P2-3a),每小時
 *   employees    人員(BPM > LOS → gw.user,W3-4.6b),每小時;管理 API 手動觸發時帶入已建立的 runId
 * worker concurrency 1:同一時間只執行一個同步工作。BPM / LOS 連線池於第一次使用時建立,連不上時下一次再試。
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { AppConfig, SqlSourceConfig } from '../config.js';
import { openPool, type GwDatabase } from '../db/client.js';
import { createExternalDb } from '../db/external/index.js';
import { consecutiveSourceFailures, createSyncRun, syncEmployees } from '../modules/auth/employee-sync.js';
import { DepartmentSyncAborted, syncDepartments } from '../modules/rbac/department-sync.js';
import type { PermissionService } from '../modules/rbac/permission.js';
import type { ExternalDb } from '../plugins/db.js';
import type { EmployeeSyncJob } from '../plugins/queues.js';
import type { Alert } from './alert.js';

type Pool = Awaited<ReturnType<typeof openPool>>;

export function createEmployeeSyncProcessor(deps: { db: GwDatabase; config: AppConfig; perms: PermissionService; alert: Alert; log: Logger }) {
  const { db, config, perms, alert, log } = deps;
  const pools: { bpm?: Pool; los?: Pool } = {};

  /** 開啟(或沿用)外部唯讀連線池;失敗時回傳原因,本次同步視為該來源失敗 */
  async function source(name: 'bpm' | 'los', src: SqlSourceConfig | undefined): Promise<ExternalDb | string | undefined> {
    if (!src) return undefined;
    try {
      pools[name] ??= await openPool(src, { appName: `giganexus-worker-${name}`, poolMax: 2, connectTimeoutMs: 5_000, requestTimeoutMs: 60_000 });
      // LOS 在 SQL Server 2012:套用 2012 語法檢查;BPM 為 2019
      return createExternalDb(pools[name], name === 'los' ? config.sql2012Guard : 'off');
    } catch (err) {
      return `${name.toUpperCase()} 無法連線:${(err as Error).message}`;
    }
  }

  async function departments() {
    const bpm = await source('bpm', config.bpmDb);
    if (!bpm) return;
    if (typeof bpm === 'string') throw new Error(bpm);
    try {
      const r = await syncDepartments(db, bpm, 'system:dept-sync');
      if (r.treeChanged) await perms.invalidatePv('all');
      log.info(r, '部門樹同步完成');
      return r;
    } catch (err) {
      // 安全檢查中止:告警;下一次排程再比對
      if (err instanceof DepartmentSyncAborted) await alert('dept-sync-aborted', '部門樹同步中止', [err.message]);
      throw err;
    }
  }

  async function employees(job: Job<EmployeeSyncJob>) {
    const [bpm, los] = await Promise.all([source('bpm', config.bpmDb), source('los', config.losDb)]);
    const runId = job.data.runId ?? (await createSyncRun(db, 'schedule', null));
    const r = await syncEmployees(
      db,
      { bpm: typeof bpm === 'string' ? undefined : bpm, los: typeof los === 'string' ? undefined : los },
      {
        runId,
        actor: 'system:employee-sync',
        unavailable: { bpm: typeof bpm === 'string' ? bpm : undefined, los: typeof los === 'string' ? los : undefined },
      },
    );
    if (r.pvBumped.length) await perms.invalidatePv(r.pvBumped).catch((err: Error) => log.warn({ err: err.message }, 'pv 快取清除失敗(15 分鐘內自然過期)'));
    const { resigned, newCompanies, orphans, pvBumped, ...summary } = r;
    log.info({ runId, ...summary, pvBumped: pvBumped.length }, '人員同步完成');
    const detail = (r.errorMessage ?? '').split('\n').filter(Boolean);

    if (r.status === 'aborted') await alert('employee-sync-aborted', '人員同步中止(來源筆數異常,未寫入)', [`同步紀錄 #${runId}`, ...detail]);
    if ((r.status === 'partial' || r.status === 'failed') && (await consecutiveSourceFailures(db)))
      await alert('employee-sync-source', '人員同步連續 3 次未完整成功(BPM / LOS 讀取失敗)', [`同步紀錄 #${runId}`, ...detail], { throttleSec: 6 * 3600 });
    // 離職只標記不停用(PRD Q10)、新公司預設無網域:通知 IT 處理
    if (resigned.length || newCompanies.length)
      await alert(
        `employee-sync-notice:${runId}`,
        '人員同步:新標記離職 / 新增公司',
        [
          resigned.length ? `新標記離職(帳號未停用,請確認):${resigned.join(', ')}` : '',
          newCompanies.length ? `新增公司(預設無 AD 網域,請於管理介面設定):${newCompanies.join(', ')}` : '',
        ].filter(Boolean),
      );
    if (orphans.length) await alert('employee-sync-orphans', '人員同步:兼任帳號找不到本人', [orphans.join(', ')], { throttleSec: 24 * 3600 });
    if (r.status === 'failed') throw new Error(r.errorMessage ?? '人員同步失敗');
    return { runId, ...summary };
  }

  const processor = async (job: Job<EmployeeSyncJob>) => {
    if (job.name === 'departments') return departments();
    if (job.name === 'employees') return employees(job);
    log.warn({ name: job.name }, '未知的人事同步工作');
  };
  const close = async () => {
    await Promise.all(Object.values(pools).map((p) => p.close().catch(() => undefined)));
  };
  return { processor, close };
}
