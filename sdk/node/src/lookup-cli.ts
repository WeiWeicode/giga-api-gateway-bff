#!/usr/bin/env node
/**
 * 查詢 Gateway 既有路由,新增 API 前先查,避免重複開發(BACKEND-GUIDE.md §7.5):
 *
 *   npx gw-lookup <關鍵字> [--system mes] [--status draft,published] [--json] [--gherkin]
 *
 * 讀取環境變數 GW_BASE_URL、GW_API_KEY 或 GW_API_KEY_FILE(同 loadGatewayEnv)。
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GatewayClient, GatewayError } from './client.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    system: { type: 'string' },
    status: { type: 'string' },
    json: { type: 'boolean', default: false },
    gherkin: { type: 'boolean', default: false },
  },
});

const baseUrl = process.env.GW_BASE_URL;
const apiKey = process.env.GW_API_KEY_FILE ? readFileSync(process.env.GW_API_KEY_FILE, 'utf8').trim() : process.env.GW_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('請設定 GW_BASE_URL 與 GW_API_KEY(或 GW_API_KEY_FILE)');
  process.exit(2);
}

try {
  const r = await new GatewayClient(baseUrl, apiKey).lookup({ q: positionals.join(' '), system: values.system, status: values.status });
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`部署區 ${r.environment}:找到 ${r.total} 筆${r.truncated ? '(僅列前 200 筆,請縮小條件)' : ''}`);
    for (const i of r.items) {
      console.log(`\n${i.routeCode}  [${i.status}]  ${i.name}`);
      console.log(`  ${i.method} ${i.publicPath}  →  ${i.upstream ?? i.routeType} ${i.upstreamPath ?? ''}`);
      console.log(`  權限:${i.permissionCode ?? i.authMode}${i.tags ? `  標籤:${i.tags}` : ''}`);
      if (i.description) console.log(`  說明:${i.description}`);
      if (values.gherkin && i.gherkin) console.log(i.gherkin.replace(/^/gm, '    '));
    }
  }
} catch (err) {
  console.error(err instanceof GatewayError ? `查詢失敗:${err.message}(requestId ${err.requestId ?? '-'})` : err);
  process.exit(1);
}
