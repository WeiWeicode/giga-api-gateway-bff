/**
 * 公告對象(NOTIFY-PLAN §4 D4、§6.1):純函式,不做 I/O。
 *
 *   符合 = 指定工號 ∪ AD 群組 ∪ ((全公司 ∪ 公司 ∪ 部門) ∩ 職級門檻)
 *   職級門檻只套用在「全公司 / 公司 / 部門」(例:全公司 + 理級以上 ≈ Notes 的 .S經理級以上人員);指定工號與 AD 群組不受門檻限制。
 *   部門 sub = true 時含下層部門(gw.department 部門樹)。
 */
import type { DeptTree } from '../rbac/rules.js';
import { isJobTier, tierMatches } from '../rbac/job-tiers.js';

export interface AudienceDept {
  code: string;
  /** 含下層部門 */
  sub: boolean;
}

export interface Audience {
  all?: boolean;
  /** gw.company.company_id */
  companies?: number[];
  depts?: AudienceDept[];
  /** 職級門檻代碼(rbac/job-tiers.ts);未指定 = 全員 */
  jobTier?: string;
  /** AD 群組完整 DN 或 CN 名稱 */
  adGroups?: string[];
  /** 工號 */
  users?: string[];
}

/** 比對所需的使用者事實(對應 rbac/permission.ts loadUserFacts) */
export interface AudienceFacts {
  employeeNo: string;
  adGroups: string[];
  memberships: { companyId: number | null; deptCode: string | null }[];
  jobLevel: string | null;
}

export const AUDIENCE_LIMITS = { companies: 50, depts: 200, adGroups: 20, users: 2000 } as const;

const uniq = <T>(list: T[]) => [...new Set(list)];

/** 正規化:去重、工號轉大寫、去除空值;不合法時回傳錯誤訊息清單 */
export function normalizeAudience(input: Audience): { audience: Audience; errors: { field: string; message: string }[] } {
  const errors: { field: string; message: string }[] = [];
  const out: Audience = {};
  if (input.all) out.all = true;
  const companies = uniq((input.companies ?? []).filter((c) => Number.isInteger(c) && c > 0));
  if (companies.length) out.companies = companies;
  const depts = new Map<string, AudienceDept>();
  for (const d of input.depts ?? []) {
    const code = d.code?.trim();
    if (code) depts.set(code, { code, sub: d.sub !== false || depts.get(code)?.sub === true });
  }
  if (depts.size) out.depts = [...depts.values()];
  const adGroups = uniq((input.adGroups ?? []).map((g) => g.trim()).filter(Boolean));
  if (adGroups.length) out.adGroups = adGroups;
  const users = uniq((input.users ?? []).map((u) => u.trim().toUpperCase()).filter(Boolean));
  if (users.length) out.users = users;
  if (input.jobTier && input.jobTier !== 'all') {
    if (!isJobTier(input.jobTier)) errors.push({ field: 'audience.jobTier', message: `未知的職級門檻:${input.jobTier}` });
    else out.jobTier = input.jobTier;
  }
  for (const [k, max] of Object.entries(AUDIENCE_LIMITS) as [keyof typeof AUDIENCE_LIMITS, number][])
    if ((out[k]?.length ?? 0) > max) errors.push({ field: `audience.${k}`, message: `最多 ${max} 個` });
  if (!out.all && !out.companies && !out.depts && !out.adGroups && !out.users) errors.push({ field: 'audience', message: '至少選擇一種對象' });
  return { audience: out, errors };
}

/** gw.notify_announcement.audience;格式錯誤視為沒有對象(不會符合任何人) */
export function parseAudience(json: string | null): Audience {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Audience) : {};
  } catch {
    return {};
  }
}

/** AD 群組比對:完整 DN 相等(不分大小寫),或以 CN 名稱比對 DN 的第一段 */
function groupMatches(wanted: string, dns: string[]): boolean {
  const w = wanted.toLowerCase();
  if (w.includes('=')) return dns.some((dn) => dn.toLowerCase() === w);
  return dns.some((dn) => dn.toLowerCase().startsWith(`cn=${w},`));
}

export function matchAudience(a: Audience, f: AudienceFacts, tree: DeptTree): boolean {
  if (a.users?.includes(f.employeeNo.toUpperCase())) return true;
  if (a.adGroups?.some((g) => groupMatches(g, f.adGroups))) return true;
  let base = !!a.all;
  if (!base && a.companies?.length) base = f.memberships.some((m) => m.companyId !== null && a.companies!.includes(m.companyId));
  if (!base && a.depts?.length) {
    const mine = f.memberships.map((m) => m.deptCode).filter((d): d is string => !!d);
    base = a.depts.some((d) => {
      const scope = d.sub ? tree.descendants(d.code) : new Set([d.code]);
      return mine.some((m) => scope.has(m));
    });
  }
  return base && tierMatches(a.jobTier ?? 'all', f.jobLevel);
}

/**
 * 對象是否只在發布人自己的部門(含下層)內(NOTIFY-PLAN §7):沒有 notify.announce.publish.all 時只能發給本部門。
 * 全公司、公司、AD 群組、指定工號一律視為超出範圍(指定工號需逐一查部門,第二階段 N6 再開放)。
 */
export function withinOwnDepts(a: Audience, ownDepts: string[], tree: DeptTree): boolean {
  if (a.all || a.companies?.length || a.adGroups?.length || a.users?.length) return false;
  if (!a.depts?.length || !ownDepts.length) return false;
  const scope = new Set(ownDepts.flatMap((d) => [...tree.descendants(d)]));
  return a.depts.every((d) => scope.has(d.code));
}

/** 發布紀錄與確認視窗用的對象摘要 */
export function describeAudience(
  a: Audience,
  names: { companies?: Map<number, string>; depts?: Map<string, string>; tiers?: Map<string, string> } = {},
): string {
  const parts: string[] = [];
  if (a.all) parts.push('全公司');
  if (a.companies?.length) parts.push(`公司:${a.companies.map((c) => names.companies?.get(c) ?? `#${c}`).join('、')}`);
  if (a.depts?.length) parts.push(`部門:${a.depts.map((d) => `${names.depts?.get(d.code) ?? d.code}${d.sub ? '(含下層)' : ''}`).join('、')}`);
  if (a.jobTier) parts.push(names.tiers?.get(a.jobTier) ?? a.jobTier);
  if (a.adGroups?.length) parts.push(`AD 群組 ${a.adGroups.length} 個`);
  if (a.users?.length) parts.push(`指定 ${a.users.length} 人`);
  return parts.join(';');
}
