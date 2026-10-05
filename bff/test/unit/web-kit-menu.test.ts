/** web-kit 多層選單的純邏輯(FRONTEND-GUIDE.md §7.5、PRD §8.3.4) */
import { describe, expect, it } from 'vitest';
import { filterMenu, findTrail, flattenMenu, menuKeys, pathMatches, type MenuNode } from '../../../web-kit/src/menu.js';

// 三層以上:人資 → 請假 → 我的假單 / 審核;人資 → 薪資(頁面兼目錄)→ 獎金
const MENU: MenuNode[] = [
  { key: 'home', title: '首頁', path: '/' },
  {
    key: 'hr',
    title: '人資',
    children: [
      {
        key: 'leave',
        title: '請假',
        children: [
          { key: 'leave-mine', title: '我的假單', path: '/hr/leave/mine', permission: 'portal.leave.read' },
          { key: 'leave-approve', title: '審核', path: '/hr/leave/approve', permission: 'portal.leave.approve', requires: ['bpm.approval.read'] },
        ],
      },
      {
        key: 'salary',
        title: '薪資',
        path: '/hr/salary',
        permission: 'portal.salary.read',
        children: [{ key: 'bonus', title: '獎金', path: '/hr/salary/bonus', permission: 'portal.bonus.read' }],
      },
    ],
  },
  { key: 'admin', title: '管理', children: [{ key: 'audit', title: '稽核', path: '/admin/audit', permission: 'portal.audit.read' }] },
];

const canOf = (...codes: string[]) => {
  const s = new Set(codes);
  return (c: string) => s.has(c);
};
const keys = (nodes: ReturnType<typeof filterMenu>): string[] => nodes.flatMap((n) => [n.key, ...keys(n.children)]);

describe('filterMenu', () => {
  it('沒有可見頁面的目錄整個隱藏;沒有權限代碼的頁面登入即可見', () => {
    expect(keys(filterMenu(MENU, canOf()))).toEqual(['home']);
  });

  it('第三層頁面可見時,上層目錄跟著顯示,depth 正確', () => {
    const m = filterMenu(MENU, canOf('portal.leave.read'));
    expect(keys(m)).toEqual(['home', 'hr', 'leave', 'leave-mine']);
    expect(m[1]!.children[0]!.children[0]!.depth).toBe(2);
  });

  it('requires 需全部具備', () => {
    expect(keys(filterMenu(MENU, canOf('portal.leave.approve')))).not.toContain('leave-approve');
    expect(keys(filterMenu(MENU, canOf('portal.leave.approve', 'bpm.approval.read')))).toContain('leave-approve');
  });

  it('頁面兼目錄:本身沒權限但下層可見 → 保留為目錄(移除 path)', () => {
    const salary = filterMenu(MENU, canOf('portal.bonus.read'))[1]!.children[0]!;
    expect(salary.key).toBe('salary');
    expect(salary.path).toBeUndefined();
    expect(salary.children.map((c) => c.key)).toEqual(['bonus']);
    expect(filterMenu(MENU, canOf('portal.salary.read'))[1]!.children[0]!.path).toBe('/hr/salary');
  });
});

describe('findTrail / pathMatches', () => {
  const m = filterMenu(MENU, canOf('portal.leave.read', 'portal.salary.read', 'portal.bonus.read'));

  it('回傳根 → 頁面的節點鏈,以最長路徑前綴為準', () => {
    expect(findTrail(m, '/hr/salary/bonus/2026').map((n) => n.key)).toEqual(['hr', 'salary', 'bonus']);
    expect(findTrail(m, '/hr/salary').map((n) => n.key)).toEqual(['hr', 'salary']);
    expect(findTrail(m, '/hr/leave/mine').map((n) => n.title)).toEqual(['人資', '請假', '我的假單']);
  });

  it('「/」只比對首頁本身;找不到回空陣列', () => {
    expect(findTrail(m, '/').map((n) => n.key)).toEqual(['home']);
    expect(findTrail(m, '/unknown')).toEqual([]);
    expect(pathMatches('/hr/salary', '/hr/salary-x')).toBe(false);
  });
});

describe('flattenMenu / menuKeys', () => {
  const m = filterMenu(MENU, canOf('portal.leave.read', 'portal.bonus.read'));

  it('只攤平展開的目錄', () => {
    expect(flattenMenu(m, () => false).map((n) => n.key)).toEqual(['home', 'hr']);
    expect(flattenMenu(m, (k) => k === 'hr').map((n) => n.key)).toEqual(['home', 'hr', 'leave', 'salary']);
    expect(flattenMenu(m, () => true).map((n) => n.key)).toEqual(['home', 'hr', 'leave', 'leave-mine', 'salary', 'bonus']);
  });

  it('menuKeys 列出所有節點', () => {
    expect(menuKeys(MENU)).toHaveLength(9);
  });
});
