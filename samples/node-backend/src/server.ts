/**
 * 啟動:先開始服務(Gateway 以 /healthz 檢查),再依部署區自動註冊 API(dev 不註冊,test / prod 寫入 Gateway 草稿)。
 * 註冊失敗不停止服務(已發佈的路由不受影響),但以 error 等級記錄,需處理後重新部署或重啟。
 */
import { autoRegister, GatewayError } from '@giganexus/backend-sdk';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config);
await app.listen({ host: '0.0.0.0', port: config.port });
app.log.info({ gwEnv: config.gateway.gwEnv, serviceCode: config.gateway.serviceCode }, '服務已啟動');

try {
  await autoRegister({ env: config.gateway, spec: app.swagger(), log: app.log });
} catch (err) {
  app.log.error(
    err instanceof GatewayError ? { code: err.code, status: err.status, requestId: err.requestId, details: err.details } : { err },
    'API 自動註冊失敗,Gateway 路由未更新',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    app.close().then(() => process.exit(0));
  });
