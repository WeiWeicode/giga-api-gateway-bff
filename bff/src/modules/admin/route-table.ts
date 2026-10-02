/**
 * Excel / CSV 路由匯入範本(PRD §8.4.4、P2-4):欄位對應 gw.api_route(DATABASE.md §2)。純函式,不讀資料庫。
 * 需要查資料庫的檢查(上游 / 權限 / 限流政策是否存在、路徑衝突)在 imports.ts。
 *
 * 第一列為欄位名稱(下列 key,不分大小寫),之後每列一條路由;空白列略過。聚合路由(步驟)不支援以表格匯入,請用管理介面。
 */
import { AUTH_MODES, checkPublicPath, checkRouteFields, checkSystemCode, ROUTE_METHODS, STEP_METHODS, type FieldError } from './routing-rules.js';

export const TABLE_COLUMNS = [
  { key: 'route_code', required: true, note: '路由代碼(唯一),格式 {system}.{resource}.{action},例 mes.workorder.read' },
  { key: 'name', required: true, note: '名稱' },
  { key: 'system_code', required: true, note: '系統代碼,例 mes' },
  { key: 'method', required: true, note: 'GET / POST / PUT / PATCH / DELETE / *' },
  { key: 'public_path', required: true, note: '對外路徑,/api/{system} 開頭,參數寫 :id,例 /api/mes/work-orders/:id' },
  { key: 'route_type', required: false, note: 'proxy(預設)或 mock(僅測試區)' },
  { key: 'upstream', required: false, note: 'proxy 必填:上游代碼(需已存在)' },
  { key: 'upstream_method', required: false, note: '上游方法;空白 = 與對外相同' },
  { key: 'upstream_path', required: false, note: '上游路徑,例 /v1/work-orders/:id;空白 = 去掉 /api/{system}' },
  { key: 'auth_mode', required: true, note: 'public / authenticated / permission / api_key' },
  { key: 'permission_code', required: false, note: 'auth_mode = permission 必填;api_key 選填' },
  { key: 'permission_name', required: false, note: '權限不存在且選擇「一併建立」時的權限名稱' },
  { key: 'rate_limit_policy', required: false, note: '限流政策代碼(需已存在)' },
  { key: 'cache_ttl_sec', required: false, note: 'GET 快取秒數(需同時填 cache_scope)' },
  { key: 'cache_scope', required: false, note: 'user / shared' },
  { key: 'timeout_ms', required: false, note: '逾時毫秒(100–120000)' },
  { key: 'max_body_kb', required: false, note: '請求內容上限 KB' },
  { key: 'audit_level', required: false, note: 'none(預設)/ meta / body' },
  { key: 'tags', required: false, note: '標籤,逗號分隔' },
  { key: 'owner', required: false, note: '負責人' },
  { key: 'description', required: false, note: 'API 用途說明' },
  { key: 'mock_response', required: false, note: 'mock 路由回傳的 JSON' },
] as const;

export type ColumnKey = (typeof TABLE_COLUMNS)[number]['key'];

export const TEMPLATE_EXAMPLE: Record<ColumnKey, string> = {
  route_code: 'mes.workorder.read',
  name: '查詢工單',
  system_code: 'mes',
  method: 'GET',
  public_path: '/api/mes/work-orders/:id',
  route_type: 'proxy',
  upstream: 'go-mes',
  upstream_method: '',
  upstream_path: '/v1/work-orders/:id',
  auth_mode: 'permission',
  permission_code: 'mes.workorder.read',
  permission_name: 'MES 工單:查詢',
  rate_limit_policy: '',
  cache_ttl_sec: '',
  cache_scope: '',
  timeout_ms: '',
  max_body_kb: '',
  audit_level: 'none',
  tags: 'mes',
  owner: '',
  description: '依工單號碼查詢工單明細',
  mock_response: '',
};

