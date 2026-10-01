/**
 * 本機帳號管理(PRD §8.2.5、§8.7、P2-3):IT 代建、核准待審核、重設密碼、解鎖、停用。
 * CLI(local:*)與管理 API(/api/admin/local-accounts)共用;不符條件時丟出 VALIDATION_FAILED(訊息即原因)。
 *
 * 啟用連結 / 臨時密碼只回傳給呼叫端一次(明文不寫入 log 與稽核),由 IT 以安全管道交給本人。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { GwDatabase } from '../../db/client.js';
import { localAccountToken, localCredential, user } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import type { ExternalDb } from '../../plugins/db.js';
import type { AdDirectory } from '../auth/ldap.js';
import { hashPassword, pushHistory } from '../auth/password.js';
import { applyProfile, isValidEmpNo, lookupEmployee, mergeProfile, normalizeEmpNo } from '../auth/profile.js';
import { revokeUserSessions } from '../auth/session.js';
import { pvKey } from '../rbac/permission.js';
import { writeAudit, type AuditActor } from './audit-log.js';
import type { Tx } from './route-import.js';

/** IT 代建 / 核准的啟用連結有效時間(DATABASE.md §3.1) */
export const ACTIVATE_TTL_HOURS = 72;

export interface LocalAdminDeps {
  db: GwDatabase;
  redis: Redis;
}

const reject = (message: string): never => {
  throw new GwError('VALIDATION_FAILED', message, [{ field: 'employeeNo', message }]);
};

