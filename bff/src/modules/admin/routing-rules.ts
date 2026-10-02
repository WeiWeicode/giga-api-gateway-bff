/**
 * 路由管理 API 的欄位檢查(PRD §8.4.1、§8.7、DATABASE.md §2):純函式,不讀資料庫。
 * 需要查資料庫的檢查(上游 / 權限 / 政策是否存在、路徑衝突)在 routing.ts。
 */
import { checkUpstreamPort } from '../../cli/openapi.js';

export type FieldError = { field: string; message: string };

export const ROUTE_TYPES = ['proxy', 'aggregate', 'mock'] as const;
export const AUTH_MODES = ['public', 'authenticated', 'permission', 'api_key'] as const;
export const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'] as const;
export const STEP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const KEY_BY = ['user', 'ip', 'client', 'route'] as const;

/** BFF 內建、不由路由表提供的系統代碼(PRD §14.1) */
const RESERVED_SYSTEMS = new Set(['auth', 'admin']);
const SYSTEM_CODE = /^[a-z][a-z0-9-]{1,29}$/;
const PATH_SEGMENT = /^(:[A-Za-z_][A-Za-z0-9_]*|\*|[A-Za-z0-9._~-]+)$/;

export function checkSystemCode(systemCode: string): FieldError[] {
  if (!SYSTEM_CODE.test(systemCode)) return [{ field: 'systemCode', message: '系統代碼需為小寫英數與 -,2–30 字' }];
  if (RESERVED_SYSTEMS.has(systemCode)) return [{ field: 'systemCode', message: `${systemCode} 為 BFF 內建,不可使用` }];
  return [];
}

/** 對外路徑:/api/{system_code} 開頭;區段為文字、:參數或結尾的 * */
export function checkPublicPath(systemCode: string, publicPath: string): FieldError[] {
  const prefix = `/api/${systemCode}`;
  if (publicPath !== prefix && !publicPath.startsWith(`${prefix}/`)) return [{ field: 'publicPath', message: `對外路徑需以 ${prefix} 開頭` }];
  const segs = publicPath.split('/').slice(1);
  const bad = segs.findIndex((s, i) => !PATH_SEGMENT.test(s) || (s === '*' && i !== segs.length - 1));
  if (bad >= 0) return [{ field: 'publicPath', message: `路徑區段不合法:${segs[bad] || '(空白)'}` }];
  return [];
}

export function checkTargetUrl(baseUrl: string): 'ok' | 'invalid' | 'port' {
  try {
    const u = new URL(baseUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.pathname !== '/' || u.search) return 'invalid';
    return checkUpstreamPort(baseUrl) ? 'ok' : 'port';
  } catch {
    return 'invalid';
  }
}

export interface RouteFields {
  routeType: string;
  method: string;
  upstreamId: number | null;
  authMode: string;
  permissionCode: string | null;
  cacheTtlSec: number | null;
  cacheScope: string | null;
  mockResponse: string | null;
  requestHeadersAdd: string | null;
  responseHeadersRemove: string | null;
}

function jsonOf(raw: string | null): { ok: true; value: unknown } | { ok: false } {
  if (raw == null) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** 欄位之間的關聯檢查(合併 PATCH 後的完整值) */
export function checkRouteFields(r: RouteFields, gwEnv: string): FieldError[] {
  const errors: FieldError[] = [];
  if (r.routeType === 'proxy' && r.upstreamId == null) errors.push({ field: 'upstreamId', message: 'proxy 路由必須指定上游' });
  if (r.routeType !== 'proxy' && r.upstreamId != null) errors.push({ field: 'upstreamId', message: '只有 proxy 路由可指定上游(聚合路由於步驟指定)' });
  if (r.routeType === 'mock' && gwEnv === 'prod') errors.push({ field: 'routeType', message: 'mock 路由僅測試區可使用' });
  if (r.routeType === 'mock' && r.mockResponse == null) errors.push({ field: 'mockResponse', message: 'mock 路由必須設定回應內容' });
  if (r.routeType !== 'mock' && r.mockResponse != null) errors.push({ field: 'mockResponse', message: '只有 mock 路由可設定回應內容' });
  if (r.authMode === 'permission' && !r.permissionCode) errors.push({ field: 'permissionCode', message: 'auth_mode=permission 時必須指定權限代碼' });
  // api_key:選填,指定時 API Key 須具備該權限(P2-5)
  if (!['permission', 'api_key'].includes(r.authMode) && r.permissionCode)
    errors.push({ field: 'permissionCode', message: '只有 auth_mode=permission 或 api_key 可指定權限代碼' });
  if (r.cacheTtlSec != null && r.method !== 'GET') errors.push({ field: 'cacheTtlSec', message: '快取僅適用 GET' });
  if ((r.cacheTtlSec == null) !== (r.cacheScope == null)) errors.push({ field: 'cacheScope', message: 'cacheTtlSec 與 cacheScope 需同時設定' });
  if (r.cacheScope === 'shared' && r.authMode === 'permission')
    errors.push({ field: 'cacheScope', message: '需權限的路由不可使用共用快取(不同使用者會看到彼此的資料)' });

  const mock = jsonOf(r.mockResponse);
  if (!mock.ok) errors.push({ field: 'mockResponse', message: '需為 JSON' });
  const add = jsonOf(r.requestHeadersAdd);
  if (
    !add.ok ||
    (add.value != null && (typeof add.value !== 'object' || Array.isArray(add.value) || Object.values(add.value).some((v) => typeof v !== 'string')))
  )
    errors.push({ field: 'requestHeadersAdd', message: '需為 JSON 物件,值為字串' });
  const remove = jsonOf(r.responseHeadersRemove);
  if (!remove.ok || (remove.value != null && (!Array.isArray(remove.value) || remove.value.some((v) => typeof v !== 'string'))))
    errors.push({ field: 'responseHeadersRemove', message: '需為字串陣列 JSON' });
  return errors;
}

export interface StepInput {
  stepKey: string;
  stepOrder: number;
  pathTemplate: string;
}

export function checkSteps(steps: StepInput[]): FieldError[] {
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    if (seen.has(s.stepKey)) errors.push({ field: `steps[${i}].stepKey`, message: `步驟代碼重複:${s.stepKey}` });
    seen.add(s.stepKey);
    if (!s.pathTemplate.startsWith('/')) errors.push({ field: `steps[${i}].pathTemplate`, message: '路徑需以 / 開頭' });
  });
  return errors;
}
