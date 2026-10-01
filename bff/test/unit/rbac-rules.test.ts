/** docs/Gherkin/rbac/role-rules.feature(P2-3a):規則比對 */
import { describe, expect, it } from 'vitest';
import { DeptTree, matchRules, parseJobLevels, ruleMatches, type RuleDef, type UserFacts } from '../../src/modules/rbac/rules.js';

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
