/**
 * W9-5:BFF 內建 API 清單(MONITORING-PLAN D3)
 *   - builtin-routes.generated.json 與程式同步(新增 / 修改內建 API 後要執行 npm run gen:builtin)
 *   - 每個權限代碼都在 seed(否則 IT 無法授予,API 永遠 403)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, SERVICE_PERMISSIONS } from '../../../db/seed/data.mjs';
import { generate, OUTPUT, serialize } from '../../scripts/gen-builtin-routes.js';

describe('BFF 內建 API 清單(W9-5)', () => {
  const routes = generate();

  it('generated.json 與程式一致(不一致請執行 npm run gen:builtin)', () => {
    expect(readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n')).toBe(serialize(routes));
  });

  it('管理 API 一律檢查權限,且權限代碼都在 seed', () => {
    const seeded = new Set([...ADMIN_PERMISSIONS, ...SERVICE_PERMISSIONS].map((p: { code: string }) => p.code));
    // 資料庫檢視(demo,正式區不提供)依資料表動態檢查權限
    const admin = routes.filter((r) => r.path.startsWith('/api/admin/') && !r.path.startsWith('/api/admin/db/'));
    expect(admin.length).toBeGreaterThan(80);
    for (const r of admin) expect(r.auth, `${r.method} ${r.path}`).toBe('permission');
    for (const r of routes) for (const p of r.permissions) expect(seeded.has(p), `${r.method} ${r.path}:${p} 不在 seed`).toBe(true);
  });

  it('解析得到常數、輔助函式與 app.perms.has 的權限', () => {
    const find = (m: string, p: string) => routes.find((r) => r.method === m && r.path === p);
    expect(find('POST', '/api/admin/registrations')?.permissions).toEqual(['gw.admin.route.register']);
    expect(find('GET', '/api/admin/routes/catalog')?.permissions).toEqual(['gw.admin.route.read']);
    expect(find('POST', '/api/notify/send')?.permissions).toEqual(['notify.message.send']);
    expect(find('GET', '/api/auth/me')?.auth).toBe('authenticated');
    expect(find('POST', '/api/auth/login')?.auth).toBe('public');
  });
});

describe('路由目錄併入內建 API', () => {
  it('依 q / system / status 過濾;routeCode 穩定且不與路由表格式衝突', async () => {
    const { BUILTIN_ROUTES, filterBuiltin } = await import('../../src/modules/admin/builtin-routes.js');
    const catalog = BUILTIN_ROUTES.find((r) => r.publicPath === '/api/admin/routes/catalog');
    expect(catalog).toMatchObject({ routeCode: 'gw.builtin.get.admin.routes.catalog', routeType: 'builtin', systemCode: 'gw', status: 'published' });
    expect(BUILTIN_ROUTES.find((r) => r.publicPath === '/api/admin/routes/:id/who-can-access')?.routeCode).toBe(
      'gw.builtin.get.admin.routes._id.who-can-access',
    );
    expect(new Set(BUILTIN_ROUTES.map((r) => r.routeCode)).size).toBe(BUILTIN_ROUTES.length);
    expect(
      filterBuiltin({ q: 'gw.admin.rbac.read', statuses: [] }).every((r) => r.permissions.includes('gw.admin.rbac.read') || r.publicPath.includes('rbac')),
    ).toBe(true);
    expect(filterBuiltin({ system: 'it', statuses: [] })).toEqual([]);
    expect(filterBuiltin({ statuses: ['draft'] })).toEqual([]);
  });
});
