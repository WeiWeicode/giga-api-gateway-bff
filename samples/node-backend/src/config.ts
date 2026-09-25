/**
 * 設定:Gateway 相關(GW_ENV、SERVICE_CODE、GW_BASE_URL、API Key…)由 SDK loadGatewayEnv 讀取,
 * 本檔只補上服務自己的設定。各部署區的差異見 AGENT.md §2。
 */
import { isGatewayPort, loadGatewayEnv, type GatewayEnv } from '@giganexus/backend-sdk';

export interface Config {
  gateway: GatewayEnv;
  port: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gateway = loadGatewayEnv(env);
  const port = Number(env.PORT ?? 51201);
  if (!isGatewayPort(port)) throw new Error(`PORT 必須在 51200–51300(BACKEND-GUIDE.md §3):${env.PORT}`);
  return { gateway, port, logLevel: env.LOG_LEVEL ?? (gateway.gwEnv === 'dev' ? 'debug' : 'info') };
}
