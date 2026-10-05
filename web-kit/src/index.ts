/**
 * @giganexus/web-kit(FRONTEND-GUIDE.md §6)
 *
 *   app.use(createWebKit({ router }))
 *   const { user, can } = useAuth()
 *   await http.get('/api/mes/work-orders')
 *   const { menu, trail, isOpen, toggle } = useMenuTree(MENU)   // 多層側邊選單(§7.5)
 */
import type { App } from 'vue';
import type { Router } from 'vue-router';
import { loadMe, useAuth } from './auth';
import { redirectToLogin } from './http';

export { ApiError, http, readCookie, redirectToLogin, refreshSession, request } from './http';
export type { RequestOptions } from './http';
export { loadMe, logout, setMe, useAuth } from './auth';
export type { Me } from './auth';
export { filterMenu, findTrail, flattenMenu, menuKeys, pathMatches } from './menu';
export type { MenuNode, VisibleMenuNode } from './menu';
export { GnMenuTree, useMenuTree } from './menu-tree';
export type { MenuItemSlotProps, MenuTreeOptions } from './menu-tree';

declare module 'vue-router' {
  interface RouteMeta {
    /** 需要的權限代碼,無權限導向 forbiddenPath */
    permission?: string;
    /** true = 不需登入(例如入口網的 /login) */
    public?: boolean;
  }
}

export interface WebKitOptions {
  router: Router;
  /** 無權限時導向的頁面(相對於 SPA base) */
  forbiddenPath?: string;
}

export function createWebKit(opts: WebKitOptions) {
  return {
    install(app: App) {
      app.config.globalProperties.$can = (code: string) => useAuth().can(code);
      // 路由守衛:未登入 → /login?redirect=...;缺少 meta.permission → 403 頁
      opts.router.beforeEach(async (to) => {
        if (to.meta.public) return true;
        const me = await loadMe().catch(() => null);
        if (!me) {
          redirectToLogin();
          return false;
        }
        if (to.meta.permission && !me.permissions.includes(to.meta.permission)) return opts.forbiddenPath ?? '/403';
        return true;
      });
    },
  };
}
