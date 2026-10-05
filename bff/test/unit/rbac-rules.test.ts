/** docs/Gherkin/rbac/role-rules.feature(P2-3a):規則比對 */
import { describe, expect, it } from 'vitest';
import { tierMatches } from '../../src/modules/rbac/job-tiers.js';
import {
  DeptTree,
  matchDeptGrants,
  matchRules,
  parseJobLevels,
  ruleMatches,
  type DeptGrantDef,
  type RuleDef,
  type UserFacts,
} from '../../src/modules/rbac/rules.js';

// 部門樹 IT(資訊部)→ IT-SYS(系統課)、IT-NET(網管課);IT-SYS → IT-SYS-A
const tree = new DeptTree([
  { deptCode: 'IT', parentDeptCode: null },
  { deptCode: 'IT-SYS', parentDeptCode: 'IT' },
  { deptCode: 'IT-NET', parentDeptCode: 'IT' },
  { deptCode: 'IT-SYS-A', parentDeptCode: 'IT-SYS' },
  { deptCode: 'HR', parentDeptCode: null },
  // 循環資料不可讓展開卡住
  { deptCode: 'LOOP-A', parentDeptCode: 'LOOP-B' },
  { deptCode: 'LOOP-B', parentDeptCode: 'LOOP-A' },
]);

const rule = (r: Partial<RuleDef>): RuleDef => ({
  ruleId: 1,
  roleId: 10,
  companyId: null,
  deptCode: null,
  includeSubDepts: true,
  jobLevels: null,
  title: null,
  ...r,
});
const facts = (deptCode: string, jobLevel: string | null, title: string | null = null, companyId: number | null = 1): UserFacts => ({
  memberships: [{ companyId, deptCode }],
  jobLevel,
  title,
});

describe('ruleMatches', () => {
  const itEngineer = rule({ deptCode: 'IT', jobLevels: ['4', '5'] });

  it.each([
    ['IT', '4', true],
    ['IT-SYS', '5', true],
    ['IT-SYS-A', '4', true],
    ['IT-NET', '6', false],
    ['HR', '4', false],
  ])('部門 %s、職級 %s → %s', (dept, level, ok) => {
    expect(ruleMatches(itEngineer, facts(dept, level), tree)).toBe(ok);
  });

  it('不含下層時只比對該部門', () => {
    const r = rule({ deptCode: 'IT', includeSubDepts: false });
    expect(ruleMatches(r, facts('IT', null), tree)).toBe(true);
    expect(ruleMatches(r, facts('IT-SYS', null), tree)).toBe(false);
  });

  it('規則內多個條件須同時符合(職稱不符)', () => {
    const itLead = rule({ deptCode: 'IT', jobLevels: ['6'], title: '課長' });
    expect(ruleMatches(itLead, facts('IT-SYS', '6', '工程師'), tree)).toBe(false);
    expect(ruleMatches(itLead, facts('IT-SYS', '6', '課長'), tree)).toBe(true);
  });

  it('公司與部門以同一筆所屬關係比對(兼任)', () => {
    const r = rule({ companyId: 2, deptCode: 'IT' });
    const u: UserFacts = {
      memberships: [
        { companyId: 1, deptCode: 'IT' },
        { companyId: 2, deptCode: 'HR' },
      ],
      jobLevel: null,
      title: null,
    };
    expect(ruleMatches(r, u, tree)).toBe(false);
    expect(ruleMatches(r, { ...u, memberships: [...u.memberships, { companyId: 2, deptCode: 'IT-NET' }] }, tree)).toBe(true);
  });

  it('只有公司條件', () => {
    expect(ruleMatches(rule({ companyId: 1 }), facts('HR', null), tree)).toBe(true);
    expect(ruleMatches(rule({ companyId: 2 }), facts('HR', null), tree)).toBe(false);
  });

  it('空規則永遠不符合', () => {
    expect(ruleMatches(rule({}), facts('IT', '4'), tree)).toBe(false);
  });

  it('循環的部門樹可以展開', () => {
    expect([...tree.descendants('LOOP-A')].sort()).toEqual(['LOOP-A', 'LOOP-B']);
  });
});

describe('matchRules', () => {
  it('同一角色多條規則 OR,回傳命中的規則', () => {
    const rules = [
      rule({ ruleId: 1, roleId: 10, deptCode: 'HR' }),
      rule({ ruleId: 2, roleId: 10, jobLevels: ['4'] }),
      rule({ ruleId: 3, roleId: 20, deptCode: 'IT' }),
    ];
    expect([...matchRules(rules, facts('IT-SYS', '4'), tree)]).toEqual([
      [10, [2]],
      [20, [3]],
    ]);
  });
});

describe('parseJobLevels', () => {
  it('JSON 陣列;空陣列或格式錯誤視為不限', () => {
    expect(parseJobLevels('["5"," 6 "]')).toEqual(['5', '6']);
    expect(parseJobLevels('[]')).toBeNull();
    expect(parseJobLevels('5')).toBeNull();
    expect(parseJobLevels(null)).toBeNull();
  });
});

describe('職級門檻(v0.12)', () => {
  it.each([
    ['all', null, true],
    ['all', '9', true],
    ['section', '7', true],
    ['section', '8', false],
    ['manager', '6', true],
    ['manager', '7', false],
    ['division', '4', true],
    ['division', '0', true],
    ['division', '6', false],
    ['section', null, false],
    ['section', 'A1', false],
    ['unknown', '1', false],
  ])('%s / 職級 %s → %s', (tier, level, expected) => {
    expect(tierMatches(tier, level)).toBe(expected);
  });
});

describe('matchDeptGrants(v0.12)', () => {
  const g = (d: Partial<DeptGrantDef>): DeptGrantDef => ({ deptCode: 'IT', permissionCode: 'it.x', jobTier: 'all', includeSubDepts: true, ...d });
  const grants = [
    g({ permissionCode: 'it.all' }),
    g({ permissionCode: 'it.mgr', jobTier: 'manager' }),
    g({ deptCode: 'IT-SYS', permissionCode: 'it.sys-only', includeSubDepts: false }),
    g({ deptCode: 'HR', permissionCode: 'hr.all' }),
  ];
  const codes = (dept: string, level: string | null) => matchDeptGrants(grants, facts(dept, level), tree).map((x) => x.permissionCode);

  it('含下層:下層部門的人取得上層部門的權限', () => {
    expect(codes('IT-SYS-A', '8')).toEqual(['it.all']);
  });
  it('職級門檻:理級以上才取得', () => {
    expect(codes('IT-NET', '6')).toEqual(['it.all', 'it.mgr']);
  });
  it('不含下層:只有該部門本身', () => {
    expect(codes('IT-SYS', '9')).toEqual(['it.all', 'it.sys-only']);
    expect(codes('IT-SYS-A', '9')).not.toContain('it.sys-only');
  });
  it('兼任:任一所屬部門符合即取得', () => {
    const f: UserFacts = {
      memberships: [
        { companyId: 1, deptCode: 'HR' },
        { companyId: 2, deptCode: 'IT' },
      ],
      jobLevel: null,
      title: null,
    };
    expect(matchDeptGrants(grants, f, tree).map((x) => x.permissionCode)).toEqual(['it.all', 'hr.all']);
  });
  it('沒有部門資料不取得任何部門權限', () => {
    expect(matchDeptGrants(grants, { memberships: [{ companyId: null, deptCode: null }], jobLevel: '1' }, tree)).toEqual([]);
  });
});
