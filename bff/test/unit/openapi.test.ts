import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../src/cli/openapi.js';

const doc = (op: Record<string, unknown>) => ({
  'x-gateway': { upstream: 'node-sample', system: 'smp' },
  'x-permissions': [{ code: 'smp.item.read', name: '項目查詢' }],
  paths: { '/v1/items/{id}': { get: { operationId: 'smp.item.get', summary: '查詢項目', 'x-permission': 'smp.item.read', ...op } } },
});

describe('parseOpenApi:description 與 x-gherkin', () => {
  it('description → description、x-gherkin → gherkin(去除前後空白)', () => {
    const gherkin = '場景: 查詢存在的項目\n  當 呼叫 GET /api/smp/items/1\n  那麼 回應 200\n';
    const spec = parseOpenApi(doc({ description: ' 依 ID 查詢單一項目 ', 'x-gherkin': gherkin }));
    expect(spec.errors).toEqual([]);
    expect(spec.routes[0]).toMatchObject({ description: '依 ID 查詢單一項目', gherkin: gherkin.trim() });
  });

  it('未提供時為 null,不列為錯誤', () => {
    const spec = parseOpenApi(doc({}));
    expect(spec.errors).toEqual([]);
    expect(spec.routes[0]).toMatchObject({ description: null, gherkin: null });
  });

  it('description 超過 1000 字、x-gherkin 不是文字時列為錯誤', () => {
    const spec = parseOpenApi(doc({ description: 'x'.repeat(1001), 'x-gherkin': ['場景: x'] }));
    expect(spec.errors.map((e) => e.message)).toEqual(['description 需為 1000 字以內的文字', 'x-gherkin 需為文字(Gherkin 場景)']);
  });
});

describe('parseOpenApi:x-gateway.project(開發專案)', () => {
  const withProject = (project: unknown) => ({ ...doc({}), 'x-gateway': { upstream: 'node-sample', system: 'smp', project } });

  it('x-gateway.project → project', () => {
    const spec = parseOpenApi(withProject('giga-endpoint'));
    expect(spec.errors).toEqual([]);
    expect(spec.project).toBe('giga-endpoint');
  });

  it('未提供時為 null,不列為錯誤', () => {
    const spec = parseOpenApi(doc({}));
    expect(spec.errors).toEqual([]);
    expect(spec.project).toBeNull();
  });

  it.each([['../etc'], ['a b'], [''], [123], ['x'.repeat(101)]])('不合法的 project %j 列為錯誤', (project) => {
    const spec = parseOpenApi(withProject(project));
    expect(spec.errors.map((e) => e.message)).toEqual(['x-gateway.project 需為 repo 資料夾名稱(英數、. _ -,100 字內)']);
    expect(spec.project).toBeNull();
  });
});

describe('parseOpenApi:x-permissions 的 kind / parent / sort(PRD §8.3.2)', () => {
  const withPerms = (perms: unknown[]) => ({ ...doc({}), 'x-permissions': [{ code: 'smp.item.read', name: '項目查詢' }, ...perms] });

  it('宣告 kind / parent / sort', () => {
    const spec = parseOpenApi(
      withPerms([
        { code: 'smp.app.access', name: '樣本應用', kind: 'app' },
        { code: 'smp.item.write', name: '新增項目', kind: 'button', parent: 'smp.item.read', sort: 10 },
      ]),
    );
    expect(spec.errors).toEqual([]);
    expect(spec.permissions[2]).toEqual({ code: 'smp.item.write', name: '新增項目', kind: 'button', parent: 'smp.item.read', sort: 10 });
  });

  it.each([
    [{ kind: 'page' }, 'kind 需為 app / group / menu / tab / button / api'],
    [{ parent: 'smp.x.write' }, 'parent 需為其他權限代碼'],
    [{ parent: 'bad' }, 'parent 需為其他權限代碼'],
    [{ sort: 1.5 }, 'sort 需為 0–32767 的整數'],
    [{ sort: -1 }, 'sort 需為 0–32767 的整數'],
    [{ icon: 'Bad Icon' }, 'icon 需為圖示名稱(小寫英數與 -,30 字內)'],
  ])('不合法 %j', (extra, message) => {
    const spec = parseOpenApi(withPerms([{ code: 'smp.x.write', name: '寫入', ...extra }]));
    expect(spec.errors.map((e) => e.message.split(':')[0])).toEqual([message]);
  });

  it('選單目錄 group 與圖示(PRD §8.3.4)', () => {
    const spec = parseOpenApi(
      withPerms([
        { code: 'smp.app.access', name: '樣本應用', kind: 'app' },
        { code: 'smp.group.hr', name: '人資', kind: 'group', parent: 'smp.app.access', sort: 10, icon: 'users' },
      ]),
    );
    expect(spec.errors).toEqual([]);
    expect(spec.permissions[2]).toMatchObject({ kind: 'group', icon: 'users' });
  });
});
