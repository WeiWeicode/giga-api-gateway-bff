/**
 * JWT 金鑰(PRD §8.2.2):ES256,支援 kid 輪替。
 *   - 目錄內每個 <kid>.pem 為 PKCS#8 私鑰;簽章使用 JWT_ACTIVE_KID(未設定時取檔名排序最後者)
 *   - 其餘金鑰只用於驗證,並一併出現在 JWKS,讓新舊金鑰並存一個 Access Token 效期
 */
import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { exportJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from 'jose';

export const ISSUER = 'giganexus-bff';
export const ACCESS_AUDIENCE = 'giganexus';
export const ACCESS_TTL_SEC = 15 * 60;
export const INTERNAL_TTL_SEC = 60;

interface Key {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** Access Token 與內部 Token 共用的身分欄位(PRD §8.2.2–§8.2.3) */
export interface IdentityClaims {
  sub: string;
  emp: string;
  upn: string | null;
  name: string;
  dept: string | null;
  cos: string[];
  amr: 'ad' | 'local';
  roles: string[];
}

/** 內部 Token 的身分:使用者,或系統對系統(api_key:sub = client:{clientId})、Webhook 轉送(webhook:sub = webhook:{source}),BACKEND-GUIDE.md §4.3 */
export type InternalIdentity = Omit<IdentityClaims, 'amr'> & { amr: IdentityClaims['amr'] | 'api_key' | 'webhook' };

export interface AccessClaims extends IdentityClaims {
  pv: number;
  jti: string;
  exp: number;
  iat: number;
}

export class KeyStore {
  private constructor(
    private readonly keys: Map<string, Key>,
    readonly activeKid: string,
  ) {}

  static load(dir: string, activeKid?: string): KeyStore {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.pem'))
      .sort();
    if (!files.length) throw new Error(`JWT 金鑰目錄沒有 .pem 檔:${dir}`);
    const keys = new Map<string, Key>();
    for (const f of files) {
      const privateKey = createPrivateKey(readFileSync(path.join(dir, f)));
      if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error(`JWT 金鑰必須為 EC P-256(ES256):${f}`);
      }
      const kid = f.slice(0, -4);
      keys.set(kid, { kid, privateKey, publicKey: createPublicKey(privateKey) });
    }
    const active = activeKid ?? files.at(-1)!.slice(0, -4);
    if (!keys.has(active)) throw new Error(`找不到 JWT_ACTIVE_KID:${active}`);
    return new KeyStore(keys, active);
  }

  private get active(): Key {
    return this.keys.get(this.activeKid)!;
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    const out: JWK[] = [];
    for (const k of this.keys.values()) out.push({ ...(await exportJWK(k.publicKey)), kid: k.kid, alg: 'ES256', use: 'sig' });
    return { keys: out };
  }

  async signAccess(claims: IdentityClaims & { pv: number }): Promise<{ token: string; jti: string; exp: number }> {
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ACCESS_TTL_SEC;
    const { sub, ...rest } = claims;
    const token = await new SignJWT({ ...rest })
      .setProtectedHeader({ alg: 'ES256', kid: this.activeKid, typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setJti(jti)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.active.privateKey);
    return { token, jti, exp };
  }

  /** 內部 Token(X-Internal-Token):aud = 上游服務代碼,60 秒(PRD §8.2.3) */
  async signInternal(claims: InternalIdentity, audience: string): Promise<string> {
    const { sub, ...rest } = claims;
    return new SignJWT({ ...rest })
      .setProtectedHeader({ alg: 'ES256', kid: this.activeKid, typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${INTERNAL_TTL_SEC}s`)
      .sign(this.active.privateKey);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, (header) => this.publicKeyFor(header.kid), {
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
      algorithms: ['ES256'],
    });
    return payload as JWTPayload & AccessClaims;
  }

  private publicKeyFor(kid: string | undefined): KeyObject {
    const k = kid ? this.keys.get(kid) : undefined;
    if (!k) throw new Error('未知的 kid');
    return k.publicKey;
  }
}
