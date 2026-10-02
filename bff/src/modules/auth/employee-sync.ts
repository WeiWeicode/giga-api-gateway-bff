/**
 * 人員排程同步(DATABASE.md §8.2–§8.3、§8.5、W3-4.6b):BPM(主)+ LOS(補充)→ gw.user / gw.company / gw.user_company。
 * worker 每小時執行(佇列 employee-sync,工作 employees),或管理 API / CLI 手動觸發。
 *
 *   並行讀取 BPM vw_gn_employee 與 LOS vw_gn_employee(全量)
 *   安全檢查:任一來源回傳 0 筆,或比上次成功同步少 20% 以上 → 中止不寫入(aborted)
 *   以工號合併(BPM > LOS,與登入補查同一套 mergeProfile),兼任帳號以字尾比對併入本人(取最長相符者)
 *   以 profile_hash 比對,只寫入有變更者;每 200 人一個交易;部門、職稱、職級、狀態或公司變更 → 該使用者 perm_version + 1
 *   某一來源讀取失敗(partial):只以另一來源有值的欄位更新,不清空既有欄位、不改所屬公司,也不新增使用者
 *   離職(employment_status → resigned)只標記不停用(PRD Q10),由呼叫端通知 IT;遇到新公司自動建立(無網域),由呼叫端通知 IT
 *   已離職且尚未存在的工號不建立使用者;不在來源中的既有使用者不處理
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { GwDatabase } from '../../db/client.js';
import { bpmEmployee, losEmployee } from '../../db/external/index.js';
import { company, employeeSyncRun, user } from '../../db/schema/index.js';
import type { ExternalDb } from '../../plugins/db.js';
import { applyProfile, isValidEmpNo, mergeProfile, normalizeEmpNo, parseLosDate, profileHash, type EmployeeLookup } from './profile.js';

type BpmRow = typeof bpmEmployee.$inferSelect;
type LosRow = typeof losEmployee.$inferSelect;

const BATCH_SIZE = 200;
/** 比上次成功同步少超過此比例即中止 */
const DROP_LIMIT = 0.2;
const MAX_LISTED = 50;

export class EmployeeSyncAborted extends Error {}

export interface GroupedEmployees {
  /** 實體工號 → BPM / LOS 資料與兼任帳號 */
  people: Map<string, { bpm: BpmRow | null; los: LosRow | null; virtuals: LosRow[] }>;
  /** 兼任帳號與其本人工號 */
  virtuals: { emp: string; base: string; row: LosRow }[];
  /** 字尾比對不到本人的兼任帳號 */
  orphans: string[];
  invalid: number;
}

/**
 * 以工號合併兩個來源;兼任帳號(LOS IsVUser = 1)以字尾比對本人實體工號,取最長相符者(DATABASE.md §8.2)。
 *   - 是否為兼任帳號以 LOS 為準:BPM 也會把兼任工號列為一般人員(例 Q105133),這些工號不當作本人
 *   - LOS 同一兼任工號可能有多筆(不同公司,例 EG105133 芯和 / 國碩):只建一個兼任帳號,各筆公司都併入本人
 */
export function groupEmployees(bpmRows: BpmRow[], losRows: LosRow[]): GroupedEmployees {
  const people: GroupedEmployees['people'] = new Map();
  let invalid = 0;
  const person = (emp: string) => {
    let p = people.get(emp);
    if (!p) people.set(emp, (p = { bpm: null, los: null, virtuals: [] }));
    return p;
  };
  const virtualRows = new Map<string, LosRow[]>();
  for (const r of losRows) {
    const emp = normalizeEmpNo(r.userId ?? '');
    if (!isValidEmpNo(emp)) invalid++;
    else if (r.isVUser) virtualRows.set(emp, [...(virtualRows.get(emp) ?? []), r]);
    else person(emp).los = r;
  }
  for (const r of bpmRows) {
    const emp = normalizeEmpNo(r.employeeNo ?? '');
    if (!isValidEmpNo(emp)) invalid++;
    else if (!virtualRows.has(emp) || people.has(emp)) person(emp).bpm = r;
  }
  const physical = [...people.keys()].sort((a, b) => b.length - a.length);
  const virtuals: GroupedEmployees['virtuals'] = [];
  const orphans: string[] = [];
  for (const [emp, rows] of virtualRows) {
    // LOS 也有同一工號的實體帳號時以實體帳號為準
    if (people.has(emp)) continue;
    const base = physical.find((p) => p.length < emp.length && emp.endsWith(p));
    if (!base) {
      orphans.push(emp);
      continue;
    }
    people.get(base)!.virtuals.push(...rows);
    // 兼任帳號本身的資料:優先取未離職的那筆
    virtuals.push({ emp, base, row: rows.find((x) => !parseLosDate(x.leaveDate)) ?? rows[0]! });
  }
  return { people, virtuals, orphans, invalid };
}

