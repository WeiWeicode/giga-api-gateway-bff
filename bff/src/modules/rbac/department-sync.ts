/**
 * 部門樹同步:BPM vw_gn_department → gw.department(PRD §8.3.1、DATABASE.md §3.2)。
 * worker 每小時執行(佇列 employee-sync,工作 departments),或 CLI `dept:sync` 手動執行。
 *
 *   新增 / 改名 / 改上層 / 重新出現 → upsert;BPM 已無 → is_enabled = 0(不刪除,規則仍可參照)
 *   樹結構有變(新增、上層變更、停用 / 啟用)→ 同一交易遞增全體 perm_version;只改名稱不影響權限
 *   安全檢查:BPM 回傳 0 筆,或一次要停用超過 10%(且多於 5 個)時中止,避免 view 異常清空部門樹
 */
import { eq } from 'drizzle-orm';
import type { GwDatabase } from '../../db/client.js';
import { bpmDepartment } from '../../db/external/index.js';
import { company, department } from '../../db/schema/index.js';
import type { ExternalDb } from '../../plugins/db.js';
import { bumpAllPermVersions } from './permission.js';

const MAX_CODE = 30;
const DISABLE_RATIO_LIMIT = 0.1;
const DISABLE_ABS_LIMIT = 5;

export interface DepartmentSyncResult {
  total: number;
  inserted: number;
  updated: number;
  disabled: number;
  skipped: number;
  treeChanged: boolean;
}

export class DepartmentSyncAborted extends Error {}

export async function syncDepartments(db: GwDatabase, bpm: ExternalDb, actor: string, opts: { force?: boolean } = {}): Promise<DepartmentSyncResult> {
  const source = await bpm.select().from(bpmDepartment);
  const result: DepartmentSyncResult = { total: source.length, inserted: 0, updated: 0, disabled: 0, skipped: 0, treeChanged: false };
  if (!source.length) throw new DepartmentSyncAborted('BPM vw_gn_department 沒有資料,中止同步');

  const incoming = new Map<string, { name: string; parent: string | null; orgName: string | null; unitOid: string | null }>();
  for (const d of source) {
    const code = d.deptCode?.trim();
    const parent = d.parentDeptCode?.trim() || null;
    if (!code || code.length > MAX_CODE || (parent && parent.length > MAX_CODE)) {
      result.skipped++;
      continue;
    }
    incoming.set(code, {
      name: (d.name?.trim() || code).slice(0, 100),
      parent: parent === code ? null : parent,
      orgName: d.orgName?.trim() || null,
      unitOid: d.unitOid,
    });
  }

  const companies = new Map((await db.select({ id: company.companyId, name: company.compName }).from(company)).map((c) => [c.name, c.id]));
  const existing = new Map((await db.select().from(department)).map((d) => [d.deptCode, d]));
  const toDisable = [...existing.values()].filter((d) => d.isEnabled && !incoming.has(d.deptCode));
  const enabledCount = [...existing.values()].filter((d) => d.isEnabled).length;
  if (!opts.force && toDisable.length > DISABLE_ABS_LIMIT && toDisable.length > enabledCount * DISABLE_RATIO_LIMIT)
    throw new DepartmentSyncAborted(`將停用 ${toDisable.length} / ${enabledCount} 個部門,超過安全上限,中止同步(確認無誤可加 --force)`);

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const [code, d] of incoming) {
      // BPM 組織名稱與 gw.company 公司名稱相同時才對應(公司以 LOS CompName 為準,PRD Q13)
      const v = {
        name: d.name,
        parentDeptCode: d.parent,
        companyId: d.orgName ? (companies.get(d.orgName) ?? null) : null,
        bpmUnitOid: d.unitOid,
        isEnabled: true,
        syncedAt: now,
      };
      const cur = existing.get(code);
      if (!cur) {
        await tx.insert(department).values({ deptCode: code, ...v });
        result.inserted++;
        result.treeChanged = true;
      } else if (
        cur.name !== v.name ||
        cur.parentDeptCode !== v.parentDeptCode ||
        cur.companyId !== v.companyId ||
        cur.bpmUnitOid !== v.bpmUnitOid ||
        !cur.isEnabled
      ) {
        if (cur.parentDeptCode !== v.parentDeptCode || !cur.isEnabled) result.treeChanged = true;
        await tx.update(department).set(v).where(eq(department.deptCode, code));
        result.updated++;
      }
    }
    // 未變更的部門只更新最後同步時間
    await tx.update(department).set({ syncedAt: now }).where(eq(department.isEnabled, true));
    for (const d of toDisable) {
      await tx.update(department).set({ isEnabled: false, syncedAt: now }).where(eq(department.deptCode, d.deptCode));
      result.disabled++;
      result.treeChanged = true;
    }
    if (result.treeChanged) await bumpAllPermVersions(tx, actor);
  });
  return result;
}
