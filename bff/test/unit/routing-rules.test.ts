import { describe, expect, it } from 'vitest';
import { checkPublicPath, checkRouteFields, checkSteps, checkSystemCode, checkTargetUrl, type RouteFields } from '../../src/modules/admin/routing-rules.js';

const base: RouteFields = {
  routeType: 'proxy',
  method: 'GET',
  upstreamId: 1,
  authMode: 'permission',
  permissionCode: 'mes.workorder.read',
  cacheTtlSec: null,
  cacheScope: null,
  mockResponse: null,
  requestHeadersAdd: null,
  responseHeadersRemove: null,
};
const fields = (r: Partial<RouteFields>, env = 'test') => checkRouteFields({ ...base, ...r }, env).map((e) => e.field);

describe('checkSystemCode / checkPublicPath', () => {
  it('auth、admin 為 BFF 內建,不可作為系統代碼', () => {
    expect(checkSystemCode('mes')).toEqual([]);
    expect(checkSystemCode('admin')[0]!.message).toContain('BFF 內建');
    expect(checkSystemCode('MES')).toHaveLength(1);
  });

  it('對外路徑需以 /api/{system} 開頭,萬用字元只能在最後', () => {
    expect(checkPublicPath('mes', '/api/mes/work-orders/:id')).toEqual([]);
    expect(checkPublicPath('mes', '/api/mes/*')).toEqual([]);
    expect(checkPublicPath('mes', '/api/mes')).toEqual([]);
    expect(checkPublicPath('mes', '/api/mesx/a')).toHaveLength(1);
    expect(checkPublicPath('mes', '/api/hrm/a')).toHaveLength(1);
    expect(checkPublicPath('mes', '/api/mes/*/a')).toHaveLength(1);
    expect(checkPublicPath('mes', '/api/mes//a')).toHaveLength(1);
    expect(checkPublicPath('mes', '/api/mes/{id}')).toHaveLength(1);
  });
});

describe('checkTargetUrl', () => {
  it('port 51200–51300,不含路徑', () => {
    expect(checkTargetUrl('http://mes-host:51210')).toBe('ok');
    expect(checkTargetUrl('http://mes-host:8080')).toBe('port');
    expect(checkTargetUrl('http://mes-host:51210/v1')).toBe('invalid');
    expect(checkTargetUrl('ftp://mes-host:51210')).toBe('invalid');
    expect(checkTargetUrl('不是網址')).toBe('invalid');
  });
});

describe('checkRouteFields', () => {
  it('合法的 proxy 路由沒有錯誤', () => {
    expect(fields({})).toEqual([]);
  });

  it('proxy 必須有上游;聚合 / mock 不可直接指定上游', () => {
    expect(fields({ upstreamId: null })).toEqual(['upstreamId']);
    expect(fields({ routeType: 'aggregate' })).toEqual(['upstreamId']);
  });

  it('mock 僅測試區可用,且必須有回應內容', () => {
    expect(fields({ routeType: 'mock', upstreamId: null, mockResponse: '{"a":1}' })).toEqual([]);
    expect(fields({ routeType: 'mock', upstreamId: null, mockResponse: '{"a":1}' }, 'prod')).toEqual(['routeType']);
    expect(fields({ routeType: 'mock', upstreamId: null })).toEqual(['mockResponse']);
  });

  it('auth_mode 與權限代碼一致', () => {
    expect(fields({ permissionCode: null })).toEqual(['permissionCode']);
    expect(fields({ authMode: 'authenticated' })).toEqual(['permissionCode']);
    expect(fields({ authMode: 'public', permissionCode: null })).toEqual([]);
  });

  it('快取僅 GET、TTL 與範圍需同時設定;需權限的路由不可共用快取', () => {
    expect(fields({ cacheTtlSec: 30, cacheScope: 'user' })).toEqual([]);
    expect(fields({ method: 'POST', cacheTtlSec: 30, cacheScope: 'user' })).toEqual(['cacheTtlSec']);
    expect(fields({ cacheTtlSec: 30 })).toEqual(['cacheScope']);
    expect(fields({ cacheTtlSec: 30, cacheScope: 'shared' })).toEqual(['cacheScope']);
  });

  it('標頭欄位需為正確的 JSON 形狀', () => {
    expect(fields({ requestHeadersAdd: '{"x-a":"1"}', responseHeadersRemove: '["server"]' })).toEqual([]);
    expect(fields({ requestHeadersAdd: '{"x-a":1}' })).toEqual(['requestHeadersAdd']);
    expect(fields({ responseHeadersRemove: '{"a":"b"}' })).toEqual(['responseHeadersRemove']);
  });
});

describe('checkSteps', () => {
  it('步驟代碼不可重複,路徑以 / 開頭', () => {
    const errs = checkSteps([
      { stepKey: 'todos', stepOrder: 1, pathTemplate: '/v1/todos' },
      { stepKey: 'todos', stepOrder: 1, pathTemplate: 'v1/x' },
    ]);
    expect(errs.map((e) => e.field)).toEqual(['steps[1].stepKey', 'steps[1].pathTemplate']);
  });
});