export function activationLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/register/activate?token=${token}`;
}

/** 產生啟用 token(同用途舊 token 一併作廢);回傳明文 */
async function issueActivateToken(tx: Tx, userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await tx
    .update(localAccountToken)
    .set({ usedAt: new Date() })
    .where(and(eq(localAccountToken.userId, userId), eq(localAccountToken.purpose, 'activate'), isNull(localAccountToken.usedAt)));
  await tx.insert(localAccountToken).values({
    userId,
    purpose: 'activate',
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + ACTIVATE_TTL_HOURS * 3600 * 1000),
  });
  return token;
}

async function findLocal(db: GwDatabase, emp: string) {
  const [row] = await db
    .select({ userId: user.userId, cred: localCredential })
    .from(user)
    .innerJoin(localCredential, eq(localCredential.userId, user.userId))
    .where(eq(user.employeeNo, emp));
  return row;
}

/** IT 代建:LOS / BPM 須查得到、在職、非兼任,且所有 AD 網域都查無此帳號(一個工號只有一種驗證方式) */
export async function createLocalAccount(
  deps: LocalAdminDeps & { ad: AdDirectory; ext: { bpm?: ExternalDb; los?: ExternalDb } },
  empArg: string,
  actor: AuditActor,
): Promise<{ employeeNo: string; userId: number; token: string }> {
  const emp = normalizeEmpNo(empArg);
  if (!isValidEmpNo(emp)) reject(`工號格式錯誤:${empArg}`);
  for (const code of deps.ad.codes) {
    let exists: boolean;
    try {
      exists = await deps.ad.exists(code, emp);
    } catch (err) {
      // AD 無法查詢時不可建立,避免同一工號同時有 AD 與本機帳號
      throw new GwError('INTERNAL_ERROR', `AD 網域 ${code} 查詢失敗,請稍後再試(${(err as Error).message})`);
    }
    if (exists) reject(`${emp} 在 AD 網域 ${code} 已有帳號,不可建立本機帳號`);
  }
  const lookup = await lookupEmployee(deps.ext, emp);
  if (!lookup.bpmOk && !lookup.losOk) throw new GwError('INTERNAL_ERROR', 'BPM 與 LOS 都無法查詢,請稍後再試');
  if (lookup.selfVirtual) reject(`${emp} 為兼任帳號,不可單獨登入`);
  const merged = mergeProfile(lookup);
  if (merged.profileSource === 'ad_only') reject(`${emp} 在 LOS / BPM 查無資料`);
  if (merged.employmentStatus === 'resigned') reject(`${emp} 已離職`);

  return deps.db.transaction(async (tx) => {
    let [u] = await tx.select({ id: user.userId }).from(user).where(eq(user.employeeNo, emp));
    if (!u)
      [u] = await tx
        .insert(user)
        .output({ id: user.userId })
        .values({ employeeNo: emp, displayName: merged.displayName ?? emp, profileSource: merged.profileSource, createdBy: actor.name, updatedBy: actor.name });
    await applyProfile(tx, u!.id, merged, actor.name);
    const [cred] = await tx.select().from(localCredential).where(eq(localCredential.userId, u!.id));
    if (cred?.status === 'active' || cred?.status === 'locked') reject(`${emp} 已有啟用中的本機帳號`);
    if (cred)
      await tx
        .update(localCredential)
        .set({ status: 'pending_verify', registeredVia: 'admin', mustChangePassword: false, updatedBy: actor.name })
        .where(eq(localCredential.userId, u!.id));
    else
      await tx
        .insert(localCredential)
        .values({ userId: u!.id, status: 'pending_verify', registeredVia: 'admin', createdBy: actor.name, updatedBy: actor.name });
    const token = await issueActivateToken(tx, u!.id);
    await writeAudit(tx, actor, 'local.create', 'user', emp, cred ? { status: cred.status } : null, {
      emp,
      companies: merged.companies.map((c) => c.compName),
    });
    return { employeeNo: emp, userId: u!.id, token };
  });
}

/** 核准自行註冊的待審核申請(LOS / BPM 查無者由管理員確認身分) */
export async function approveLocalAccount(
  deps: LocalAdminDeps,
  empArg: string,
  actor: AuditActor,
): Promise<{ employeeNo: string; userId: number; token: string }> {
  const emp = normalizeEmpNo(empArg);
  const row = await findLocal(deps.db, emp);
  if (row?.cred.status !== 'pending_approval') reject(`${emp} 沒有待審核的註冊申請`);
  return deps.db.transaction(async (tx) => {
    await tx
      .update(localCredential)
      .set({ status: 'pending_verify', approvedBy: actor.name.slice(0, 64), approvedAt: new Date(), updatedBy: actor.name })
      .where(eq(localCredential.userId, row!.userId));
    const token = await issueActivateToken(tx, row!.userId);
    await writeAudit(tx, actor, 'local.approve', 'user', emp, { status: 'pending_approval' }, { status: 'pending_verify' });
    return { employeeNo: emp, userId: row!.userId, token };
  });
}

/** IT 重設密碼(無 Email 者):臨時密碼只回傳一次,首次登入須更換;解除鎖定並撤銷所有登入 */
export async function resetLocalPassword(
  deps: LocalAdminDeps,
  empArg: string,
  actor: AuditActor,
): Promise<{ employeeNo: string; userId: number; temporaryPassword: string; revokedSessions: number }> {
  const emp = normalizeEmpNo(empArg);
  const row = await findLocal(deps.db, emp);
  if (!row || !['active', 'locked'].includes(row.cred.status)) reject(`${emp} 沒有啟用中或鎖定的本機帳號`);
  // 臨時密碼:12 碼英數,保證含英文與數字(符合 Q14)
  const temp = `${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}a1`;
  const passwordHash = await hashPassword(temp);
  await deps.db.transaction(async (tx) => {
    await tx
      .update(localCredential)
      .set({
        passwordHash,
        passwordHistory: pushHistory(row!.cred.passwordHash, row!.cred.passwordHistory),
        passwordChangedAt: new Date(),
        status: 'active',
        failedCount: 0,
        lockedAt: null,
        mustChangePassword: true,
        updatedBy: actor.name,
      })
      .where(eq(localCredential.userId, row!.userId));
    await writeAudit(tx, actor, 'local.reset', 'user', emp, { status: row!.cred.status }, { status: 'active', mustChangePassword: true });
  });
  const revoked = await revokeUserSessions(deps.redis, row!.userId).catch(() => -1);
  await deps.redis.del(`gw:login:fail:${emp}`).catch(() => undefined);
  return { employeeNo: emp, userId: row!.userId, temporaryPassword: temp, revokedSessions: revoked };
}

/** 解除鎖定(連續失敗 10 次)並清除登入失敗計數 */
export async function unlockLocalAccount(deps: LocalAdminDeps, empArg: string, actor: AuditActor): Promise<{ employeeNo: string; unlocked: true }> {
  const emp = normalizeEmpNo(empArg);
  const row = await findLocal(deps.db, emp);
  if (!row) reject(`${emp} 沒有本機帳號`);
  await deps.db.transaction(async (tx) => {
    await tx
      .update(localCredential)
      .set({ status: 'active', failedCount: 0, lockedAt: null, updatedBy: actor.name })
      .where(and(eq(localCredential.userId, row!.userId), eq(localCredential.status, 'locked')));
    await tx.update(localCredential).set({ failedCount: 0, updatedBy: actor.name }).where(eq(localCredential.userId, row!.userId));
    await writeAudit(tx, actor, 'local.unlock', 'user', emp, { status: row!.cred.status, failedCount: row!.cred.failedCount }, {});
  });
  await deps.redis.del(`gw:login:fail:${emp}`).catch(() => undefined);
  return { employeeNo: emp, unlocked: true };
}

/**
 * 停用本機帳號(例:子公司加入 AD 網域後改走 AD,PRD §8.2.5):撤銷所有登入、遞增 pv 讓 Access Token 立即失效。
 * 重新啟用以代建(createLocalAccount)產生新的啟用連結。
 */
export async function disableLocalAccount(deps: LocalAdminDeps, empArg: string, actor: AuditActor): Promise<{ employeeNo: string; revokedSessions: number }> {
  const emp = normalizeEmpNo(empArg);
  const row = await findLocal(deps.db, emp);
  if (!row) reject(`${emp} 沒有本機帳號`);
  if (row!.cred.status === 'disabled') reject(`${emp} 的本機帳號已停用`);
  await deps.db.transaction(async (tx) => {
    await tx.update(localCredential).set({ status: 'disabled', updatedBy: actor.name }).where(eq(localCredential.userId, row!.userId));
    await tx
      .update(user)
      .set({ permVersion: sql`${user.permVersion} + 1`, updatedBy: actor.name })
      .where(eq(user.userId, row!.userId));
    // 尚未使用的啟用 / 重設連結一併作廢
    await tx
      .update(localAccountToken)
      .set({ usedAt: new Date() })
      .where(and(eq(localAccountToken.userId, row!.userId), isNull(localAccountToken.usedAt)));
    await writeAudit(tx, actor, 'local.disable', 'user', emp, { status: row!.cred.status }, { status: 'disabled' });
  });
  const revoked = await revokeUserSessions(deps.redis, row!.userId).catch(() => -1);
  await deps.redis.del(pvKey(row!.userId)).catch(() => undefined);
  return { employeeNo: emp, revokedSessions: revoked };
}
