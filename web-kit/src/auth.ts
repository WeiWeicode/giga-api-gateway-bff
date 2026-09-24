/**
 * 使用者與權限(FRONTEND-GUIDE.md §7):啟動時呼叫一次 GET /api/auth/me 並快取。
 * 前端隱藏按鈕只是使用體驗,真正的權限檢查在 BFF。
 */
import { computed, reactive, readonly } from 'vue';
import { ApiError, http, redirectToLogin } from './http';

export interface Me {
  user: { userId: number; employeeNo: string; name: string; email: string | null; deptCode: string | null; department: string | null; title: string | null; authType: 'ad' | 'local' };
  companies: string[];
  roles: string[];
  permissions: string[];
  menus: unknown[];
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
    loadMe,
    logout,
    requireLogin: redirectToLogin,
  };
}