export interface TableRoute {
  rowNo: number;
  routeCode: string;
  name: string;
  systemCode: string;
  method: string;
  publicPath: string;
  routeType: 'proxy' | 'mock';
  upstream: string | null;
  upstreamMethod: string | null;
  upstreamPath: string | null;
  authMode: string;
  permissionCode: string | null;
  permissionName: string | null;
  rateLimitPolicy: string | null;
  cacheTtlSec: number | null;
  cacheScope: string | null;
  timeoutMs: number | null;
  maxBodyKb: number | null;
  auditLevel: string;
  tags: string | null;
  owner: string | null;
  description: string | null;
  mockResponse: string | null;
}

export interface RowError {
  rowNo: number;
  routeCode: string | null;
  field: string;
  message: string;
}

const CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/;

/** RFC 4180 CSV:引號、跳脫的雙引號、欄位內換行;去除 UTF-8 BOM */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 產生 CSV 範本(含 UTF-8 BOM,Excel 開啟不會亂碼) */
export function csvTemplate(): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const keys = TABLE_COLUMNS.map((c) => c.key);
  return `\uFEFF${keys.join(',')}\r\n${keys.map((k) => esc(TEMPLATE_EXAMPLE[k])).join(',')}\r\n`;
}

const intOf = (v: string, field: string, min: number, max: number, errs: FieldError[]): number | null => {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    errs.push({ field, message: `需為 ${min}–${max} 的整數` });
    return null;
  }
  return n;
};

/**
 * 解析表格(第一列為欄位名稱)並檢查每列欄位;回傳可匯入的路由與錯誤。
 * gwEnv 用於 mock 路由檢查(正式區不可使用)。
 */
