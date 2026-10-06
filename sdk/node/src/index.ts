/**
 * @giganexus/backend-sdk(BACKEND-GUIDE.md §4、§5.3、§7.5)
 *
 *   const env = loadGatewayEnv()                                         // GW_ENV=dev|test|prod …;開發專案讀 package.json gateway.project
 *   const verify = createTokenVerifier({ jwksUrl: env.jwksUrl!, audience: env.serviceCode })
 *   await autoRegister({ env, spec: app.swagger() })                    // test / prod 啟動時註冊為草稿(自動寫入 x-gateway.project)
 *   await new GatewayClient(env.gatewayUrl!, env.apiKey!).lookup({ q: '工單' })
 *   const monitor = loadMonitorEnv(env.gwEnv)                            // MONITOR_URL、MONITOR_API_KEY_FILE;送 giga-observe
 *   await app.register(setupGateway, { env, monitor })                   // Fastify:監控 + 自動註冊一次掛上(from '@giganexus/backend-sdk/fastify')
 */
export { GatewayClient, GatewayError } from './client.js';
export type { CatalogResult, CatalogRoute, LookupQuery, RegistrationResult } from './client.js';
export { GatewayEnvError, isGatewayPort, loadGatewayEnv, readProject } from './env.js';
export type { GatewayEnv, GwEnv } from './env.js';
export { autoRegister, withProject } from './register.js';
export type { AutoRegisterOptions } from './register.js';
export { loadMonitorEnv, maskDeep, Monitor, MonitorScope, prepareBody } from './monitor.js';
export type { DepStatus, MonitorAction, MonitorEnv, MonitorError, MonitorLog, MonitorOptions } from './monitor.js';
export { createTokenVerifier, INTERNAL_TOKEN_HEADER } from './token.js';
export type { GatewayIdentity } from './token.js';

/** 錯誤回應(BACKEND-GUIDE.md §5.3);自訂代碼以系統代碼開頭,不可使用 Gateway 專用代碼 */
export function errorBody(code: string, message: string, requestId: string, details?: unknown) {
  return details === undefined ? { code, message, requestId } : { code, message, requestId, details };
}
