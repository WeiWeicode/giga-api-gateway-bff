/**
 * 本機帳號自行註冊與忘記密碼(PRD §8.2.5、W3-5.8a / W3-5.8b):
 *
 *   register  工號 + 姓名(無 Email 者另附到職日與密碼)
 *             AD 任一網域有帳號、已註冊、已離職、姓名或到職日不符 → REGISTRATION_NOT_ALLOWED(一律同一代碼)
 *             LOS / BPM 有 Email → 寄驗證連結(30 分鐘)到登記的 Email(不接受自填)→ VERIFICATION_SENT
 *             LOS / BPM 無 Email → 比對 LOS 到職日 → 直接啟用並通知主管
 *             LOS / BPM 都查無 → pending_approval,由 IT 審核(CLI local:approve)→ REGISTRATION_PENDING_APPROVAL
 *   forgot    本機帳號且有 Email → 寄重設連結(30 分鐘);其餘情況回應相同、不寄信
 *   reset     以重設連結設定新密碼,解除鎖定並撤銷所有 Refresh Token 家族
 *
 * 限流(DATABASE.md §6):gw:reg:ip:{ip} 每小時 10 次、gw:reg:emp:{工號} 每小時 3 次,註冊與忘記密碼共用。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { GwDatabase } from '../../db/client.js';
import { localAccountToken, localCredential, user } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import type { ExternalDb } from '../../plugins/db.js';
import type { NotifyService } from '../notify/send.js';
import type { AdDirectory } from './ldap.js';
import { writeAuthLog } from './login.js';
import { checkPasswordPolicy, hashPassword, isReused, POLICY_MESSAGES, pushHistory } from './password.js';
import { applyProfile, isValidEmpNo, lookupEmployee, mergeProfile, normalizeEmpNo, parseLosDate } from './profile.js';

export const TOKEN_TTL_MIN = 30;
const REG_IP_LIMIT = 10;
const REG_EMP_LIMIT = 3;
const REG_WINDOW_SEC = 60 * 60;
const ACTOR = 'self-service';

/** 系統通知範本(db/seed/data.mts NOTIFY_TEMPLATES) */
export const TEMPLATE_REGISTER_VERIFY = 'AUTH_REGISTER_VERIFY';
export const TEMPLATE_REGISTER_MANAGER = 'AUTH_REGISTER_MANAGER_NOTICE';
export const TEMPLATE_PASSWORD_RESET = 'AUTH_PASSWORD_RESET';

/** 忘記密碼:不論帳號是否存在、是否為 AD 帳號,回應相同(PRD §8.2.5) */
export const FORGOT_MESSAGE = '若帳號存在且有登記 Email,重設連結已寄出,請於 30 分鐘內完成設定;AD 帳號請依公司 AD 流程變更密碼';

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** 姓名比對:去除所有空白 */
const sameName = (a: string | null | undefined, b: string) => !!a && a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

export interface RegisterInput {
  employeeNo: string;
  name: string;
  /** 到職日 YYYY-MM-DD(無 Email 者) */
  hireDate?: string;
  /** 無 Email 者在申請時一併設定密碼 */
  password?: string;
  ip: string;
  userAgent?: string;
}

export type RegisterResult =
  { code: 'VERIFICATION_SENT' | 'REGISTRATION_PENDING_APPROVAL'; message: string } | { code: 'OK'; message: string; activated: true };

type Ctx = { ip: string; userAgent?: string };

export class LocalAccountService {
  constructor(
    private readonly deps: {
      db: GwDatabase;
      redis: Redis;
      ad: AdDirectory;
      ext: { bpm?: ExternalDb; los?: ExternalDb };
      notifier: NotifyService;
      log: FastifyBaseLogger;
      /** 入口網網址(連結用),例 https://giganexus-test.gigasolar.com.tw */
      publicBaseUrl: string;
      revokeUser: (userId: number) => Promise<unknown>;
    },
  ) {}

