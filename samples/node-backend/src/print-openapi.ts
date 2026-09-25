/** 輸出本服務的 OpenAPI(不啟動服務、不連 Gateway):npm run -s openapi > openapi.json */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig({ SERVICE_CODE: 'node-sample', GW_ENV: 'dev', GW_JWKS_URL: 'http://127.0.0.1/.well-known/jwks.json', ...process.env });
const app = await buildApp(config);
await app.ready();
console.log(JSON.stringify(app.swagger(), null, 2));
await app.close();
