/**
 * 人事資料(DATABASE.md §8):BPM 為主、LOS 補充、AD 最後。
 *   - lookupEmployee:以工號並行即時查詢 BPM 與 LOS(各逾時 3 秒),用於登入補查(W3-4.6c)與 IT 代建帳號
 *   - applyProfile:寫入 gw.user、gw.company(遇新公司自動建立)、gw.user_company(含兼任帳號併入本人)
 * 排程全量同步(W3-4.6b)沿用同一套合併規則。
 */
import { createHash } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import type { GwDatabase } from '../../db/client.js';
import type { ExternalDb } from '../../plugins/db.js';
import { bpmEmployee, losEmployee } from '../../db/external/index.js';
import { company, user, userCompany } from '../../db/schema/index.js';

export const LOOKUP_TIMEOUT_MS = 3_000;

export const normalizeEmpNo = (v: string) => v.trim().toUpperCase();
/** 工號格式:英數(避免 LIKE 萬用字元與異常輸入) */
export const isValidEmpNo = (v: string) => /^[A-Z0-9]{2,20}$/.test(v);

type BpmRow = typeof bpmEmployee.$inferSelect;
type LosRow = typeof losEmployee.$inferSelect;

export interface EmployeeLookup {
  bpm: BpmRow | null;
  los: LosRow | null;
  /** LOS 兼任帳號(IsVUser = 1,工號 = 字首 + 本人工號) */
  virtuals: LosRow[];
  /** 查詢的工號本身就是兼任帳號(不可單獨登入,Q16) */
  selfVirtual: boolean;
  bpmOk: boolean;
  losOk: boolean;
}

export interface MergedProfile {
  displayName: string | null;
  email: string | null;
  deptCode: string | null;
  department: string | null;
  orgName: string | null;
  title: string | null;
  jobLevel: string | null;
  managerEmployeeNo: string | null;
  employmentStatus: 'active' | 'resigned' | null;
  profileSource: 'bpm' | 'los' | 'bpm+los' | 'ad_only';
  companies: {
    compName: string;
    compFullName: string | null;
    compDb: string | null;
    deptCode: string | null;
    department: string | null;
    via: string;
    isVirtual: boolean;
    isPrimary: boolean;
  }[];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`逾時 ${ms} ms`)), ms).unref())]);
}

