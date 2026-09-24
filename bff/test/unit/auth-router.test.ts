import { describe, expect, it } from 'vitest';
import { parseOpenApi, toPublicPath, checkUpstreamPort } from '../../src/cli/openapi.js';
import { classifyBindError, escapeFilterValue, guidFromBytes } from '../../src/modules/auth/ldap.js';
import { parseUsername } from '../../src/modules/auth/login.js';
import { checkPasswordPolicy, pushHistory } from '../../src/modules/auth/password.js';
import { mergeProfile, parseLosDate, type EmployeeLookup } from '../../src/modules/auth/profile.js';
import { renderTemplate, rewritePath } from '../../src/modules/router/plugin.js';
import type { SnapshotRoute } from '../../src/modules/router/snapshot.js';
import { RouteTable } from '../../src/modules/router/table.js';

describe('登入帳號格式(PRD §8.2.1)', () => {
  it.each([
    ['S112009', { account: 'S112009' }],
    ['GSC\\S112009', { account: 'S112009', domainHint: 'GSC' }],
    ['S112009@gsmc.com.tw', { account: 'S112009', domainHint: 'gsmc.com.tw' }],
    ['  s112009 ', { account: 's112009' }],
  ])('%s', (input, expected) => expect(parseUsername(input)).toEqual(expected));
});

describe('密碼政策(Q14)', () => {
  it.each([
    ['abc12345', []],
    ['abc1234', ['min_length']],
    ['abcdefgh', ['digit']],
    ['12345678', ['letter']],
    ['xV112001y1', ['contains_employee_no']],
    ['xv112001y1', ['contains_employee_no']],
  ])('%s → %j', (pw, rules) => expect(checkPasswordPolicy(pw, 'V112001')).toEqual(rules));

  it('只保留前 3 次密碼雜湊', () => {
    let h: string | null = null;
    for (const x of ['a', 'b', 'c', 'd']) h = pushHistory(x, h);
    expect(JSON.parse(h!)).toEqual(['d', 'c', 'b']);
  });
});

describe('AD', () => {
  it.each([
    ['80090308: LdapErr: DSID-0C09042A, comment: AcceptSecurityContext error, data 52e, v4563', 'bad_password'],
    ['... data 533, v4563', 'ACCOUNT_DISABLED'],
    ['... data 532, v4563', 'AD_PASSWORD_EXPIRED'],
    ['... data 773, v4563', 'AD_PASSWORD_EXPIRED'],
    ['... data 775, v4563', 'ACCOUNT_LOCKED'],
  ])('bind 錯誤 %s → %s', (msg, expected) => expect(classifyBindError(msg)).toBe(expected));

  it('objectGUID 位元組順序轉換', () => {
    const b = Buffer.from('e004253f894fd3119a0c0305e82c3301', 'hex');
    expect(guidFromBytes(b)).toBe('3F2504E0-4F89-11D3-9A0C-0305E82C3301');
  });

  it('LDAP filter 值跳脫', () => expect(escapeFilterValue('a*(b)\\')).toBe('a\\2a\\28b\\29\\5c'));
});

describe('人事資料合併(DATABASE.md §8.2)', () => {
  const lookup = (over: Partial<EmployeeLookup>): EmployeeLookup => ({
    bpm: null,
    los: null,
    virtuals: [],
    selfVirtual: false,
    bpmOk: true,
    losOk: true,
    ...over,
  });
  const los = (o: Record<string, unknown>) =>
    ({
      userId: 'S112009',
      userName: '王小明',
      email: null,
      compName: '碩禾',
      compFullName: null,
      compDb: null,
      efDept: 'S1700',
      efDeptName: '製造部',
      jobName: '工程師',
      jobLevel: 'E2',
      bossId: 'S100001',
      bossEmail: null,
      jobDate: '22/3/2023',
      leaveDate: '',
      isVUser: false,
      ...o,
    }) as never;

  it('LOS 日期 d/M/yyyy 依固定格式解析', () => {
    expect(parseLosDate('22/3/2023')?.toISOString()).toBe('2023-03-22T00:00:00.000Z');
    expect(parseLosDate('')).toBeNull();
    expect(parseLosDate('2023-03-22')).toBeNull();
  });

  it('BPM 有值用 BPM,否則用 LOS', () => {
    const m = mergeProfile(
      lookup({
        bpm: {
          employeeNo: 'S112009',
          displayName: '王小明',
          email: 'a@x',
          deptCode: 'S1800',
          department: '資訊部',
          orgName: '碩禾',
          title: null,
          jobLevel: 'E2',
          managerEmployeeNo: 'S100001',
          leaveDate: null,
        } as never,
        los: los({}),
      }),
    );
    expect(m).toMatchObject({ deptCode: 'S1800', title: '工程師', profileSource: 'bpm+los', employmentStatus: 'active' });
  });

  it('兼任帳號併入本人;已離職的兼任不併入', () => {
    const m = mergeProfile(
      lookup({
        los: los({ userId: 'V112001', compName: '禾迅' }),
        virtuals: [
          los({ userId: 'GV112001', compName: '碩禾', isVUser: true }),
          los({ userId: 'XV112001', compName: '國碩', isVUser: true, leaveDate: '1/1/2024' }),
        ],
      }),
    );
    expect(m.companies.map((c) => [c.compName, c.via, c.isVirtual, c.isPrimary])).toEqual([
      ['禾迅', 'V112001', false, true],
      ['碩禾', 'GV112001', true, false],
    ]);
  });
});

