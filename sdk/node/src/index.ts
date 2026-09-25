/**
 * @giganexus/backend-sdk(BACKEND-GUIDE.md §4、§5.3、§7.5)
 *
 *   const env = loadGatewayEnv()                                         // GW_ENV=dev|test|prod …
 *   const verify = createTokenVerifier({ jwksUrl: env.jwksUrl!, audience: env.serviceCode })
 *   await autoRegister({ env, spec: app.swagger() })                    // test / prod 啟動時註冊為草稿
 *   await new GatewayClient(env.gatewayUrl!, env.apiKey!).lookup({ q: '工單' })
 */
export { GatewayClient, GatewayError } from './client.js';
export type { CatalogResult, CatalogRoute, LookupQuery, RegistrationResult } from './client.js';
export { GatewayEnvError, isGatewayPort, loadGatewayEnv } from './env.js';
export type { GatewayEnv, GwEnv } from './env.js';
export { autoRegister } from './register.js';
export type { AutoRegisterOptions } from './register.js';
export { createTokenVerifier, INTERNAL_TOKEN_HEADER } from './token.js';
export type { GatewayIdentity } from './token.js';

/** 錯誤回應(BACKEND-GUIDE.md §5.3);自訂代碼以系統代碼開頭,不可使用 Gateway 專用代碼 */
export function errorBody(code: string, message: string, requestId: string, details?: unknown) {
  return details === undefined ? { code, message, requestId } : { code, message, requestId, details };
}