export interface EmployeeSyncResult {
  status: 'success' | 'partial' | 'aborted' | 'failed';
  bpmRows: number | null;
  losRows: number | null;
  created: number;
  updated: number;
  unchanged: number;
  resignedFlagged: number;
  /** 本次新標記離職的工號 */
  resigned: string[];
  newCompanies: string[];
  orphans: string[];
  /** perm_version 已遞增的使用者(提交後清除 pv 快取) */
  pvBumped: number[];
  errorMessage: string | null;
}

/** 安全檢查(DATABASE.md §8.3):回傳中止原因,通過時回 null */
export function checkSourceCount(name: string, rows: number, previous: number | null): string | null {
  if (rows === 0) return `${name} 回傳 0 筆`;
  if (previous && rows < previous * (1 - DROP_LIMIT)) return `${name} 回傳 ${rows} 筆,比上次成功同步(${previous} 筆)少 20% 以上`;
  return null;
}

const listed = (label: string, items: string[]) =>
  items.length ? `${label} ${items.length} 筆:${items.slice(0, MAX_LISTED).join(', ')}${items.length > MAX_LISTED ? '…' : ''}` : null;

/**
 * 執行一次同步並更新 gw.employee_sync_run(runId 由呼叫端先建立)。
 * 中止與失敗時不丟例外,回傳結果由呼叫端告警。
 */
