/**
 * 權限計算與快取(PRD §8.3、DATABASE.md §7.2)。
 *
 * 角色來源:employee(所有登入者)+ AD 群組對應 + 公司預設角色(含兼任公司)+ 指派規則(v0.7)+ 個別指派(有效期間內)。
 * 快取:gw:perm:{userId}:{pv}(Set,15 分);權限版本 pv 變更時鍵名自然換新,舊鍵自然過期。
 * 目前 pv:gw:pv:{userId}(15 分)cache-aside,變更者提交後刪除此鍵。
 * Redis 不可用時退回資料庫查詢(PRD §12 降級)。
 */
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { GwDatabase } from '../../db/client.js';

type Tx = Parameters<Parameters<GwDatabase['transaction']>[0]>[0];
import {
  app,
  company,
  department,
  permission,
  role,
  roleAdGroup,
  roleCompany,
  rolePermission,
  roleRule,
  user,
  userCompany,
  userRole,
} from '../../db/schema/index.js';
import { DeptTree, matchRules, parseJobLevels, type RuleDef, type UserFacts } from './rules.js';

export const DEFAULT_ROLE = 'employee';
const PERM_TTL_SEC = 15 * 60;
const EMPTY = '__none__';

export const permKey = (userId: number, pv: number) => `gw:perm:${userId}:${pv}`;
export const pvKey = (userId: number) => `gw:pv:${userId}`;

export interface AppItem {
  code: string;
  name: string;
  basePath: string;
  icon: string | null;
}

export interface UserAuthz {
  userId: number;
  pv: number;
  isDisabled: boolean;
  roles: string[];
  permissions: string[];
  companies: string[];
  /** 具備 app 權限且啟用中的應用(PRD §8.3.3) */
  apps: AppItem[];
}

/** 角色命中來源(權限試算回傳,PRD §8.7) */
export type RoleSource = 'default' | 'ad_group' | 'company' | 'rule' | 'user';

export interface AuthzFacts extends UserFacts {
  /** 個別指派(gw.user_role)只在有使用者時計算 */
  userId: number | null;
  adGroups: string[];
  companyIds: number[];
}

export interface ResolvedRole {
  roleId: number;
  code: string;
  sources: RoleSource[];
  /** 命中的指派規則 */
  ruleIds: number[];
}

