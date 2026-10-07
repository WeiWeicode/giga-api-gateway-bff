/**
 * @giganexus/web-kit(FRONTEND-GUIDE.md §6)
 *
 *   app.use(createWebKit({ router }))
 *   const { user, can } = useAuth()
 *   await http.get('/api/mes/work-orders')
 *   const { menu, trail, isOpen, toggle } = useMenuTree(MENU)   // 多層側邊選單(§7.5)
 *   installMonitor({ app: 'itapp-web', router, vueApp: app })   // 前端健康度回報(MONITORING-PLAN W9-9)
 *   useNotifyCenter('itapp').start()                             // 通知與公告(NOTIFY-PLAN §6.5);內文樣式 import '@giganexus/web-kit/src/notify-content.css'
 */
import type { App } from 'vue';
import type { Router } from 'vue-router';
import { loadMe, useAuth } from './auth';
import { redirectToLogin } from './http';

export { ApiError, http, readCookie, redirectToLogin, refreshSession, request, setApiFailureHook } from './http';
export type { ApiFailure, RequestOptions } from './http';
export { installMonitor, rate, WebMonitorCore } from './monitor';
export type { WebEvent, WebEventType, WebMonitorOptions } from './monitor';
export { loadMe, logout, setMe, useAuth } from './auth';
export type { Me, MeMenu } from './auth';
export { filterMenu, findTrail, flattenMenu, menuKeys, pathMatches } from './menu';
export type { MenuNode, VisibleMenuNode } from './menu';
export { GnMenuTree, useMenuTree } from './menu-tree';
export type { MenuItemSlotProps, MenuTreeOptions } from './menu-tree';
export { createNotifyClient, desktopPermission, enableDesktopNotify, notifyApi, sanitizeHtml, useAnnouncementArchive, useNotifyCenter } from './notify';
export type { ArriveMessage, DesktopPermission, NotifyCenter, NotifyClient } from './notify';
export { LEVEL_NAMES, presentationOf, reconnectDelay } from './notify-core';
export type {
  AnnounceChannel,
  AnnouncementDetail,
  AnnouncementInput,
  AnnouncementRow,
  AnnouncementStatus,
  Audience,
  AudienceDept,
  AudiencePreview,
  ComposeOptions,
  Feed,
  FeedItem,
  NotifyApp,
  NotifyLevel,
  NotifySettings,
  NotifySocketMessage,
  Receipts,
} from './notify-core';

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