export async function syncEmployees(
  db: GwDatabase,
  ext: { bpm?: ExternalDb; los?: ExternalDb },
  opts: { runId: number; actor: string; force?: boolean; unavailable?: { bpm?: string; los?: string } },
): Promise<EmployeeSyncResult> {
  const result: EmployeeSyncResult = {
    status: 'success',
    bpmRows: null,
    losRows: null,
    created: 0,
    updated: 0,
    unchanged: 0,
    resignedFlagged: 0,
    resigned: [],
    newCompanies: [],
    orphans: [],
    pvBumped: [],
    errorMessage: null,
  };
  const messages: string[] = [];
  await db.update(employeeSyncRun).set({ status: 'running', startedAt: new Date() }).where(eq(employeeSyncRun.runId, opts.runId));
  try {
    const [bpmRes, losRes] = await Promise.allSettled([
      ext.bpm ? ext.bpm.select().from(bpmEmployee) : Promise.reject(new Error(opts.unavailable?.bpm ?? 'BPM 未設定')),
      ext.los ? ext.los.select().from(losEmployee) : Promise.reject(new Error(opts.unavailable?.los ?? 'LOS 未設定')),
    ]);
    const bpmRows = bpmRes.status === 'fulfilled' ? bpmRes.value : null;
    const losRows = losRes.status === 'fulfilled' ? losRes.value : null;
    result.bpmRows = bpmRows?.length ?? null;
    result.losRows = losRows?.length ?? null;
    if (bpmRes.status === 'rejected') messages.push(`BPM 讀取失敗:${(bpmRes.reason as Error).message}`);
    if (losRes.status === 'rejected') messages.push(`LOS 讀取失敗:${(losRes.reason as Error).message}`);
    if (!bpmRows && !losRows) {
      result.status = 'failed';
      return result;
    }
    const partial = !bpmRows || !losRows;

    // 安全檢查:與上次成功(含 partial)同步的各來源筆數比較
    const [prev] = await db
      .select({ bpmRows: employeeSyncRun.bpmRows, losRows: employeeSyncRun.losRows })
      .top(1)
      .from(employeeSyncRun)
      .where(and(inArray(employeeSyncRun.status, ['success', 'partial']), ne(employeeSyncRun.runId, opts.runId)))
      .orderBy(desc(employeeSyncRun.runId));
    const problems = [
      bpmRows ? checkSourceCount('BPM', bpmRows.length, prev?.bpmRows ?? null) : null,
      losRows ? checkSourceCount('LOS', losRows.length, prev?.losRows ?? null) : null,
    ].filter((x): x is string => !!x);
    if (problems.length && !opts.force) {
      result.status = 'aborted';
      messages.push(...problems, '已中止,未寫入(確認來源無誤可加 --force 手動執行)');
      return result;
    }

    const grouped = groupEmployees(bpmRows ?? [], losRows ?? []);
    result.orphans = grouped.orphans;
    const existing = new Map(
      (
        await db
          .select({
            userId: user.userId,
            employeeNo: user.employeeNo,
            profileHash: user.profileHash,
            employmentStatus: user.employmentStatus,
            isVirtual: user.isVirtual,
            baseEmployeeNo: user.baseEmployeeNo,
            displayName: user.displayName,
            email: user.email,
          })
          .from(user)
      ).map((u) => [u.employeeNo, u]),
    );
    const companiesBefore = new Set((await db.select({ name: company.compName }).from(company)).map((c) => c.name));

    type Job = { emp: string; kind: 'person' } | { emp: string; kind: 'virtual'; base: string; row: LosRow };
    const jobs: Job[] = [
      ...[...grouped.people.keys()].sort().map((emp) => ({ emp, kind: 'person' as const })),
      ...grouped.virtuals.map((v) => ({ emp: v.emp, kind: 'virtual' as const, base: v.base, row: v.row })),
    ];

    // 同一工號在一次同步中只處理一次(避免同一批重複新增,違反 uq_user_employee_no)
    const done = new Set<string>();
    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
      await db.transaction(async (tx) => {
        for (const job of jobs.slice(i, i + BATCH_SIZE)) {
          if (done.has(job.emp)) continue;
          done.add(job.emp);
          const cur = existing.get(job.emp);
          if (job.kind === 'virtual') {
            // 兼任帳號只記錄身分(不可單獨登入,Q16);公司與部門已併入本人
            const r = job.row;
            const values = {
              isVirtual: true,
              baseEmployeeNo: job.base,
              displayName: r.userName?.trim() || job.emp,
              email: r.email?.trim() || null,
              employmentStatus: parseLosDate(r.leaveDate) ? 'resigned' : 'active',
            };
            if (!cur) {
              if (partial || values.employmentStatus === 'resigned') continue;
              await tx
                .insert(user)
                .values({ employeeNo: job.emp, ...values, profileSource: 'los', profileSyncedAt: new Date(), createdBy: opts.actor, updatedBy: opts.actor });
              result.created++;
            } else if (
              !cur.isVirtual ||
              cur.baseEmployeeNo !== values.baseEmployeeNo ||
              cur.displayName !== values.displayName ||
              cur.email !== values.email ||
              cur.employmentStatus !== values.employmentStatus
            ) {
              await tx
                .update(user)
                .set({ ...values, profileSource: 'los', profileSyncedAt: new Date(), updatedBy: opts.actor, permVersion: sql`${user.permVersion} + 1` })
                .where(eq(user.userId, cur.userId));
              result.updated++;
              result.pvBumped.push(cur.userId);
            } else result.unchanged++;
            continue;
          }

          const src = grouped.people.get(job.emp)!;
          const lookup: EmployeeLookup = { ...src, selfVirtual: false, bpmOk: !!bpmRows, losOk: !!losRows };
          const merged = mergeProfile(lookup);
          if (!cur) {
            // 新員工:兩個來源都成功才建立;已離職者不建立
            if (partial || merged.employmentStatus === 'resigned') continue;
            const [row] = await tx
              .insert(user)
              .output({ id: user.userId })
              .values({
                employeeNo: job.emp,
                displayName: merged.displayName ?? job.emp,
                email: merged.email,
                profileSource: merged.profileSource,
                createdBy: opts.actor,
                updatedBy: opts.actor,
              });
            await applyProfile(tx, row!.id, merged, opts.actor);
            result.created++;
            continue;
          }
          if (!partial && cur.profileHash === profileHash(merged)) {
            result.unchanged++;
            continue;
          }
          const r = await applyProfile(tx, cur.userId, merged, opts.actor, { keepExisting: partial });
          if (!r.changed) {
            result.unchanged++;
            continue;
          }
          result.updated++;
          if (r.pvBumped) result.pvBumped.push(cur.userId);
          if (merged.employmentStatus === 'resigned' && cur.employmentStatus !== 'resigned') result.resigned.push(job.emp);
        }
      });
    }
    result.resignedFlagged = result.resigned.length;
    result.newCompanies = (await db.select({ name: company.compName }).from(company)).map((c) => c.name).filter((n) => !companiesBefore.has(n));
    if (partial) result.status = 'partial';
    for (const line of [
      listed('兼任帳號找不到本人', result.orphans),
      listed('新標記離職', result.resigned),
      listed('新增公司(無網域,請設定)', result.newCompanies),
    ])
      if (line) messages.push(line);
    return result;
  } catch (err) {
    result.status = 'failed';
    messages.push((err as Error).message);
    return result;
  } finally {
    result.errorMessage = messages.length ? messages.join('\n').slice(0, 2000) : null;
    await db
      .update(employeeSyncRun)
      .set({
        status: result.status,
        finishedAt: new Date(),
        bpmRows: result.bpmRows,
        losRows: result.losRows,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        resignedFlagged: result.resignedFlagged,
        errorMessage: result.errorMessage,
      })
      .where(eq(employeeSyncRun.runId, opts.runId));
  }
}

/** 建立同步紀錄(排程:schedule;管理 API:manual,先建立為 queued 再入列) */
export async function createSyncRun(
  db: GwDatabase,
  trigger: 'schedule' | 'manual',
  triggeredBy: string | null,
  status: 'queued' | 'running' = 'running',
): Promise<number> {
  const [row] = await db.insert(employeeSyncRun).output({ id: employeeSyncRun.runId }).values({ triggerType: trigger, status, triggeredBy });
  return row!.id;
}

/** 最近 n 次同步皆未完整成功(partial / failed)時回傳 true:連續失敗告警(DATABASE.md §8.3) */
export async function consecutiveSourceFailures(db: GwDatabase, n = 3): Promise<boolean> {
  const rows = await db
    .select({ status: employeeSyncRun.status })
    .top(n)
    .from(employeeSyncRun)
    .where(inArray(employeeSyncRun.status, ['success', 'partial', 'failed']))
    .orderBy(desc(employeeSyncRun.runId));
  return rows.length === n && rows.every((r) => r.status !== 'success');
}
