import { describe, expect, it } from 'vitest';
import { checkSourceCount, groupEmployees } from '../../src/modules/auth/employee-sync.js';
import type { bpmEmployee, losEmployee } from '../../src/db/external/index.js';

type Bpm = typeof bpmEmployee.$inferSelect;
type Los = typeof losEmployee.$inferSelect;

const bpm = (employeeNo: string): Bpm => ({
  employeeNo,
  displayName: employeeNo,
  email: null,
  deptCode: null,
  department: null,
  orgName: null,
  title: null,
  jobLevel: null,
  managerEmployeeNo: null,
  leaveDate: null,
});
const los = (userId: string, isVUser = false): Los => ({
  userId,
  userName: userId,
  email: null,
  compName: '碩禾',
  compFullName: null,
  compDb: null,
  efDept: null,
  efDeptName: null,
  jobName: null,
  jobLevel: null,
  bossId: null,
  bossEmail: null,
  jobDate: null,
  leaveDate: null,
  isVUser,
});

describe('groupEmployees(DATABASE.md §8.2、W3-4.6b)', () => {
  it('以工號(去空白、轉大寫)合併 BPM 與 LOS', () => {
    const g = groupEmployees([bpm(' s112009 '), bpm('V112001')], [los('S112009'), los('X100001')]);
    expect([...g.people.keys()].sort()).toEqual(['S112009', 'V112001', 'X100001']);
    expect(g.people.get('S112009')).toMatchObject({ bpm: { employeeNo: ' s112009 ' }, los: { userId: 'S112009' } });
    expect(g.people.get('X100001')?.bpm).toBeNull();
  });

  it('兼任帳號以字尾比對本人(取最長相符者),找不到本人者列為 orphans', () => {
    const g = groupEmployees(
      [bpm('V112001'), bpm('GV112001X')],
      [los('S12'), los('S112009'), los('US112009', true), los('GV112001', true), los('ZZ999', true)],
    );
    expect(g.virtuals.map((v) => [v.emp, v.base])).toEqual([
      ['US112009', 'S112009'],
      ['GV112001', 'V112001'],
    ]);
    expect(g.people.get('S112009')?.virtuals.map((v) => v.userId)).toEqual(['US112009']);
    expect(g.orphans).toEqual(['ZZ999']);
    // 兼任帳號本身不是「人」
    expect(g.people.has('US112009')).toBe(false);
  });

  it('不合法的工號略過並計數', () => {
    const g = groupEmployees([bpm('A'), bpm('S1 2')], [los('%x%')]);
    expect(g.people.size).toBe(0);
    expect(g.invalid).toBe(3);
  });
});

describe('checkSourceCount(同步安全檢查)', () => {
  it.each([
    [0, null, 'BPM 回傳 0 筆'],
    [79, 100, '少 20% 以上'],
    [80, 100, null],
    [500, null, null],
    [120, 100, null],
  ])('%i 筆(上次 %s)', (rows, prev, expected) => {
    const r = checkSourceCount('BPM', rows, prev);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toContain(expected);
  });
});
