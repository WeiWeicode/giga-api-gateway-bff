/**
 * 角色指派規則比對(PRD §8.3.1、DATABASE.md §3.2):純函式,不做 I/O。
 *
 *   同一規則內各條件 AND,NULL = 不限;同一角色多條規則 OR。
 *   公司與部門以使用者的「所屬公司 + 部門」組合比對(gw.user_company,含兼任);職級、職稱取 gw.user。
 *   部門預設含下層(部門樹 gw.department)。
 */

import { tierMatches } from './job-tiers.js';

export interface RuleDef {
  ruleId: number;
  roleId: number;
  companyId: number | null;
  deptCode: string | null;
  includeSubDepts: boolean;
  jobLevels: string[] | null;
  title: string | null;
}

export interface UserFacts {
  /** 所屬公司與部門(companyId 可能為 null:只有 gw.user.dept_code 時) */
  memberships: { companyId: number | null; deptCode: string | null }[];
  jobLevel: string | null;
  title: string | null;
}

/** gw.role_rule.job_levels:JSON 陣列;空陣列或格式錯誤視為不限 */
export function parseJobLevels(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
    return list.length ? list : null;
  } catch {
    return null;
  }
}

/** 部門樹:parent → children;展開時防循環 */
export class DeptTree {
  private readonly children = new Map<string, string[]>();

  constructor(depts: { deptCode: string; parentDeptCode: string | null }[]) {
    for (const d of depts) {
      if (!d.parentDeptCode || d.parentDeptCode === d.deptCode) continue;
      const list = this.children.get(d.parentDeptCode) ?? [];
      list.push(d.deptCode);
      this.children.set(d.parentDeptCode, list);
    }
  }

  /** 部門本身與所有下層部門 */
  descendants(code: string): Set<string> {
    const out = new Set<string>([code]);
    const stack = [code];
    while (stack.length) {
      for (const c of this.children.get(stack.pop()!) ?? []) {
        if (!out.has(c)) {
          out.add(c);
          stack.push(c);
        }
      }
    }
    return out;
  }
}

/** 規則至少要有一個條件(不可空規則,DATABASE.md §3.2) */
export const hasCondition = (r: Pick<RuleDef, 'companyId' | 'deptCode' | 'jobLevels' | 'title'>) =>
  r.companyId !== null || r.deptCode !== null || !!r.jobLevels?.length || !!r.title;

export function ruleMatches(rule: RuleDef, facts: UserFacts, tree: DeptTree): boolean {
  if (!hasCondition(rule)) return false;
  if (rule.jobLevels && !(facts.jobLevel && rule.jobLevels.includes(facts.jobLevel.trim()))) return false;
  if (rule.title && rule.title.trim() !== (facts.title ?? '').trim()) return false;
  if (rule.companyId === null && rule.deptCode === null) return true;
  const depts = rule.deptCode === null ? null : rule.includeSubDepts ? tree.descendants(rule.deptCode) : new Set([rule.deptCode]);
  return facts.memberships.some(
    (m) => (rule.companyId === null || m.companyId === rule.companyId) && (depts === null || (m.deptCode !== null && depts.has(m.deptCode))),
  );
}

/** 符合的規則(依角色彙整);回傳 roleId → 命中的 ruleId 清單 */
export function matchRules(rules: RuleDef[], facts: UserFacts, tree: DeptTree): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const r of rules) {
    if (!ruleMatches(r, facts, tree)) continue;
    out.set(r.roleId, [...(out.get(r.roleId) ?? []), r.ruleId]);
  }
  return out;
}

/** 部門權限(gw.dept_permission,v0.12) */
export interface DeptGrantDef {
  deptCode: string;
  permissionCode: string;
  jobTier: string;
  includeSubDepts: boolean;
}

/** 使用者符合的部門權限:任一所屬部門落在授權部門(含下層時含其下層)內,且職級符合門檻 */
export function matchDeptGrants(grants: DeptGrantDef[], facts: Pick<UserFacts, 'memberships' | 'jobLevel'>, tree: DeptTree): DeptGrantDef[] {
  const mine = facts.memberships.map((m) => m.deptCode).filter((d): d is string => d !== null);
  if (!mine.length) return [];
  const scope = new Map<string, Set<string>>();
  return grants.filter((g) => {
    if (!tierMatches(g.jobTier, facts.jobLevel)) return false;
    const key = `${g.deptCode}|${g.includeSubDepts ? 1 : 0}`;
    let depts = scope.get(key);
    if (!depts) scope.set(key, (depts = g.includeSubDepts ? tree.descendants(g.deptCode) : new Set([g.deptCode])));
    return mine.some((d) => depts.has(d));
  });
}
