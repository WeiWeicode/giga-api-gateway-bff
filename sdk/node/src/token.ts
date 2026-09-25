/**
 * X-Internal-Token 驗證(BACKEND-GUIDE.md §4.2):ES256、iss = giganexus-bff、aud = 自己的服務代碼、exp(容許 30 秒誤差)。
 * 公鑰取自 BFF JWKS 並快取;遇到未知 kid 時 jose 會重新下載(金鑰輪替)。
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Token 內容(BACKEND-GUIDE.md §4.3) */
export interface GatewayIdentity {
  /** Gateway 使用者 ID;系統對系統呼叫時為 client:{clientId} */
  sub: string;
  emp?: string;
  upn?: string;
  name?: string;
  dept?: string;
  cos?: string[];
  amr?: string;
  roles?: string[];
}

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

export function createTokenVerifier(opts: { jwksUrl: string; audience: string }): (token: string) => Promise<GatewayIdentity> {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer: 'giganexus-bff', audience: opts.audience, algorithms: ['ES256'], clockTolerance: 30 });
    return payload as unknown as GatewayIdentity;
  };
}
