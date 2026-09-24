/**
 * AD 多網域驗證(PRD §8.2.1、REFERENCES.md §1.3):
 *   服務帳號 bind → 以 sAMAccountName 搜尋 → 以使用者 DN + 密碼 bind → 巢狀群組(LDAP_MATCHING_RULE_IN_CHAIN)
 * 過渡期沿用 ldap://(PRD Q12),補發憑證後只改 url 為 ldaps://。
 */
import { AndFilter, Client, EqualityFilter, InvalidCredentialsError } from 'ldapts';
import type { LdapDomainConfig } from '../../config.js';

export type AdAuthResult =
  | {
      kind: 'ok';
      domain: string;
      dn: string;
      account: string;
      upn: string | null;
      displayName: string | null;
      mail: string | null;
      objectGuid: string | null;
      groups: string[];
    }
  | { kind: 'not_found'; domain: string }
  | { kind: 'bad_password'; domain: string }
  | { kind: 'rejected'; domain: string; code: 'ACCOUNT_DISABLED' | 'AD_PASSWORD_EXPIRED' | 'ACCOUNT_LOCKED' }
  | { kind: 'unavailable'; domain: string; error: string };

const CHAIN_RULE = '1.2.840.113556.1.4.1941';

/** RFC 4515 filter 值跳脫 */
export function escapeFilterValue(v: string): string {
  return v.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** AD objectGUID(16 bytes,前三段 little-endian)→ 大寫 GUID 字串 */
export function guidFromBytes(b: Buffer): string | null {
  if (b.length !== 16) return null;
  const h = (i: number[]) => i.map((x) => b[x]!.toString(16).padStart(2, '0')).join('');
  return `${h([3, 2, 1, 0])}-${h([5, 4])}-${h([7, 6])}-${h([8, 9])}-${h([10, 11, 12, 13, 14, 15])}`.toUpperCase();
}

/** 由 AD bind 錯誤的診斷訊息(data xxx)判斷原因 */
export function classifyBindError(message: string): 'bad_password' | 'ACCOUNT_DISABLED' | 'AD_PASSWORD_EXPIRED' | 'ACCOUNT_LOCKED' {
  const m = /data ([0-9a-f]{3})/i.exec(message)?.[1]?.toLowerCase();
  switch (m) {
    case '533': // 帳號停用
    case '701': // 帳號過期
      return 'ACCOUNT_DISABLED';
    case '532': // 密碼過期
    case '773': // 下次登入須變更密碼
      return 'AD_PASSWORD_EXPIRED';
    case '775': // AD 鎖定
      return 'ACCOUNT_LOCKED';
    default: // 52e 等
      return 'bad_password';
  }
}

const str = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' && x !== '' ? x : null;
};

export class AdDirectory {
  private readonly byCode: Map<string, LdapDomainConfig>;

  constructor(readonly domains: LdapDomainConfig[]) {
    this.byCode = new Map(domains.map((d) => [d.code, d]));
  }

  get codes(): string[] {
    return this.domains.map((d) => d.code);
  }

  has(code: string): boolean {
    return this.byCode.has(code);
  }

  /** `GSC\S112009` 的 NetBIOS 名稱或 `S112009@gsmc.com.tw` 的 UPN 尾碼 → 網域代碼 */
  resolve(hint: string): string | undefined {
    const h = hint.toLowerCase();
    return this.domains.find((d) => d.netbios.toLowerCase() === h || d.upnSuffix.toLowerCase() === h || d.code === h)?.code;
  }

  private client(d: LdapDomainConfig): Client {
    return new Client({ url: d.url, timeout: d.timeoutMs, connectTimeout: d.timeoutMs });
  }

  /** 以服務帳號查詢帳號是否存在(註冊 / IT 代建前確認「一個工號只有一種驗證方式」) */
  async exists(code: string, account: string): Promise<boolean> {
    const d = this.byCode.get(code);
    if (!d) return false;
    const svc = this.client(d);
    try {
      await svc.bind(d.bindDN, d.bindPassword);
      const { searchEntries } = await svc.search(d.baseDN, {
        scope: 'sub',
        filter: new AndFilter({
          filters: [new EqualityFilter({ attribute: 'objectClass', value: 'user' }), new EqualityFilter({ attribute: d.userAttribute, value: account })],
        }),
        attributes: ['dn'],
        sizeLimit: 1,
      });
      return searchEntries.length > 0;
    } finally {
      await svc.unbind().catch(() => undefined);
    }
  }

  async authenticate(code: string, account: string, password: string): Promise<AdAuthResult> {
    const d = this.byCode.get(code);
    if (!d) return { kind: 'not_found', domain: code };
    const svc = this.client(d);
    try {
      await svc.bind(d.bindDN, d.bindPassword);
      const { searchEntries } = await svc.search(d.baseDN, {
        scope: 'sub',
        filter: new AndFilter({
          filters: [new EqualityFilter({ attribute: 'objectClass', value: 'user' }), new EqualityFilter({ attribute: d.userAttribute, value: account })],
        }),
        attributes: ['sAMAccountName', 'userPrincipalName', 'displayName', 'mail', 'objectGUID'],
        explicitBufferAttributes: ['objectGUID'],
        sizeLimit: 2,
      });
      const entry = searchEntries[0];
      if (!entry || searchEntries.length > 1) return { kind: 'not_found', domain: code };

      // 空密碼在 LDAP 會變成匿名 bind 而「成功」,必須先擋下
      if (!password) return { kind: 'bad_password', domain: code };
      const userClient = this.client(d);
      try {
        await userClient.bind(entry.dn, password);
      } catch (err) {
        if (err instanceof InvalidCredentialsError) {
          const c = classifyBindError(err.message);
          return c === 'bad_password' ? { kind: 'bad_password', domain: code } : { kind: 'rejected', domain: code, code: c };
        }
        throw err;
      } finally {
        await userClient.unbind().catch(() => undefined);
      }

      const groups = await svc.search(d.baseDN, {
        scope: 'sub',
        filter: `(&(objectClass=group)(member:${CHAIN_RULE}:=${escapeFilterValue(entry.dn)}))`,
        attributes: ['cn'],
      });
      const guid = entry.objectGUID;
      return {
        kind: 'ok',
        domain: code,
        dn: entry.dn,
        account: str(entry.sAMAccountName) ?? account,
        upn: str(entry.userPrincipalName),
        displayName: str(entry.displayName),
        mail: str(entry.mail),
        objectGuid: Buffer.isBuffer(guid) ? guidFromBytes(guid) : Array.isArray(guid) && Buffer.isBuffer(guid[0]) ? guidFromBytes(guid[0]) : null,
        groups: groups.searchEntries.map((g) => g.dn),
      };
    } catch (err) {
      return { kind: 'unavailable', domain: code, error: (err as Error).message };
    } finally {
      await svc.unbind().catch(() => undefined);
    }
  }
}
