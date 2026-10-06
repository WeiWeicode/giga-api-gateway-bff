/**
 * 啟動:開始服務後,由 setupGateway 依部署區在背景自動註冊 API(dev 不註冊,test / prod 寫入 Gateway 草稿)。
 * 註冊失敗不停止服務(已發佈的路由不受影響),但以 error 等級記錄,需處理後重新部署或重啟。
 */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config);
await app.listen({ host: '0.0.0.0', port: config.port });
app.log.info({ gwEnv: config.gateway.gwEnv, serviceCode: config.gateway.serviceCode, monitor: config.monitor.enabled }, '服務已啟動');

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    // close 會一併送出監控緩衝(最多等 3 秒)
    app.close().then(() => process.exit(0));
  });
