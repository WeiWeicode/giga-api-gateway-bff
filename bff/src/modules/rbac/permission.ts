/**
 * 權限計算與快取(PRD §8.3、DATABASE.md §7.2)。
 *
 * 角色來源:employee(所有登入者)+ AD 群組對應 + 公司預設角色(含兼任公司)+ 個別指派(有效期間內)。
 * 快取:gw:perm:{userId}:{pv}(Set,15 分);權限版本 pv 變更時鍵名自然換新,舊鍵自然過期。
 * 目前 pv:gw:pv:{userId}(15 分)cache-aside,變更者提交後刪除此鍵。
 * Redis 不可用時退回資料庫查詢(PRD §12 降級)。
 */
import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { GwDatabase } from '../../db/client.js';
import { company, permission, role, roleAdGroup, roleCompany, rolePermission, user, userCompany, userRole } from '../../db/schema/index.js';

export const DEFAULT_ROLE = 'employee';
const PERM_TTL_SEC = 15 * 60;
const EMPTY = '__none__';

export const permKey = (userId: number, pv: number) => `gw:perm:${userId}:${pv}`;
export const pvKey = (userId: number) => `gw:pv:${userId}`;

export interface UserAuthz {
  userId: number;
  pv: number;
  isDisabled: boolean;
  roles: string[];
  permissions: string[];
  companies: string[];
}

function parseGroups(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 由資料庫展開使用者的角色、權限與所屬公司。 */
export async function computeAuthz(db: GwDatabase, userId: number, now = new Date()): Promise<UserAuthz> {
  const [u] = await db.select({ pv: user.permVersion, isDisabled: user.isDisabled, adGroups: user.adGroups }).from(user).where(eq(user.userId, userId));
  if (!u) throw new Error(`找不到使用者 ${userId}`);

  const companies = await db
    .selectDistinct({ id: company.companyId, name: company.compName })
    .from(userCompany)
    .innerJoin(company, eq(company.companyId, userCompany.companyId))
    .where(and(eq(userCompany.userId, userId), eq(company.isEnabled, true)));

  const groups = parseGroups(u.adGroups);
  const roleRows = new Map<number, string>();
  const add = (rows: { id: number; code: string }[]) => rows.forEach((r) => roleRows.set(r.id, r.code));

  add(await db.select({ id: role.roleId, code: role.code }).from(role).where(eq(role.code, DEFAULT_ROLE)));
  if (groups.length) {
    add(
      await db
        .selectDistinct({ id: role.roleId, code: role.code })
        .from(roleAdGroup)
        .innerJoin(role, eq(role.roleId, roleAdGroup.roleId))
        .where(inArray(roleAdGroup.adGroupDn, groups.slice(0, 1000))),
    );
  }
  if (companies.length) {
    add(
      await db
        .selectDistinct({ id: role.roleId, code: role.code })
        .from(roleCompany)
        .innerJoin(role, eq(role.roleId, roleCompany.roleId))
        .where(
          inArray(
            roleCompany.companyId,
            companies.map((c) => c.id),
          ),
        ),
    );
  }
  add(
    await db
      .select({ id: role.roleId, code: role.code })
      .from(userRole)
      .innerJoin(role, eq(role.roleId, userRole.roleId))
      .where(and(eq(userRole.userId, userId), lte(userRole.validFrom, now), or(isNull(userRole.validTo), gt(userRole.validTo, now)))),
  );

  const roleIds = [...roleRows.keys()];
  const perms = roleIds.length
    ? await db
        .selectDistinct({ code: permission.code })
        .from(rolePermission)
        .innerJoin(permission, eq(permission.permissionId, rolePermission.permissionId))
        .where(inArray(rolePermission.roleId, roleIds))
    : [];

  return {
    userId,
    pv: u.pv,
    isDisabled: u.isDisabled,
    roles: [...new Set(roleRows.values())].sort(),
    permissions: perms.map((p) => p.code).sort(),
    companies: companies.map((c) => c.name),
  };
}

export class PermissionService {
  constructor(
    private readonly db: GwDatabase,
    private readonly redis: Redis,
    private readonly log: { warn: (o: object, msg: string) => void },
  ) {}

  /** 目前的權限版本(Redis 快取,未命中或 Redis 失敗時查資料庫)。 */
  async currentPv(userId: number): Promise<number> {
    try {
      const cached = await this.redis.get(pvKey(userId));
      if (cached !== null) return Number(cached);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Redis 讀取 pv 失敗,改查資料庫');
    }
    const [u] = await this.db.select({ pv: user.permVersion }).from(user).where(eq(user.userId, userId));
    const pv = u?.pv ?? -1;
    this.redis.set(pvKey(userId), String(pv), 'EX', PERM_TTL_SEC).catch(() => undefined);
    return pv;
  }

  /** 使用者是否具備權限(快取命中時只需一次 SISMEMBER)。 */
  async has(userId: number, pv: number, code: string): Promise<boolean> {
    const key = permKey(userId, pv);
    try {
      const [[, member], [, exists]] = (await this.redis.multi().sismember(key, code).exists(key).exec()) as [[null, number], [null, number]];
      if (exists) return member === 1;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Redis 讀取權限失敗,改查資料庫');
      return (await computeAuthz(this.db, userId)).permissions.includes(code);
    }
    return (await this.load(userId, pv)).includes(code);
  }

  /** 使用者的權限清單(me、登入回應用)。 */
  async list(userId: number, pv: number): Promise<string[]> {
    try {
      const members = await this.redis.smembers(permKey(userId, pv));
      if (members.length) return members.filter((m) => m !== EMPTY).sort();
    } catch {
      return (await computeAuthz(this.db, userId)).permissions;
    }
    return this.load(userId, pv);
  }

  /** 由資料庫展開並寫入快取;只寫入與目前 pv 相符的鍵。 */
  async load(userId: number, pv: number): Promise<string[]> {
    const authz = await computeAuthz(this.db, userId);
    if (authz.pv === pv) {
      const key = permKey(userId, pv);
      await this.redis
        .multi()
        .del(key)
        .sadd(key, ...(authz.permissions.length ? authz.permissions : [EMPTY]))
        .expire(key, PERM_TTL_SEC)
        .exec()
        .catch(() => undefined);
    }
    return authz.permissions;
  }

  /** 權限版本變更後(已提交資料庫)呼叫:清除 pv 快取,下一次請求即要求 Refresh。 */
  async invalidatePv(userIds: number[] | 'all'): Promise<void> {
    if (userIds === 'all') {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'gw:pv:*', 'COUNT', 500);
        if (keys.length) await this.redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
      return;
    }
    if (userIds.length) await this.redis.del(...userIds.map(pvKey));
  }
}