  private async throttle(ip: string, emp: string): Promise<void> {
    const { redis } = this.deps;
    const count = async (key: string) => {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, REG_WINDOW_SEC);
      return n;
    };
    if ((await count(`gw:reg:ip:${ip}`)) > REG_IP_LIMIT || (await count(`gw:reg:emp:${emp}`)) > REG_EMP_LIMIT) throw new GwError('RATE_LIMITED');
  }

  /** 新 token(同用途舊 token 一併作廢);回傳明文,只出現在寄出的連結 */
  private async issueToken(
    tx: Parameters<Parameters<GwDatabase['transaction']>[0]>[0],
    userId: number,
    purpose: 'verify_email' | 'reset_password',
    ip: string,
  ) {
    const token = randomBytes(32).toString('base64url');
    await tx
      .update(localAccountToken)
      .set({ usedAt: new Date() })
      .where(and(eq(localAccountToken.userId, userId), eq(localAccountToken.purpose, purpose), isNull(localAccountToken.usedAt)));
    await tx
      .insert(localAccountToken)
      .values({ userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MIN * 60_000), createdIp: ip });
    return token;
  }

  private link(path: string, token: string) {
    return `${this.deps.publicBaseUrl.replace(/\/$/, '')}${path}?token=${token}`;
  }

  private async notAllowed(emp: string, reason: string, ctx: Ctx): Promise<never> {
    await writeAuthLog(this.deps.db, { username: emp, authMethod: 'local', event: 'register_rejected', reason, ip: ctx.ip, userAgent: ctx.userAgent });
    throw new GwError('REGISTRATION_NOT_ALLOWED');
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const { db, ad, ext, notifier, log } = this.deps;
    const emp = normalizeEmpNo(input.employeeNo);
    const ctx = { ip: input.ip, userAgent: input.userAgent };
    await this.throttle(input.ip, emp);
    if (!isValidEmpNo(emp)) return this.notAllowed(emp, 'invalid_employee_no', ctx);

    // 一個工號只有一種驗證方式:任一 AD 網域找得到者必須使用 AD;AD 無法查詢時不可放行
    for (const code of ad.codes) {
      let exists: boolean;
      try {
        exists = await ad.exists(code, emp);
      } catch (err) {
        log.error({ err: (err as Error).message, domain: code }, '註冊:AD 查詢失敗');
        throw new GwError('INTERNAL_ERROR', '暫時無法受理註冊,請稍後再試');
      }
      if (exists) return this.notAllowed(emp, `ad_account:${code}`, ctx);
    }

    const [existing] = await db
      .select({ userId: user.userId, status: localCredential.status, registeredVia: localCredential.registeredVia })
      .from(user)
      .leftJoin(localCredential, eq(localCredential.userId, user.userId))
      .where(eq(user.employeeNo, emp));
    // 待 Email 驗證者可重新申請(重寄連結);其他狀態視為已註冊
    if (existing?.status && !(existing.status === 'pending_verify' && existing.registeredVia === 'self_email'))
      return this.notAllowed(emp, `already_${existing.status}`, ctx);

    const lookup = await lookupEmployee(ext, emp);
    if (!lookup.bpmOk && !lookup.losOk) {
      log.error({ emp }, '註冊:BPM 與 LOS 都無法查詢');
      throw new GwError('INTERNAL_ERROR', '暫時無法受理註冊,請稍後再試');
    }
    if (lookup.selfVirtual) return this.notAllowed(emp, 'virtual_account', ctx);
    const merged = mergeProfile(lookup);

    // LOS / BPM 都查無 → 轉管理員審核
    if (merged.profileSource === 'ad_only') {
      if (existing?.status) return this.notAllowed(emp, `already_${existing.status}`, ctx);
      await db.transaction(async (tx) => {
        let userId = existing?.userId;
        if (!userId)
          [{ id: userId }] = (await tx
            .insert(user)
            .output({ id: user.userId })
            .values({ employeeNo: emp, displayName: input.name.trim().slice(0, 100), profileSource: 'ad_only', createdBy: ACTOR, updatedBy: ACTOR })) as [
            { id: number },
          ];
        await tx.insert(localCredential).values({ userId, status: 'pending_approval', registeredVia: 'self_approved', createdBy: ACTOR, updatedBy: ACTOR });
        await writeAuthLog(tx, { username: emp, userId, authMethod: 'local', event: 'register_pending', ip: ctx.ip, userAgent: ctx.userAgent });
      });
      return { code: 'REGISTRATION_PENDING_APPROVAL', message: '查無您的人事資料,已轉 IT 審核,核准後將提供啟用連結' };
    }

    if (merged.employmentStatus !== 'active') return this.notAllowed(emp, 'not_active', ctx);
    if (!sameName(lookup.bpm?.displayName, input.name) && !sameName(lookup.los?.userName, input.name)) return this.notAllowed(emp, 'name_mismatch', ctx);

    if (merged.email) {
      // 驗證連結只寄到 LOS / BPM 登記的 Email
      const { userId, token } = await db.transaction(async (tx) => {
        const userId = await this.ensureUser(tx, emp, merged);
        if (!existing?.status)
          await tx.insert(localCredential).values({ userId, status: 'pending_verify', registeredVia: 'self_email', createdBy: ACTOR, updatedBy: ACTOR });
        const token = await this.issueToken(tx, userId, 'verify_email', ctx.ip);
        await writeAuthLog(tx, { username: emp, userId, authMethod: 'local', event: 'register_requested', ip: ctx.ip, userAgent: ctx.userAgent });
        return { userId, token };
      });
      await notifier.send({
        templateCode: TEMPLATE_REGISTER_VERIFY,
        channels: ['email'],
        to: { users: [emp] },
        data: { name: merged.displayName ?? input.name, employeeNo: emp, link: this.link('/register', token), expiresMinutes: TOKEN_TTL_MIN },
        priority: 'high',
        requestedBy: `${ACTOR}:${emp}`,
      });
      log.info({ emp, userId }, '註冊:已寄送驗證連結');
      return { code: 'VERIFICATION_SENT', message: `驗證連結已寄到您在人事系統登記的 Email,請於 ${TOKEN_TTL_MIN} 分鐘內完成設定` };
    }

    // 沒有 Email:比對 LOS 到職日(只即時比對、不儲存)後直接啟用
    if (existing?.status) return this.notAllowed(emp, `already_${existing.status}`, ctx);
    const jobDate = parseLosDate(lookup.los?.jobDate);
    if (!input.hireDate || !jobDate || jobDate.toISOString().slice(0, 10) !== input.hireDate) return this.notAllowed(emp, 'hire_date_mismatch', ctx);
    if (!input.password) throw new GwError('VALIDATION_FAILED', '請設定密碼', [{ field: 'password', message: '沒有公司 Email 的同仁需在申請時設定密碼' }]);
    const failed = checkPasswordPolicy(input.password, emp);
    if (failed.length)
      throw new GwError(
        'PASSWORD_POLICY_VIOLATION',
        undefined,
        failed.map((rule) => ({ rule, message: POLICY_MESSAGES[rule] })),
      );
    const passwordHash = await hashPassword(input.password);
    const userId = await db.transaction(async (tx) => {
      const userId = await this.ensureUser(tx, emp, merged);
      await tx.insert(localCredential).values({
        userId,
        passwordHash,
        status: 'active',
        registeredVia: 'self_jobdate',
        passwordChangedAt: new Date(),
        createdBy: ACTOR,
        updatedBy: ACTOR,
      });
      await writeAuthLog(tx, {
        username: emp,
        userId,
        authMethod: 'local',
        event: 'register_verified',
        reason: 'self_jobdate',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return userId;
    });
    await this.notifyManager(emp, userId, merged.managerEmployeeNo, lookup.los?.bossEmail ?? null, merged.displayName ?? input.name);
    return { code: 'OK', message: '帳號已啟用,請以新密碼登入', activated: true };
  }

  private async ensureUser(tx: Parameters<Parameters<GwDatabase['transaction']>[0]>[0], emp: string, merged: ReturnType<typeof mergeProfile>): Promise<number> {
    let [u] = await tx.select({ id: user.userId }).from(user).where(eq(user.employeeNo, emp));
    if (!u)
      [u] = await tx
        .insert(user)
        .output({ id: user.userId })
        .values({ employeeNo: emp, displayName: merged.displayName ?? emp, profileSource: merged.profileSource, createdBy: ACTOR, updatedBy: ACTOR });
    await applyProfile(tx, u!.id, merged, ACTOR);
    return u!.id;
  }

  /** 無 Email 直接啟用時通知主管(LOS BossEMail 優先,其次主管在 gw.user 的 Email);沒有主管 Email 時記錄警告 */
  private async notifyManager(emp: string, userId: number, managerEmp: string | null, bossEmail: string | null, name: string) {
    const { db, notifier, log } = this.deps;
    let address = bossEmail?.trim() || null;
    if (!address && managerEmp) {
      const [m] = await db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.employeeNo, normalizeEmpNo(managerEmp)));
      address = m?.email ?? null;
    }
    if (!address) {
      log.warn({ emp, managerEmp }, '註冊:無 Email 直接啟用,但查無主管 Email,未通知');
      return;
    }
    try {
      await notifier.send({
        templateCode: TEMPLATE_REGISTER_MANAGER,
        channels: ['email'],
        to: { emails: [address] },
        data: { name, employeeNo: emp },
        requestedBy: `${ACTOR}:${emp}`,
      });
      await db.update(localCredential).set({ managerNotifiedAt: new Date(), updatedBy: ACTOR }).where(eq(localCredential.userId, userId));
    } catch (err) {
      // 帳號已啟用,通知失敗不回滾;記錄後由 IT 於管理介面查詢近期註冊
      log.error({ emp, err: (err as Error).message }, '註冊:通知主管失敗');
    }
  }

  /** 忘記密碼:回應一律相同;只有本機帳號(active / locked)且有 Email 才寄送 */
  async forgot(employeeNo: string, ctx: Ctx): Promise<void> {
    const { db, notifier, log } = this.deps;
    const emp = normalizeEmpNo(employeeNo);
    await this.throttle(ctx.ip, emp);
    if (!isValidEmpNo(emp)) return;
    const [row] = await db
      .select({ userId: user.userId, email: user.email, name: user.displayName, isDisabled: user.isDisabled, status: localCredential.status })
      .from(user)
      .innerJoin(localCredential, eq(localCredential.userId, user.userId))
      .where(eq(user.employeeNo, emp));
    if (!row || row.isDisabled || !['active', 'locked'].includes(row.status) || !row.email) {
      await writeAuthLog(db, {
        username: emp,
        authMethod: 'local',
        event: 'pw_reset_skipped',
        reason: row ? (row.email ? row.status : 'no_email') : 'not_local',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return;
    }
    const token = await db.transaction(async (tx) => {
      const token = await this.issueToken(tx, row.userId, 'reset_password', ctx.ip);
      await writeAuthLog(tx, { username: emp, userId: row.userId, authMethod: 'local', event: 'pw_reset_requested', ip: ctx.ip, userAgent: ctx.userAgent });
      return token;
    });
    await notifier.send({
      templateCode: TEMPLATE_PASSWORD_RESET,
      channels: ['email'],
      to: { users: [emp] },
      data: { name: row.name, employeeNo: emp, link: this.link('/reset-password', token), expiresMinutes: TOKEN_TTL_MIN },
      priority: 'high',
      requestedBy: `${ACTOR}:${emp}`,
    });
    log.info({ emp }, '忘記密碼:已寄送重設連結');
  }

  /** 以重設連結設定新密碼:解除鎖定、清除失敗次數、撤銷所有 Refresh Token 家族 */
  async reset(token: string, password: string, ctx: Ctx): Promise<void> {
    const { db, redis } = this.deps;
    const [t] = await db
      .select()
      .from(localAccountToken)
      .where(eq(localAccountToken.tokenHash, sha256(token)));
    if (!t || t.purpose !== 'reset_password') throw new GwError('TOKEN_INVALID');
    if (t.usedAt) throw new GwError('TOKEN_USED');
    if (t.expiresAt.getTime() < Date.now()) throw new GwError('TOKEN_EXPIRED');
    const [row] = await db
      .select({ emp: user.employeeNo, cred: localCredential })
      .from(user)
      .innerJoin(localCredential, eq(localCredential.userId, user.userId))
      .where(eq(user.userId, t.userId));
    if (!row || !['active', 'locked'].includes(row.cred.status)) throw new GwError('TOKEN_INVALID');
    const failed = checkPasswordPolicy(password, row.emp);
    if (failed.length)
      throw new GwError(
        'PASSWORD_POLICY_VIOLATION',
        undefined,
        failed.map((rule) => ({ rule, message: POLICY_MESSAGES[rule] })),
      );
    if (await isReused(password, row.cred.passwordHash, row.cred.passwordHistory)) throw new GwError('PASSWORD_REUSED');
    const passwordHash = await hashPassword(password);
    await db.transaction(async (tx) => {
      await tx.update(localAccountToken).set({ usedAt: new Date() }).where(eq(localAccountToken.tokenId, t.tokenId));
      await tx
        .update(localCredential)
        .set({
          passwordHash,
          passwordHistory: pushHistory(row.cred.passwordHash, row.cred.passwordHistory),
          passwordChangedAt: new Date(),
          status: 'active',
          failedCount: 0,
          lockedAt: null,
          mustChangePassword: false,
          updatedBy: row.emp,
        })
        .where(eq(localCredential.userId, t.userId));
      await writeAuthLog(tx, { username: row.emp, userId: t.userId, authMethod: 'local', event: 'password_reset', ip: ctx.ip, userAgent: ctx.userAgent });
    });
    await this.deps.revokeUser(t.userId);
    await redis.del(`gw:login:fail:${row.emp}`).catch(() => undefined);
  }
}
