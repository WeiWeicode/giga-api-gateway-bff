/**
 * 設定:Gateway 相關(GW_ENV、SERVICE_CODE、GW_BASE_URL、API Key…)由 SDK loadGatewayEnv 讀取,
 * 本檔只補上服務自己的設定。各部署區的差異見 AGENT.md §2。
 */
import { isGatewayPort, loadGatewayEnv, loadMonitorEnv, type GatewayEnv, type MonitorEnv } from '@giganexus/backend-sdk';

export interface Config {
  gateway: GatewayEnv;
  /** giga-observe 監控(MONITOR_URL、MONITOR_API_KEY_FILE;dev 預設關閉) */
  monitor: MonitorEnv;
  port: number;
  logLevel: string;
}

/** 樣本預設的開發專案名稱;複製後必須改成自己的 repo 資料夾名稱(AGENT.md §0) */
export const SAMPLE_PROJECT = 'node-backend';

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd?: string): Config {
  const gateway = loadGatewayEnv(env, cwd);
  if (gateway.autoRegister && gateway.project === SAMPLE_PROJECT)
    throw new Error(`package.json 的 gateway.project 仍是樣本預設值 "${SAMPLE_PROJECT}",請工程師命名為本 repo 的資料夾名稱後再部署(AGENT.md §0)`);
  const port = Number(env.PORT ?? 51201);
  if (!isGatewayPort(port)) throw new Error(`PORT 必須在 51200–51300(BACKEND-GUIDE.md §3):${env.PORT}`);
  return { gateway, monitor: loadMonitorEnv(gateway.gwEnv, env), port, logLevel: env.LOG_LEVEL ?? (gateway.gwEnv === 'dev' ? 'debug' : 'info') };
}
