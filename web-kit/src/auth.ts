/**
 * 使用者與權限(FRONTEND-GUIDE.md §7):啟動時呼叫一次 GET /api/auth/me 並快取。
 * 前端隱藏按鈕只是使用體驗,真正的權限檢查在 BFF。
 */
import { computed, reactive, readonly } from 'vue';
import { ApiError, http, redirectToLogin } from './http';

/**
 * 擁有的畫面權限(應用 / 選單 / Tab / 按鈕)與其所在的選單目錄(kind = group,不可授予,只用來分組);
 * name / sort / icon 可由 IT 在 GigaItApp「選單管理」修改,前端顯示選單時優先使用。
 */
export interface MeMenu {
  code: string;
  name: string;
  kind: string;
  parentCode: string | null;
  sort: number | null;
  icon: string | null;
}

export interface Me {
  user: { userId: number; employeeNo: string; name: string; email: string | null; deptCode: string | null; department: string | null; title: string | null; authType: 'ad' | 'local' };
  companies: string[];
  roles: string[];
  permissions: string[];
  menus: MeMenu[];
}

const state = reactive<{ me: Me | null; loading: Promise<Me | null> | null }>({ me: null, loading: null });

export async function loadMe(force = false): Promise<Me | null> {
  if (state.me && !force) return state.me;
  state.loading ??= http
    .get<Me>('/api/auth/me', { redirectOnAuthFailure: false })
    .then((me) => (state.me = me))
    .catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return (state.me = null);
      throw e;
    })
    .finally(() => (state.loading = null));
  return state.loading;
}

export function setMe(me: Me | null): void {
  state.me = me;
}

export async function logout(): Promise<void> {
  await http.post('/api/auth/logout').catch(() => undefined);
  state.me = null;
  location.href = '/login';
}

export function useAuth() {
  return {
    me: readonly(state) as { readonly me: Me | null },
    user: computed(() => state.me?.user ?? null),
    permissions: computed(() => state.me?.permissions ?? []),
    can: (code: string) => !!state.me?.permissions.includes(code),
    /** 權限的顯示名稱(BFF 為準);沒有此畫面權限時回 undefined,由呼叫端用前端預設文字 */
    nameOf: (code: string | undefined) => (code ? state.me?.menus?.find((m) => m.code === code)?.name : undefined),
    /** 選單 / 目錄在 BFF 的設定(名稱、上層、排序、圖示);沒有時回 undefined */
    menuOf: (code: string | undefined) => (code ? state.me?.menus?.find((m) => m.code === code) : undefined),
    loadMe,
    logout,
    requireLogin: redirectToLogin,
  };
}
