import { describe, expect, it } from 'vitest';
import { csvTemplate, parseCsv, parseRouteTable, TABLE_COLUMNS } from '../../src/modules/admin/route-table.js';
import { routeAction } from '../../src/modules/admin/route-import.js';

const header = ['route_code', 'name', 'system_code', 'method', 'public_path', 'route_type', 'upstream', 'auth_mode', 'permission_code', 'mock_response'];
const row = (o: Partial<Record<(typeof header)[number], string>>) => header.map((h) => o[h] ?? '');
const ok = {
  route_code: 'mes.workorder.read',
  name: '查詢工單',
  system_code: 'mes',
  method: 'GET',
  public_path: '/api/mes/work-orders/:id',
  upstream: 'go-mes',
  auth_mode: 'permission',
  permission_code: 'mes.workorder.read',
};

describe('parseCsv(RFC 4180)', () => {
  it('引號、跳脫雙引號、欄位內逗號與換行、CRLF、BOM', () => {
    expect(parseCsv('\uFEFFa,b,c\r\n"x,1","he said ""hi""","line1\nline2"\r\n')).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'he said "hi"', 'line1\nline2'],
    ]);
  });

  it('最後一列沒有換行也會讀入;空欄位保留', () => {
    expect(parseCsv('a,,c\n1,2,')).toEqual([
      ['a', '', 'c'],
      ['1', '2', ''],
    ]);
  });

  it('範本可被解析回欄位名稱與範例列', () => {
    const rows = parseCsv(csvTemplate());
    expect(rows[0]).toEqual(TABLE_COLUMNS.map((c) => c.key));
    expect(parseRouteTable(rows, 'test')).toMatchObject({ errors: [], routes: [{ routeCode: 'mes.workorder.read', upstream: 'go-mes' }] });
  });
});

describe('parseRouteTable(P2-4)', () => {
  it('合法的 proxy 路由;欄位名稱不分大小寫,空白列略過', () => {
    const r = parseRouteTable([header.map((h) => h.toUpperCase()), row(ok), row({})], 'test');
    expect(r.errors).toEqual([]);
    expect(r.routes).toEqual([
      expect.objectContaining({ rowNo: 2, routeCode: 'mes.workorder.read', routeType: 'proxy', method: 'GET', auditLevel: 'none', cacheTtlSec: null }),
    ]);
  });

  it('缺少必要欄位、未知欄位 → 整批錯誤(第 1 列)', () => {
    const r = parseRouteTable([['route_code', 'nmae']], 'test');
    expect(r.routes).toEqual([]);
    expect(r.errors.map((e) => `${e.rowNo}:${e.field}:${e.message}`)).toEqual(
      expect.arrayContaining(['1:nmae:未知的欄位名稱', '1:name:缺少必要欄位', '1:auth_mode:缺少必要欄位']),
    );
  });

  it('逐列檢查:格式、聚合不支援、proxy 需上游、permission 需權限代碼、路徑前綴', () => {
    const r = parseRouteTable(
      [
        header,
        row({ ...ok, route_code: 'Bad Code' }),
        row({ ...ok, route_code: 'mes.a.b', route_type: 'aggregate' }),
        row({ ...ok, route_code: 'mes.c.d', public_path: '/api/mes/c', upstream: '' }),
        row({ ...ok, route_code: 'mes.e.f', public_path: '/api/mes/e', permission_code: '' }),
        row({ ...ok, route_code: 'mes.g.h', public_path: '/api/hr/g' }),
      ],
      'test',
    );
    expect(r.routes).toEqual([]);
    const byRow = (n: number) => r.errors.filter((e) => e.rowNo === n).map((e) => e.field);
    expect(byRow(2)).toContain('route_code');
    expect(byRow(3)).toContain('route_type');
    expect(byRow(4)).toContain('upstream');
    expect(byRow(5)).toContain('permission_code');
    expect(byRow(6)).toContain('public_path');
  });

  it('同一檔案內 route_code 或方法 + 路徑重複', () => {
    const r = parseRouteTable([header, row(ok), row(ok), row({ ...ok, route_code: 'mes.workorder.get' })], 'test');
    expect(r.routes.map((x) => x.rowNo)).toEqual([2]);
    expect(r.errors.filter((e) => e.rowNo === 3).map((e) => e.message)).toEqual(expect.arrayContaining(['與第 2 列重複']));
    expect(r.errors.filter((e) => e.rowNo === 4).map((e) => e.message)).toEqual(['方法與對外路徑與第 2 列重複']);
  });

  it('mock 路由需 JSON 回應內容,正式區不可使用', () => {
    const mock = { ...ok, route_type: 'mock', upstream: '', auth_mode: 'authenticated', permission_code: '' };
    expect(parseRouteTable([header, row({ ...mock, mock_response: '{"a":1}' })], 'test').errors).toEqual([]);
    expect(parseRouteTable([header, row({ ...mock, mock_response: '{bad' })], 'test').errors.map((e) => e.field)).toContain('mock_response');
    expect(parseRouteTable([header, row({ ...mock, mock_response: '{}' })], 'prod').errors.map((e) => e.field)).toContain('route_type');
  });
});

describe('routeAction(匯入預覽與寫入共用)', () => {
  it('不存在 → create;欄位不同或已停用 → update;相同 → unchanged', () => {
    expect(routeAction(undefined, { name: 'a' })).toBe('create');
    expect(routeAction({ name: 'a', status: 'published' }, { name: 'b' })).toBe('update');
    expect(routeAction({ name: 'a', status: 'disabled' }, { name: 'a' })).toBe('update');
    expect(routeAction({ name: 'a', status: 'draft' }, { name: 'a' })).toBe('unchanged');
  });
});