export function parseRouteTable(rows: string[][], gwEnv: string): { routes: TableRoute[]; errors: RowError[] } {
  const errors: RowError[] = [];
  const routes: TableRoute[] = [];
  const [header, ...body] = rows;
  if (!header) return { routes, errors: [{ rowNo: 1, routeCode: null, field: '(header)', message: '檔案沒有內容' }] };
  const known = new Set<string>(TABLE_COLUMNS.map((c) => c.key));
  const index = new Map<string, number>();
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (!key) return;
    if (!known.has(key)) errors.push({ rowNo: 1, routeCode: null, field: key, message: '未知的欄位名稱' });
    else if (index.has(key)) errors.push({ rowNo: 1, routeCode: null, field: key, message: '欄位重複' });
    else index.set(key, i);
  });
  for (const c of TABLE_COLUMNS) if (c.required && !index.has(c.key)) errors.push({ rowNo: 1, routeCode: null, field: c.key, message: '缺少必要欄位' });
  if (errors.length) return { routes, errors };

  const seenCodes = new Map<string, number>();
  const seenPaths = new Map<string, number>();
  body.forEach((cells, i) => {
    const rowNo = i + 2;
    const get = (k: ColumnKey) => (index.has(k) ? (cells[index.get(k)!] ?? '').trim() : '');
    if (TABLE_COLUMNS.every((c) => !get(c.key))) return;
    const errs: FieldError[] = [];
    const routeCode = get('route_code');
    for (const c of TABLE_COLUMNS) if (c.required && !get(c.key)) errs.push({ field: c.key, message: '必填' });
    if (routeCode && !CODE.test(routeCode)) errs.push({ field: 'route_code', message: '格式需為 {system}.{resource}.{action}' });
    const method = get('method').toUpperCase();
    if (method && !(ROUTE_METHODS as readonly string[]).includes(method)) errs.push({ field: 'method', message: `需為 ${ROUTE_METHODS.join(' / ')}` });
    const routeType = (get('route_type') || 'proxy').toLowerCase();
    if (!['proxy', 'mock'].includes(routeType)) errs.push({ field: 'route_type', message: '表格匯入只支援 proxy / mock(聚合路由請用管理介面)' });
    const authMode = get('auth_mode').toLowerCase();
    if (authMode && !(AUTH_MODES as readonly string[]).includes(authMode)) errs.push({ field: 'auth_mode', message: `需為 ${AUTH_MODES.join(' / ')}` });
    const auditLevel = (get('audit_level') || 'none').toLowerCase();
    if (!['none', 'meta', 'body'].includes(auditLevel)) errs.push({ field: 'audit_level', message: '需為 none / meta / body' });
    const upstreamMethod = get('upstream_method').toUpperCase() || null;
    if (upstreamMethod && !(STEP_METHODS as readonly string[]).includes(upstreamMethod))
      errs.push({ field: 'upstream_method', message: `需為 ${STEP_METHODS.join(' / ')}` });
    const upstreamPath = get('upstream_path') || null;
    if (upstreamPath && !upstreamPath.startsWith('/')) errs.push({ field: 'upstream_path', message: '需以 / 開頭' });
    const cacheScope = get('cache_scope').toLowerCase() || null;
    if (cacheScope && !['user', 'shared'].includes(cacheScope)) errs.push({ field: 'cache_scope', message: '需為 user / shared' });
    const systemCode = get('system_code');
    const publicPath = get('public_path');
    if (systemCode) errs.push(...checkSystemCode(systemCode));
    if (systemCode && publicPath) errs.push(...checkPublicPath(systemCode, publicPath).map((e) => ({ ...e, field: 'public_path' })));

    const route: TableRoute = {
      rowNo,
      routeCode,
      name: get('name'),
      systemCode,
      method,
      publicPath,
      routeType: routeType as TableRoute['routeType'],
      upstream: get('upstream') || null,
      upstreamMethod,
      upstreamPath,
      authMode,
      permissionCode: get('permission_code') || null,
      permissionName: get('permission_name') || null,
      rateLimitPolicy: get('rate_limit_policy') || null,
      cacheTtlSec: intOf(get('cache_ttl_sec'), 'cache_ttl_sec', 1, 86_400, errs),
      cacheScope,
      timeoutMs: intOf(get('timeout_ms'), 'timeout_ms', 100, 120_000, errs),
      maxBodyKb: intOf(get('max_body_kb'), 'max_body_kb', 1, 10_240, errs),
      auditLevel,
      tags: get('tags') || null,
      owner: get('owner') || null,
      description: get('description') || null,
      mockResponse: get('mock_response') || null,
    };
    if (route.name.length > 100) errs.push({ field: 'name', message: '最多 100 字' });
    if ((route.description ?? '').length > 1000) errs.push({ field: 'description', message: '最多 1000 字' });
    if (route.permissionCode && !CODE.test(route.permissionCode)) errs.push({ field: 'permission_code', message: '權限代碼格式錯誤' });
    errs.push(
      ...checkRouteFields(
        {
          routeType: route.routeType,
          method: route.method,
          // 上游是否存在於 imports.ts 以資料庫檢查;此處只檢查有無填寫
          upstreamId: route.upstream ? 1 : null,
          authMode: route.authMode,
          permissionCode: route.permissionCode,
          cacheTtlSec: route.cacheTtlSec,
          cacheScope: route.cacheScope,
          mockResponse: route.mockResponse,
          requestHeadersAdd: null,
          responseHeadersRemove: null,
        },
        gwEnv,
      ).map((e) => ({ ...e, field: e.field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace('upstream_id', 'upstream') })),
    );
    if (routeCode) {
      const dup = seenCodes.get(routeCode);
      if (dup) errs.push({ field: 'route_code', message: `與第 ${dup} 列重複` });
      else seenCodes.set(routeCode, rowNo);
    }
    if (method && publicPath) {
      const k = `${method} ${publicPath}`;
      const dup = seenPaths.get(k);
      if (dup) errs.push({ field: 'public_path', message: `方法與對外路徑與第 ${dup} 列重複` });
      else seenPaths.set(k, rowNo);
    }
    if (errs.length) errors.push(...errs.map((e) => ({ rowNo, routeCode: routeCode || null, ...e })));
    else routes.push(route);
  });
  if (!routes.length && !errors.length) errors.push({ rowNo: 2, routeCode: null, field: '(rows)', message: '沒有任何路由' });
  return { routes, errors };
}
