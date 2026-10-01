/**
 * 登入(PRD §8.2.1、§8.2.5):
 *
 *   帶網域(DOMAIN\user、user@domain)→ 只到該網域驗證
 *   只輸入工號 → 兼任帳號一律拒絕(Q16)
 *              → 有本機帳號 → Argon2id 驗證(10 次失敗鎖定)
 *              → 依 gw.user_company 的公司取得網域清單依序嘗試(查無工號或無公司資料時試全部網域)
 *              → 公司無網域或所有網域都查無 → ACCOUNT_NOT_REGISTERED(舊單一入口遷移 W3-4.16 待 P-15 就緒後接入)
 *   AD 找得到帳號但密碼錯誤 → 繼續試下一個網域(舊網域失敗改試新網域),全部失敗回 INVALID_CREDENTIALS
 *
 * 登入失敗不暫停(2026-10-01 取消 LOGIN_THROTTLED 與 Nginx 登入限流):輸錯密碼一律送 AD 驗證,
 * 連續輸錯由 AD 自身的鎖定原則處理;本機帳號仍為 10 次失敗鎖定。
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { GwDatabase } from '../../db/client.js';
import { authLog, company, companyAdDomain, localCredential, user, userCompany } from '../../db/schema/index.js';
import type { ErrorCode } from '../../errors.js';
import type { ExternalDb } from '../../plugins/db.js';
import type { AdAuthResult, AdDirectory } from './ldap.js';
import { verifyPassword } from './password.js';
import { applyProfile, isValidEmpNo, lookupEmployee, mergeProfile, normalizeEmpNo, type EmployeeLookup } from './profile.js';

export const LOCAL_LOCK_THRESHOLD = 10;

export type LoginResult =
  | { kind: 'ok'; userId: number; amr: 'ad' | 'local' }
  | { kind: 'password_change_required'; userId: number }
  | { kind: 'fail'; code: ErrorCode | 'UPSTREAM_UNAVAILABLE'; reason: string };

export interface LoginInput {
  username: string;
  password: string;
  ip: string;
  userAgent?: string;
}

export function parseUsername(raw: string): { account: string; domainHint?: string } {
  const v = raw.trim();
  const backslash = v.indexOf('\\');
  if (backslash > 0) return { domainHint: v.slice(0, backslash), account: v.slice(backslash + 1) };
  const at = v.lastIndexOf('@');
  if (at > 0) return { account: v.slice(0, at), domainHint: v.slice(at + 1) };
  return { account: v };
}

type Tx = Parameters<Parameters<GwDatabase['transaction']>[0]>[0];

export async function writeAuthLog(
  db: GwDatabase | Tx,
  e: { username: string; userId?: number | null; authMethod?: 'ad' | 'local' | null; event: string; reason?: string | null; ip?: string; userAgent?: string },
): Promise<void> {
  await db.insert(authLog).values({
    username: e.username.slice(0, 128),
    userId: e.userId ?? null,
    authMethod: e.authMethod ?? null,
    event: e.event,
    reason: e.reason?.slice(0, 200) ?? null,
    ip: e.ip ?? null,
    userAgent: e.userAgent?.slice(0, 400) ?? null,
  });
}

export class LoginService {
  constructor(
    private readonly db: GwDatabase,
    private readonly ad: AdDirectory,
    private readonly ext: { bpm?: ExternalDb; los?: ExternalDb },
    private readonly log: { warn: (o: object, msg: string) => void; info: (o: object, msg: string) => void },
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const { account, domainHint } = parseUsername(input.username);
    const emp = normalizeEmpNo(account);
    if (!isValidEmpNo(emp) || !input.password) return this.fail(input, null, 'INVALID_CREDENTIALS', 'invalid input');

    if (domainHint) {
      const code = this.ad.resolve(domainHint);
      if (!code) return this.fail(input, null, 'INVALID_CREDENTIALS', `unknown domain ${domainHint}`);
      return this.tryDomains(input, emp, [code], null);
    }

    const [u] = await this.db.select({ userId: user.userId, isVirtual: user.isVirtual }).from(user).where(eq(user.employeeNo, emp));
    if (u?.isVirtual) return this.fail(input, u.userId, 'INVALID_CREDENTIALS', 'virtual account');

    if (u) {
      const [cred] = await this.db.select().from(localCredential).where(eq(localCredential.userId, u.userId));
      if (cred && cred.status !== 'disabled') return this.loginLocal(input, u.userId, cred);
    }

    // 尚未同步的工號:先補查 LOS / BPM,判斷兼任帳號與所屬公司(結果沿用到登入成功後寫入)
    const lookup = u ? null : await lookupEmployee(this.ext, emp);
    if (lookup?.selfVirtual) return this.fail(input, null, 'INVALID_CREDENTIALS', 'virtual account');
    const domains = u
      ? await this.domainsForUser(u.userId)
      : await this.domainsForCompanies(lookup ? mergeProfile(lookup).companies.map((c) => c.compName) : []);
    if (domains && domains.length === 0) {
      // 所屬公司沒有 AD 網域,也沒有本機帳號
      return this.fail(input, u?.userId ?? null, 'ACCOUNT_NOT_REGISTERED', 'company has no domain');
    }
    return this.tryDomains(input, emp, domains ?? this.ad.codes, lookup);
  }

  /** 由 LOS / BPM 的公司名稱取得網域;公司尚未建立(未知)時回 null(試全部網域) */
  private async domainsForCompanies(names: string[]): Promise<string[] | null> {
    if (!names.length) return null;
    const known = await this.db.select({ id: company.companyId, name: company.compName }).from(company);
    const ids = names.map((n) => known.find((k) => k.name === n)?.id);
    if (ids.some((id) => id === undefined)) return null;
    const rows = await this.db
      .select({ companyId: companyAdDomain.companyId, domain: companyAdDomain.domainCode, order: companyAdDomain.tryOrder })
      .from(companyAdDomain);
    const out: string[] = [];
    for (const id of ids) for (const r of rows.filter((x) => x.companyId === id).sort((a, b) => a.order - b.order)) out.push(r.domain);
    return [...new Set(out)].filter((d) => this.ad.has(d));
  }

  /** 使用者所屬公司的網域(主要公司優先、依 try_order);沒有公司資料時回 null(試全部網域) */
  private async domainsForUser(userId: number): Promise<string[] | null> {
    const companies = await this.db.select({ companyId: userCompany.companyId }).from(userCompany).where(eq(userCompany.userId, userId));
    if (!companies.length) return null;
    const rows = await this.db
      .select({ domain: companyAdDomain.domainCode })
      .from(userCompany)
      .innerJoin(company, eq(company.companyId, userCompany.companyId))
      .innerJoin(companyAdDomain, eq(companyAdDomain.companyId, company.companyId))
      .where(and(eq(userCompany.userId, userId), eq(company.isEnabled, true)))
      .orderBy(desc(userCompany.isPrimary), asc(companyAdDomain.tryOrder));
    return [...new Set(rows.map((r) => r.domain))].filter((d) => this.ad.has(d));
  }

  private async tryDomains(input: LoginInput, emp: string, domains: string[], lookup: EmployeeLookup | null): Promise<LoginResult> {
    let badPassword = false;
    let unavailable: string | null = null;
    for (const code of domains) {
      const r: AdAuthResult = await this.ad.authenticate(code, emp, input.password);
      if (r.kind === 'ok') return this.onAdSuccess(input, r, lookup);
      if (r.kind === 'rejected') return this.fail(input, null, r.code, `ad ${code} ${r.code}`);
      if (r.kind === 'bad_password') badPassword = true;
      if (r.kind === 'unavailable') {
        unavailable = `${code}: ${r.error}`;
        this.log.warn({ domain: code, err: r.error }, 'AD 網域無法連線');
      }
    }
    if (badPassword) return this.fail(input, null, 'INVALID_CREDENTIALS', 'bad password');
    if (unavailable) return { kind: 'fail', code: 'UPSTREAM_UNAVAILABLE', reason: unavailable };
    return this.fail(input, null, 'ACCOUNT_NOT_REGISTERED', 'not found in any domain');
  }

  private async onAdSuccess(input: LoginInput, r: Extract<AdAuthResult, { kind: 'ok' }>, prior: EmployeeLookup | null): Promise<LoginResult> {
    const emp = normalizeEmpNo(r.account);
    const groups = JSON.stringify([...r.groups].sort());
    let [u] = await this.db.select().from(user).where(eq(user.employeeNo, emp));

    // 人員同步尚未涵蓋時即時補查 BPM / LOS(各 3 秒,失敗仍以 AD 資料登入)
    const needProfile = !u || !u.profileSyncedAt;
    const lookup = needProfile ? (prior ?? (await lookupEmployee(this.ext, emp))) : null;
    if (lookup?.los === null && lookup.virtuals.length === 0 && !lookup.bpm) {
      this.log.info({ emp, bpmOk: lookup.bpmOk, losOk: lookup.losOk }, 'BPM / LOS 查無此工號,以 AD 資料登入');
    }
    const merged = lookup ? mergeProfile(lookup) : null;

    const userId = await this.db.transaction(async (tx) => {
      if (!u) {
        [u] = await tx
          .insert(user)
          .output()
          .values({
            employeeNo: emp,
            displayName: merged?.displayName ?? r.displayName ?? emp,
            email: merged?.email ?? r.mail,
            profileSource: 'ad_only',
            createdBy: 'login',
            updatedBy: 'login',
          });
      }
      const cur = u!;
      await tx
        .update(user)
        .set({
          authType: 'ad',
          adObjectGuid: r.objectGuid,
          adDomain: r.domain,
          upn: r.upn,
          adGroups: groups,
          email: cur.email ?? r.mail,
          lastLoginAt: new Date(),
          lastLoginIp: input.ip,
          updatedBy: 'login',
          ...(cur.adGroups !== groups ? { permVersion: sql`${user.permVersion} + 1` } : {}),
        })
        .where(eq(user.userId, cur.userId));
      if (merged) await applyProfile(tx, cur.userId, merged, 'login');
      await writeAuthLog(tx, {
        username: input.username,
        userId: cur.userId,
        authMethod: 'ad',
        event: 'login_success',
        reason: r.domain,
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return cur.userId;
    });

    if (u!.isDisabled) return this.fail(input, userId, 'ACCOUNT_DISABLED', 'gateway disabled');
    return { kind: 'ok', userId, amr: 'ad' };
  }

  private async loginLocal(input: LoginInput, userId: number, cred: typeof localCredential.$inferSelect): Promise<LoginResult> {
    if (cred.status === 'locked') return this.fail(input, userId, 'ACCOUNT_LOCKED', 'locked', 'local');
    if (cred.status !== 'active') return this.fail(input, userId, 'ACCOUNT_NOT_REGISTERED', `local ${cred.status}`, 'local');

    if (!(await verifyPassword(cred.passwordHash, input.password))) {
      const failed = cred.failedCount + 1;
      const lock = failed >= LOCAL_LOCK_THRESHOLD;
      await this.db
        .update(localCredential)
        .set({ failedCount: failed, ...(lock ? { status: 'locked', lockedAt: new Date() } : {}), updatedBy: 'login' })
        .where(eq(localCredential.userId, userId));
      if (lock)
        await writeAuthLog(this.db, {
          username: input.username,
          userId,
          authMethod: 'local',
          event: 'account_locked',
          ip: input.ip,
          userAgent: input.userAgent,
        });
      return this.fail(input, userId, 'INVALID_CREDENTIALS', `bad password (${failed})`, 'local');
    }

    const [u] = await this.db.select({ isDisabled: user.isDisabled }).from(user).where(eq(user.userId, userId));
    if (u?.isDisabled) return this.fail(input, userId, 'ACCOUNT_DISABLED', 'gateway disabled', 'local');

    await this.db.update(localCredential).set({ failedCount: 0, updatedBy: 'login' }).where(eq(localCredential.userId, userId));
    await this.db.update(user).set({ authType: 'local', lastLoginAt: new Date(), lastLoginIp: input.ip, updatedBy: 'login' }).where(eq(user.userId, userId));
    await writeAuthLog(this.db, {
      username: input.username,
      userId,
      authMethod: 'local',
      event: 'login_success',
      reason: cred.mustChangePassword ? 'must_change_password' : null,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return cred.mustChangePassword ? { kind: 'password_change_required', userId } : { kind: 'ok', userId, amr: 'local' };
  }

  private async fail(
    input: LoginInput,
    userId: number | null,
    code: ErrorCode,
    reason: string,
    authMethod: 'ad' | 'local' | null = null,
  ): Promise<LoginResult> {
    await writeAuthLog(this.db, {
      username: input.username,
      userId,
      authMethod,
      event: 'login_fail',
      reason: `${code}: ${reason}`,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return { kind: 'fail', code, reason };
  }
}