const route = (o: Partial<SnapshotRoute>): SnapshotRoute =>
  ({
    routeCode: 'x.y.z',
    name: 'x',
    systemCode: 'mes',
    method: 'GET',
    publicPath: '/api/mes/x',
    routeType: 'proxy',
    upstreamCode: 'go-mes',
    upstreamMethod: null,
    upstreamPath: null,
    authMode: 'authenticated',
    permissionCode: null,
    rateLimitPolicy: null,
    cacheTtlSec: null,
    cacheScope: null,
    timeoutMs: null,
    maxBodyKb: null,
    requestHeadersAdd: null,
    responseHeadersRemove: null,
    mockResponse: null,
    auditLevel: 'none',
    status: 'published',
    deprecatedAt: null,
    steps: [],
    ...o,
  }) as SnapshotRoute;

describe('路由', () => {
  it('路徑改寫', () => {
    expect(rewritePath(route({ upstreamPath: '/v1/work-orders/:id' }), '/api/mes/work-orders/12', { id: '12' })).toBe('/v1/work-orders/12');
    expect(rewritePath(route({}), '/api/mes/work-orders/12', {})).toBe('/work-orders/12');
    expect(rewritePath(route({ upstreamPath: '/legacy/*' }), '/api/mes/a/b', { '*': 'a/b' })).toBe('/legacy/a/b');
  });

  it('聚合步驟路徑範本', () => {
    expect(renderTemplate('/v1/users/{{user.emp}}/todos?id={{params.id}}', { user: { emp: 'S112009' }, params: { id: 'a b' } })).toBe(
      '/v1/users/S112009/todos?id=a%20b',
    );
  });

  it('記憶體路由樹:明確路徑優先於萬用字元、版本只前進不回退、保留路徑略過', () => {
    const t = new RouteTable();
    const snap = (version: number, routes: SnapshotRoute[]) => ({ version, publishedAt: '', environment: 'test', upstreams: [], policies: [], routes });
    expect(
      t.apply(
        snap(2, [
          route({ routeCode: 'wild', publicPath: '/api/mes/*' }),
          route({ routeCode: 'exact', publicPath: '/api/mes/work-orders/:id' }),
          route({ routeCode: 'hijack', publicPath: '/api/auth/login', method: 'POST' }),
        ]),
      ),
    ).toBe(true);
    expect(t.find('GET', '/api/mes/work-orders/1')?.route.routeCode).toBe('exact');
    expect(t.find('GET', '/api/mes/other')?.route.routeCode).toBe('wild');
    expect(t.find('POST', '/api/auth/login')).toBeNull();
    expect(t.find('HEAD', '/api/mes/work-orders/1')?.route.routeCode).toBe('exact');
    expect(t.apply(snap(1, []))).toBe(false);
    expect(t.version).toBe(2);
  });
});

describe('OpenAPI 匯入(BACKEND-GUIDE.md §6)', () => {
  it('預設去掉版本段對應到對外路徑', () => expect(toPublicPath('mes', '/v1/work-orders/{id}')).toBe('/api/mes/work-orders/:id'));

  it('上游 port 必須在 51200–51300', () => {
    expect(checkUpstreamPort('http://mes:51210')).toBe(true);
    expect(checkUpstreamPort('http://mes:8080')).toBe(false);
    expect(checkUpstreamPort('http://mes')).toBe(false);
  });

  it('解析必填與擴充欄位;缺少 x-permission 列為錯誤', () => {
    const r = parseOpenApi({
      'x-gateway': { upstream: 'go-mes', system: 'mes' },
      'x-permissions': [{ code: 'mes.workorder.read', name: '工單查詢' }],
      paths: {
        '/v1/work-orders/{id}': {
          get: { operationId: 'mes.workorder.get', summary: '查詢工單', 'x-permission': 'mes.workorder.read', 'x-cache-ttl': 30, 'x-cache-scope': 'shared' },
        },
        '/v1/news': { get: { operationId: 'mes.news.list', summary: '公告', 'x-permission': 'public' } },
        '/v1/bad': { get: { operationId: 'mes.bad.get', summary: '缺權限' } },
        '/v1/cache': { get: { operationId: 'mes.cache.get', summary: 'x', 'x-permission': 'authenticated', 'x-cache-ttl': 5 } },
      },
    });
    expect(r.routes.find((x) => x.routeCode === 'mes.workorder.get')).toMatchObject({
      publicPath: '/api/mes/work-orders/:id',
      upstreamPath: '/v1/work-orders/:id',
      authMode: 'permission',
      permissionCode: 'mes.workorder.read',
      cacheTtlSec: 30,
      cacheScope: 'shared',
    });
    expect(r.routes.find((x) => x.routeCode === 'mes.news.list')).toMatchObject({ authMode: 'public', permissionCode: null });
    expect(r.errors.map((e) => e.operation)).toEqual(expect.arrayContaining(['mes.bad.get', 'mes.cache.get']));
  });
});