export function parseGroups(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 使用者的人事事實(AD 群組、所屬公司與部門、職級、職稱) */
export async function loadUserFacts(db: GwDatabase, userId: number) {
  const [u] = await db
    .select({ pv: user.permVersion, isDisabled: user.isDisabled, adGroups: user.adGroups, deptCode: user.deptCode, jobLevel: user.jobLevel, title: user.title })
    .from(user)
    .where(eq(user.userId, userId));
  if (!u) throw new Error(`找不到使用者 ${userId}`);
  const rows = await db
    .select({ id: company.companyId, name: company.compName, deptCode: userCompany.deptCode })
    .from(userCompany)
    .innerJoin(company, eq(company.companyId, userCompany.companyId))
    .where(and(eq(userCompany.userId, userId), eq(company.isEnabled, true)));
  const companies = [...new Map(rows.map((r) => [r.id, r.name])).entries()];
  const facts: AuthzFacts = {
    userId,
    adGroups: parseGroups(u.adGroups),
    companyIds: companies.map(([id]) => id),
    // 沒有所屬公司資料(只有 AD)時以 gw.user.dept_code 比對部門
    memberships: rows.length ? rows.map((r) => ({ companyId: r.id, deptCode: r.deptCode })) : [{ companyId: null, deptCode: u.deptCode }],
    jobLevel: u.jobLevel,
    title: u.title,
  };
  return { pv: u.pv, isDisabled: u.isDisabled, companyNames: companies.map(([, name]) => name), facts };
}

/** 有效角色 = employee ∪ AD 群組 ∪ 公司預設 ∪ 指派規則 ∪ 有效的個別指派(DATABASE.md §3.2);登入與權限試算共用 */
export async function resolveRoles(db: GwDatabase, facts: AuthzFacts, now = new Date()): Promise<ResolvedRole[]> {
  const roles = new Map<number, ResolvedRole>();
  const add = (rows: { id: number; code: string }[], source: RoleSource, ruleIds: number[] = []) => {
    for (const r of rows) {
      const cur = roles.get(r.id) ?? { roleId: r.id, code: r.code, sources: [], ruleIds: [] };
      if (!cur.sources.includes(source)) cur.sources.push(source);
      cur.ruleIds.push(...ruleIds);
      roles.set(r.id, cur);
    }
  };

  add(await db.select({ id: role.roleId, code: role.code }).from(role).where(eq(role.code, DEFAULT_ROLE)), 'default');
  if (facts.adGroups.length) {
    add(
      await db
        .selectDistinct({ id: role.roleId, code: role.code })
        .from(roleAdGroup)
        .innerJoin(role, eq(role.roleId, roleAdGroup.roleId))
        .where(inArray(roleAdGroup.adGroupDn, facts.adGroups.slice(0, 1000))),
      'ad_group',
    );
  }
  if (facts.companyIds.length) {
    add(
      await db
        .selectDistinct({ id: role.roleId, code: role.code })
        .from(roleCompany)
        .innerJoin(role, eq(role.roleId, roleCompany.roleId))
        .where(inArray(roleCompany.companyId, facts.companyIds)),
      'company',
    );
  }

  // 指派規則(v0.7):規則與部門樹各一次查詢,於應用層比對
  const ruleRows = await db
    .select({ rule: roleRule, code: role.code })
    .from(roleRule)
    .innerJoin(role, eq(role.roleId, roleRule.roleId))
    .where(eq(roleRule.isEnabled, true));
  if (ruleRows.length) {
    const tree = new DeptTree(
      await db.select({ deptCode: department.deptCode, parentDeptCode: department.parentDeptCode }).from(department).where(eq(department.isEnabled, true)),
    );
    const defs: RuleDef[] = ruleRows.map(({ rule: r }) => ({
      ruleId: r.ruleId,
      roleId: r.roleId,
      companyId: r.companyId,
      deptCode: r.deptCode,
      includeSubDepts: r.includeSubDepts,
      jobLevels: parseJobLevels(r.jobLevels),
      title: r.title,
    }));
    const codes = new Map(ruleRows.map(({ rule: r, code }) => [r.roleId, code]));
    for (const [roleId, ruleIds] of matchRules(defs, facts, tree)) add([{ id: roleId, code: codes.get(roleId)! }], 'rule', ruleIds);
  }

  if (facts.userId !== null) {
    add(
      await db
        .select({ id: role.roleId, code: role.code })
        .from(userRole)
        .innerJoin(role, eq(role.roleId, userRole.roleId))
        .where(and(eq(userRole.userId, facts.userId), lte(userRole.validFrom, now), or(isNull(userRole.validTo), gt(userRole.validTo, now)))),
      'user',
    );
  }
  return [...roles.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export async function permissionsOf(db: GwDatabase, roleIds: number[]): Promise<string[]> {
  if (!roleIds.length) return [];
  const rows = await db
    .selectDistinct({ code: permission.code })
    .from(rolePermission)
    .innerJoin(permission, eq(permission.permissionId, rolePermission.permissionId))
    .where(inArray(rolePermission.roleId, roleIds));
  return rows.map((p) => p.code).sort();
}

/** 使用者可使用的應用:啟用中、且具備其 app 權限,依 sort 排序 */
export async function appsOf(db: GwDatabase, permissions: string[]): Promise<AppItem[]> {
  if (!permissions.length) return [];
  const have = new Set(permissions);
  const rows = await db.select().from(app).where(eq(app.isEnabled, true)).orderBy(asc(app.sort), asc(app.code));
  return rows.filter((a) => have.has(a.permissionCode)).map((a) => ({ code: a.code, name: a.name, basePath: a.basePath, icon: a.icon }));
}

/** 由資料庫展開使用者的角色、權限、所屬公司與應用。 */
export async function computeAuthz(db: GwDatabase, userId: number, now = new Date()): Promise<UserAuthz> {
  const { pv, isDisabled, companyNames, facts } = await loadUserFacts(db, userId);
  const roles = await resolveRoles(db, facts, now);
  const permissions = await permissionsOf(
    db,
    roles.map((r) => r.roleId),
  );
  return {
    userId,
    pv,
    isDisabled,
    roles: roles.map((r) => r.code),
    permissions,
    companies: companyNames,
    apps: await appsOf(db, permissions),
  };
}

/** 角色、權限、指派規則或部門樹變更後:遞增全體使用者的權限版本(同一交易),下一次請求即重新計算;提交後呼叫 invalidatePv('all') */
export async function bumpAllPermVersions(tx: Tx, actor: string): Promise<void> {
  await tx
    .update(user)
    .set({ permVersion: sql`${user.permVersion} + 1`, updatedBy: actor })
    .where(sql`1 = 1`);
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
