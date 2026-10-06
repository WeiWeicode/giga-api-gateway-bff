/**
 * BFF 內建 API 列入路由目錄(MONITORING-PLAN D3、W9-5)
 *
 * BFF 自己的 API 不經動態路由表(PRD §14.1),不能「註冊成草稿」(IT 發佈了也不生效)。改以唯讀項目(routeType = builtin)
 * 併入 GET /api/admin/routes/catalog,讓工程師查詢既有 API、IT 查權限時看得到;權限代碼取自 scripts/gen-builtin-routes.ts
 * 解析原始碼產生的 builtin-routes.generated.json(單元測試確保與程式同步)。
 * 「誰能存取」以權限代碼查詢:GET /api/admin/permissions/:code/who-can-access。
 */
import routes from './builtin-routes.generated.json' with { type: 'json' };

export interface BuiltinCatalogRoute {
  routeCode: string;
  name: string;
  systemCode: string;
  method: string;
  publicPath: string;
  routeType: 'builtin';
  upstream: null;
  project: string;
  upstreamPath: null;
  authMode: 'permission' | 'authenticated' | 'public';
  permissionCode: string | null;
  /** 任一即可(少數 API 接受多個權限) */
  permissions: string[];
  status: 'published';
  tags: string;
  description: string;
  gherkin: null;
}

const BFF_PROJECT = 'giga-api-gateway-bff';

/** routeCode:gw.builtin.{方法}.{路徑},路徑的 / 與 : 轉成 . 與 _,穩定且不與路由表衝突 */
function codeOf(method: string, path: string): string {
  const slug = path
    .replace(/^\/api\//, '')
    .replace(/:(\w+)/g, '_$1')
    .replace(/\//g, '.')
    .replace(/[^A-Za-z0-9._-]/g, '');
  return `gw.builtin.${method.toLowerCase()}.${slug}`;
}

export const BUILTIN_ROUTES: BuiltinCatalogRoute[] = routes.map((r) => ({
  routeCode: codeOf(r.method, r.path),
  name: r.summary ?? `${r.method} ${r.path}`,
  systemCode: 'gw',
  method: r.method,
  publicPath: r.path,
  routeType: 'builtin',
  upstream: null,
  project: BFF_PROJECT,
  upstreamPath: null,
  authMode: r.auth as BuiltinCatalogRoute['authMode'],
  permissionCode: r.permissions[0] ?? null,
  permissions: r.permissions,
  status: 'published',
  tags: 'BFF 內建',
  description: `BFF 內建 API(bff/src/${r.module}),不經路由表、不需發佈`,
  gherkin: null,
}));

/** 依目錄查詢條件過濾(與路由表相同語意:q 比對代碼、名稱、路徑、權限、開發專案;system;status) */
export function filterBuiltin(query: { q?: string; system?: string; statuses: string[] }): BuiltinCatalogRoute[] {
  if (query.system && query.system !== 'gw') return [];
  if (query.statuses.length && !query.statuses.includes('published')) return [];
  const q = query.q?.trim().toLowerCase();
  if (!q) return BUILTIN_ROUTES;
  return BUILTIN_ROUTES.filter((r) => [r.routeCode, r.name, r.publicPath, r.project, r.tags, ...r.permissions].some((v) => v.toLowerCase().includes(q)));
}
