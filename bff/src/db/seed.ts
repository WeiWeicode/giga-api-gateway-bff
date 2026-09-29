/**
 * 匯入種子資料(db/seed/data.ts),可重複執行:`npm run db:seed`
 * 部署時由 migrate 容器在 migration 後執行(node dist/bff/src/db/seed.js)。
 */
import { pathToFileURL } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createGwDb, openPool, type GwDatabase } from './client.js';
import { company, companyAdDomain, permission, rateLimitPolicy, role, rolePermission } from './schema/index.js';
import { ADMIN_PERMISSIONS, COMPANIES, RATE_LIMIT_POLICIES, ROLE_PERMISSIONS, ROLES, SEED_ACTOR } from '../../../db/seed/data.mjs';

export interface SeedResult {
  roles: number;
  permissions: number;
  rolePermissions: number;
  policies: number;
  companies: number;
  companyDomains: number;
}

const audit = { createdBy: SEED_ACTOR, updatedBy: SEED_ACTOR };

export async function runSeed(db: GwDatabase): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const result: SeedResult = { roles: 0, permissions: 0, rolePermissions: 0, policies: 0, companies: 0, companyDomains: 0 };

    // 角色
    const existingRoles = new Set((await tx.select({ code: role.code }).from(role)).map((r) => r.code));
    const newRoles = ROLES.filter((r) => !existingRoles.has(r.code));
    if (newRoles.length) await tx.insert(role).values(newRoles.map((r) => ({ ...r, ...audit })));
    result.roles = newRoles.length;

    // 權限
    const existingPerms = new Set((await tx.select({ code: permission.code }).from(permission)).map((p) => p.code));
    const newPerms = ADMIN_PERMISSIONS.filter((p) => !existingPerms.has(p.code));
    if (newPerms.length) {
      await tx.insert(permission).values(
        newPerms.map((p) => {
          const [, , resource, action = 'manage'] = p.code.split('.');
          return { code: p.code, name: p.name, systemCode: 'gw', resource: resource ?? 'admin', action, ...audit };
        }),
      );
    }
    result.permissions = newPerms.length;

    // 角色 ↔ 權限(只補缺少的)
    const roleIds = new Map((await tx.select({ id: role.roleId, code: role.code }).from(role)).map((r) => [r.code, r.id]));
    const permIds = new Map(
      (
        await tx
          .select({ id: permission.permissionId, code: permission.code })
          .from(permission)
          .where(
            inArray(
              permission.code,
              ADMIN_PERMISSIONS.map((p) => p.code),
            ),
          )
      ).map((p) => [p.code, p.id]),
    );
    for (const [roleCode, permCodes] of Object.entries(ROLE_PERMISSIONS)) {
      const roleId = roleIds.get(roleCode);
      if (roleId === undefined || permCodes.length === 0) continue;
      const have = new Set(
        (await tx.select({ id: rolePermission.permissionId }).from(rolePermission).where(eq(rolePermission.roleId, roleId))).map((r) => r.id),
      );
      const missing = permCodes.map((c) => permIds.get(c)).filter((id): id is number => id !== undefined && !have.has(id));
      if (missing.length) {
        await tx.insert(rolePermission).values(missing.map((permissionId) => ({ roleId, permissionId, createdBy: SEED_ACTOR })));
        result.rolePermissions += missing.length;
      }
    }

    // 限流政策
    const existingPolicies = new Set((await tx.select({ code: rateLimitPolicy.code }).from(rateLimitPolicy)).map((p) => p.code));
    const newPolicies = RATE_LIMIT_POLICIES.filter((p) => !existingPolicies.has(p.code));
    if (newPolicies.length) await tx.insert(rateLimitPolicy).values(newPolicies.map((p) => ({ ...p, ...audit })));
    result.policies = newPolicies.length;

    // 公司與 AD 網域
    for (const c of COMPANIES) {
      let [row] = await tx.select({ id: company.companyId }).from(company).where(eq(company.compName, c.compName));
      if (!row) {
        [row] = await tx
          .insert(company)
          .output({ id: company.companyId })
          .values({ compName: c.compName, empPrefix: c.empPrefix, ...audit });
        result.companies++;
      }
      const companyId = row!.id;
      for (const [i, domainCode] of c.domains.entries()) {
        const [exists] = await tx
          .select({ d: companyAdDomain.domainCode })
          .from(companyAdDomain)
          .where(and(eq(companyAdDomain.companyId, companyId), eq(companyAdDomain.domainCode, domainCode)));
        if (!exists) {
          await tx.insert(companyAdDomain).values({ companyId, domainCode, tryOrder: i + 1 });
          result.companyDomains++;
        }
      }
    }

    return result;
  });
}

// 以 pathToFileURL 比對:Windows 的 argv[1] 為 D:\...,直接接 file:// 永遠不相等,指令會不執行就結束
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  const config = loadConfig();
  const pool = await openPool(config.gwDb, { appName: 'giganexus-gw-seed', poolMax: 1 });
  try {
    const result = await runSeed(createGwDb(pool, config.sql2012Guard));
    console.log('seed 完成', result);
  } catch (err) {
    console.error('seed 失敗', err);
    process.exitCode = 1;
  } finally {
    await pool.close();
  }
}
