/**
 * 舊單一入口帳號首次登入自動遷移(PRD §8.2.5、DATABASE.md §9、W3-4.16):
 *
 *   觸發:以工號登入、尚無本機帳號、AD 查無此帳號(所屬公司無網域,或所有網域都找不到)
 *   PortalSolar.LoginData(唯讀 view vw_gn_login_data)查無工號 → not_found(呼叫端維持 ACCOUNT_NOT_REGISTERED)
 *   以舊演算法加密輸入的密碼,與 PNum 比對(不解密、不複製舊密文)→ 不符 → INVALID_CREDENTIALS
 *   相符但 LOS / BPM 不是在職 → INVALID_CREDENTIALS(不遷移)
 *   相符且在職 → 建立 gw.local_credential(registered_via = legacy_portal、must_change_password = 1)
 *               → 呼叫端回 PASSWORD_CHANGE_REQUIRED + 限定憑證;新密碼不可與舊密碼相同(password_hash 即舊密碼的 Argon2id)
 *
 * 預設關閉(config.legacyPortal.enabled),以現行系統的測試帳號確認密文一致(P-15)後才開啟。
 */
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { GwDatabase } from '../../db/client.js';
import { portalLoginData } from '../../db/external/index.js';
import { auditLog, localCredential, user } from '../../db/schema/index.js';
import type { ExternalDb } from '../../plugins/db.js';
import { legacyEncrypt } from './legacy-cipher.js';
import { writeAuthLog } from './login.js';
import { hashPassword } from './password.js';
import { applyProfile, lookupEmployee, mergeProfile } from './profile.js';

const ACTOR = 'legacy-migration';
const LOOKUP_TIMEOUT_MS = 3_000;

export interface LegacyConfig {
  enabled: boolean;
  key?: string;
  serverKey?: string;
}

export type LegacyResult = { kind: 'migrated'; userId: number } | { kind: 'not_found' } | { kind: 'rejected'; reason: string };

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export class LegacyMigrationService {
  constructor(
    private readonly db: GwDatabase,
    private readonly ext: { bpm?: ExternalDb; los?: ExternalDb; portal?: ExternalDb },
    private readonly config: LegacyConfig,
    private readonly log: { warn: (o: object, msg: string) => void; info: (o: object, msg: string) => void },
  ) {}

  get enabled(): boolean {
    return this.config.enabled && !!this.config.key && !!this.config.serverKey;
  }

  /** emp 已正規化;input 供 auth_log 記錄 */
  async tryMigrate(emp: string, password: string, input: { username: string; ip: string; userAgent?: string }): Promise<LegacyResult> {
    if (!this.enabled) return { kind: 'not_found' };
    if (!this.ext.portal) {
      this.log.warn({ emp }, '舊單一入口資料庫未連線,略過帳號遷移');
      return { kind: 'not_found' };
    }
    // 已有本機帳號(任何狀態)者不再讀取 LoginData(DATABASE.md §9.2)
    const [existing] = await this.db
      .select({ userId: localCredential.userId })
      .from(localCredential)
      .innerJoin(user, eq(user.userId, localCredential.userId))
      .where(eq(user.employeeNo, emp));
    if (existing) return { kind: 'not_found' };

    // 參數化查詢(舊系統以字串串接 SQL,DATABASE.md §9.1)
    const [row] = await this.ext.portal.select().from(portalLoginData).where(eq(portalLoginData.pid, emp));
    if (!row) return { kind: 'not_found' };
    if (!row.pnum || !sameText(legacyEncrypt(password, this.config.key!, this.config.serverKey!), row.pnum))
      return { kind: 'rejected', reason: 'legacy bad password' };

    const lookup = await lookupEmployee(this.ext, emp, LOOKUP_TIMEOUT_MS);
    if (lookup.selfVirtual) return { kind: 'rejected', reason: 'legacy virtual account' };
    const merged = mergeProfile(lookup);
    if (merged.employmentStatus !== 'active') return { kind: 'rejected', reason: `legacy not active (${merged.employmentStatus ?? 'not found'})` };

    const passwordHash = await hashPassword(password);
    const userId = await this.db.transaction(async (tx) => {
      let [u] = await tx.select({ id: user.userId }).from(user).where(eq(user.employeeNo, emp));
      if (!u)
        [u] = await tx
          .insert(user)
          .output({ id: user.userId })
          .values({
            employeeNo: emp,
            displayName: merged.displayName ?? row.cname ?? emp,
            profileSource: merged.profileSource,
            createdBy: ACTOR,
            updatedBy: ACTOR,
          });
      await applyProfile(tx, u!.id, merged, ACTOR);
      const now = new Date();
      await tx.insert(localCredential).values({
        userId: u!.id,
        passwordHash,
        status: 'active',
        mustChangePassword: true,
        registeredVia: 'legacy_portal',
        legacyMigratedAt: now,
        passwordChangedAt: now,
        createdBy: ACTOR,
        updatedBy: ACTOR,
      });
      await tx.update(user).set({ authType: 'local', updatedBy: ACTOR }).where(eq(user.userId, u!.id));
      await writeAuthLog(tx, {
        username: input.username,
        userId: u!.id,
        authMethod: 'local',
        event: 'legacy_migrated',
        ip: input.ip,
        userAgent: input.userAgent,
      });
      await tx.insert(auditLog).values({
        actorName: ACTOR,
        actorIp: input.ip,
        action: 'local.legacy_migrate',
        entityType: 'user',
        entityId: emp,
        // 姓名僅供稽核比對;不記錄舊密文
        afterJson: JSON.stringify({ legacyName: row.cname, profileSource: merged.profileSource }),
      });
      return u!.id;
    });
    this.log.info({ emp, userId }, '舊單一入口帳號已遷移為本機帳號(須設定新密碼)');
    return { kind: 'migrated', userId };
  }
}
