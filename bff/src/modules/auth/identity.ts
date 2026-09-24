/**
 * 由 gw.user 與權限計算組成 Token claims 與 /api/auth/me 回應(PRD §8.2.2、FRONTEND-GUIDE.md §7.2)。
 */
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { GwDatabase } from '../../db/client.js';
import { user } from '../../db/schema/index.js';
import { computeAuthz, permKey } from '../rbac/permission.js';
import type { IdentityClaims } from './keys.js';

export interface MeResponse {
  user: {
    userId: number;
    employeeNo: string;
    name: string;
    email: string | null;
    deptCode: string | null;
    department: string | null;
    title: string | null;
    authType: 'ad' | 'local';
    adDomain: string | null;
  };
  companies: string[];
  roles: string[];
  permissions: string[];
  menus: unknown[];
}

export interface Identity {
  userId: number;
  pv: number;
  isDisabled: boolean;
  claims: IdentityClaims;
  me: MeResponse;
}

export async function buildIdentity(db: GwDatabase, redis: Redis, userId: number, amr: 'ad' | 'local'): Promise<Identity> {
  const [u] = await db.select().from(user).where(eq(user.userId, userId));
  if (!u) throw new Error(`找不到使用者 ${userId}`);
  const authz = await computeAuthz(db, userId);

  // 登入 / Refresh 時順便更新權限快取
  const key = permKey(userId, authz.pv);
  redis
    .multi()
    .del(key)
    .sadd(key, ...(authz.permissions.length ? authz.permissions : ['__none__']))
    .expire(key, 15 * 60)
    .set(`gw:pv:${userId}`, String(authz.pv), 'EX', 15 * 60)
    .exec()
    .catch(() => undefined);

  const claims: IdentityClaims = {
    sub: String(userId),
    emp: u.employeeNo,
    upn: amr === 'ad' ? u.upn : null,
    name: u.displayName,
    dept: u.deptCode,
    cos: authz.companies,
    amr,
    roles: authz.roles,
  };
  return {
    userId,
    pv: authz.pv,
    isDisabled: authz.isDisabled,
    claims,
    me: {
      user: {
        userId,
        employeeNo: u.employeeNo,
        name: u.displayName,
        email: u.email,
        deptCode: u.deptCode,
        department: u.department,
        title: u.title,
        authType: amr,
        adDomain: amr === 'ad' ? u.adDomain : null,
      },
      companies: authz.companies,
      roles: authz.roles,
      permissions: authz.permissions,
      menus: [],
    },
  };
}