/** LOS 日期為 d/M/yyyy 字串(DATABASE.md §8.2),依固定格式解析,不依地區設定 */
export function parseLosDate(v: string | null | undefined): Date | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(v ?? '');
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function lookupEmployee(ext: { bpm?: ExternalDb; los?: ExternalDb }, employeeNo: string, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<EmployeeLookup> {
  const emp = normalizeEmpNo(employeeNo);
  if (!isValidEmpNo(emp)) return { bpm: null, los: null, virtuals: [], selfVirtual: false, bpmOk: true, losOk: true };
  const [bpm, los] = await Promise.allSettled([
    ext.bpm ? withTimeout(ext.bpm.select().from(bpmEmployee).where(eq(bpmEmployee.employeeNo, emp)), timeoutMs) : Promise.reject(new Error('BPM 未設定')),
    ext.los
      ? withTimeout(
          ext.los
            .select()
            .from(losEmployee)
            .where(like(losEmployee.userId, `%${emp}`)),
          timeoutMs,
        )
      : Promise.reject(new Error('LOS 未設定')),
  ]);
  const losRows = los.status === 'fulfilled' ? los.value : [];
  return {
    bpm: bpm.status === 'fulfilled' ? (bpm.value[0] ?? null) : null,
    los: losRows.find((r) => normalizeEmpNo(r.userId) === emp && !r.isVUser) ?? null,
    virtuals: losRows.filter((r) => r.isVUser && normalizeEmpNo(r.userId).length > emp.length && normalizeEmpNo(r.userId).endsWith(emp)),
    selfVirtual: losRows.some((r) => r.isVUser && normalizeEmpNo(r.userId) === emp),
    bpmOk: bpm.status === 'fulfilled',
    losOk: los.status === 'fulfilled',
  };
}

const pick = <T>(...vals: (T | null | undefined | '')[]): T | null => {
  for (const v of vals) if (v !== null && v !== undefined && v !== '') return v as T;
  return null;
};

/** 同一欄位 BPM 有值用 BPM,否則用 LOS(DATABASE.md §8.2) */
export function mergeProfile(l: EmployeeLookup): MergedProfile {
  const { bpm, los } = l;
  const bpmStatus = bpm ? (bpm.leaveDate ? 'resigned' : 'active') : null;
  const losStatus = los ? (parseLosDate(los.leaveDate) ? 'resigned' : 'active') : null;
  const companies: MergedProfile['companies'] = [];
  if (los?.compName) {
    companies.push({
      compName: los.compName,
      compFullName: los.compFullName,
      compDb: los.compDb,
      deptCode: pick(bpm?.deptCode, los.efDept),
      department: pick(bpm?.department, los.efDeptName),
      via: normalizeEmpNo(los.userId),
      isVirtual: false,
      isPrimary: true,
    });
  } else if (bpm?.orgName) {
    companies.push({
      compName: bpm.orgName,
      compFullName: null,
      compDb: null,
      deptCode: bpm.deptCode,
      department: bpm.department,
      via: bpm.employeeNo,
      isVirtual: false,
      isPrimary: true,
    });
  }
  for (const v of l.virtuals) {
    if (!v.compName || parseLosDate(v.leaveDate)) continue;
    companies.push({
      compName: v.compName,
      compFullName: v.compFullName,
      compDb: v.compDb,
      deptCode: v.efDept,
      department: v.efDeptName,
      via: normalizeEmpNo(v.userId),
      isVirtual: true,
      isPrimary: false,
    });
  }
  return {
    displayName: pick(bpm?.displayName, los?.userName),
    email: pick(bpm?.email, los?.email),
    deptCode: pick(bpm?.deptCode, los?.efDept),
    department: pick(bpm?.department, los?.efDeptName),
    orgName: pick(bpm?.orgName, los?.compName),
    title: pick(bpm?.title, los?.jobName),
    jobLevel: pick(bpm?.jobLevel, los?.jobLevel),
    managerEmployeeNo: pick(bpm?.managerEmployeeNo, los?.bossId),
    employmentStatus: pick(bpmStatus, losStatus),
    profileSource: bpm && los ? 'bpm+los' : bpm ? 'bpm' : los ? 'los' : 'ad_only',
    companies,
  };
}

export function profileHash(p: MergedProfile): string {
  const { profileSource: _s, ...rest } = p;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

type Tx = Parameters<Parameters<GwDatabase['transaction']>[0]>[0];

/**
 * 寫入人事資料。部門、職稱、在職狀態或公司變更時 perm_version + 1(DATABASE.md §7.2)。
 * 來源都查無時(ad_only)不清空既有欄位。
 * keepExisting:排程同步時某一來源讀取失敗(DATABASE.md §8.3「來源停機」),只以另一來源有值的欄位更新、不改所屬公司;
 *               profile_hash 清空,下一次兩個來源都成功時重新比對寫入。
 */
export async function applyProfile(
  tx: Tx,
  userId: number,
  p: MergedProfile,
  actor: string,
  opts: { keepExisting?: boolean } = {},
): Promise<{ pvBumped: boolean; changed: boolean }> {
  const [cur] = await tx.select().from(user).where(eq(user.userId, userId));
  if (!cur) throw new Error(`找不到使用者 ${userId}`);
  if (p.profileSource === 'ad_only') return { pvBumped: false, changed: false };

  if (opts.keepExisting) {
    const next = {
      displayName: p.displayName ?? cur.displayName,
      email: p.email ?? cur.email,
      deptCode: p.deptCode ?? cur.deptCode,
      department: p.department ?? cur.department,
      orgName: p.orgName ?? cur.orgName,
      title: p.title ?? cur.title,
      jobLevel: p.jobLevel ?? cur.jobLevel,
      managerEmployeeNo: p.managerEmployeeNo ?? cur.managerEmployeeNo,
      employmentStatus: p.employmentStatus ?? cur.employmentStatus,
    };
    const differs = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== cur[k]);
    if (!differs) return { pvBumped: false, changed: false };
    const affects =
      next.deptCode !== cur.deptCode || next.title !== cur.title || next.jobLevel !== cur.jobLevel || next.employmentStatus !== cur.employmentStatus;
    await tx
      .update(user)
      .set({
        ...next,
        profileHash: null,
        profileSyncedAt: new Date(),
        updatedBy: actor,
        ...(affects ? { permVersion: sql`${user.permVersion} + 1` } : {}),
      })
      .where(eq(user.userId, userId));
    return { pvBumped: affects, changed: true };
  }

  const hash = profileHash(p);
  const changed = cur.profileHash !== hash;
  const affectsAuthz = cur.deptCode !== p.deptCode || cur.title !== p.title || cur.employmentStatus !== p.employmentStatus || changed;
  await tx
    .update(user)
    .set({
      displayName: p.displayName ?? cur.displayName,
      email: p.email ?? cur.email,
      deptCode: p.deptCode,
      department: p.department,
      orgName: p.orgName,
      title: p.title,
      jobLevel: p.jobLevel,
      managerEmployeeNo: p.managerEmployeeNo,
      employmentStatus: p.employmentStatus,
      profileSource: p.profileSource,
      profileHash: hash,
      profileSyncedAt: new Date(),
      updatedBy: actor,
      ...(changed && affectsAuthz ? { permVersion: sql`${user.permVersion} + 1` } : {}),
    })
    .where(eq(user.userId, userId));

  if (changed) {
    await tx.delete(userCompany).where(eq(userCompany.userId, userId));
    for (const c of p.companies) {
      let [row] = await tx.select({ id: company.companyId }).from(company).where(eq(company.compName, c.compName));
      if (!row) {
        [row] = await tx
          .insert(company)
          .output({ id: company.companyId })
          .values({ compName: c.compName, compFullName: c.compFullName, compDb: c.compDb, createdBy: actor, updatedBy: actor });
      }
      const [dup] = await tx
        .select({ u: userCompany.userId })
        .from(userCompany)
        .where(and(eq(userCompany.userId, userId), eq(userCompany.companyId, row!.id), eq(userCompany.viaEmployeeNo, c.via)));
      if (!dup) {
        await tx.insert(userCompany).values({
          userId,
          companyId: row!.id,
          viaEmployeeNo: c.via,
          deptCode: c.deptCode,
          department: c.department,
          isVirtual: c.isVirtual,
          isPrimary: c.isPrimary,
        });
      }
    }
  }
  return { pvBumped: changed && affectsAuthz, changed };
}
