/**
 * 部署區設定(BACKEND-GUIDE.md §7.5):由環境變數讀取,三個部署區的差異集中在此。
 *
 *   GW_ENV                 dev(本機開發,不自動註冊)/ test(測試區)/ prod(正式區);test、prod 啟動時自動註冊 API
 *   SERVICE_CODE           服務代碼(= gw.upstream.code = 內部 Token 的 aud = API Key 代碼),例 go-mes
 *   GW_BASE_URL            Gateway 位址,例 https://<gateway-host>;自動註冊與路由查詢經此呼叫
 *   GW_JWKS_URL            選用,預設 {GW_BASE_URL}/.well-known/jwks.json(Nginx 只允許內網服務網段)
 *   GW_API_KEY_FILE        API Key 檔案(Docker secret);dev 可改用 GW_API_KEY。正式區只接受 _FILE
 *   SERVICE_ADVERTISE_URL  Gateway 連到本服務的位址,例 http://mes-host:51210;test、prod 必填,port 需在 51200–51300
 *
 * 開發專案(不是環境變數,不隨部署區改變):package.json 的 "gateway": { "project": "<repo 資料夾名稱>" }(Gateway AGENT.md §10.2)。
 * 複製樣本後由工程師命名一次;缺少時啟動失敗,自動註冊時由 SDK 寫入 OpenAPI 的 x-gateway.project。
 *
 * Gateway 使用開發用自簽憑證時,以 Node.js 內建的 NODE_EXTRA_CA_CERTS 指定根憑證。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type GwEnv = 'dev' | 'test' | 'prod';

export interface GatewayEnv {
  gwEnv: GwEnv;
  serviceCode: string;
  /** 開發專案:本服務 repo 的資料夾名稱(package.json gateway.project) */
  project: string;
  gatewayUrl: string | null;
  jwksUrl: string | null;
  apiKey: string | null;
  advertiseUrl: string | null;
  /** test / prod 為 true */
  autoRegister: boolean;
}

export class GatewayEnvError extends Error {
  override name = 'GatewayEnvError';
}

const SERVICE_CODE = /^[a-z][a-z0-9-]{1,49}$/;
/** 同 Gateway 對 x-gateway.project 的檢查(英數與 . _ -,100 字內) */
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 讀取 package.json 的 gateway.project(開發專案) */
export function readProject(cwd: string = process.cwd()): string {
  const file = path.join(cwd, 'package.json');
  let pkg: { gateway?: { project?: unknown } };
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8')) as typeof pkg;
  } catch (err) {
    throw new GatewayEnvError(`無法讀取 ${file}:${(err as Error).message}`);
  }
  const project = pkg.gateway?.project;
  if (typeof project !== 'string' || !PROJECT.test(project))
    throw new GatewayEnvError(
      `package.json 需設定 "gateway": { "project": "<repo 資料夾名稱>" }(開發專案,英數與 . _ -,Gateway AGENT.md §10.2;複製樣本後請工程師命名):${JSON.stringify(project ?? null)}`,
    );
  return project;
}

/** port 必須在 51200–51300(BACKEND-GUIDE.md §3) */
export function isGatewayPort(port: number): boolean {
  return Number.isInteger(port) && port >= 51200 && port <= 51300;
}

function url(name: string, v: string | undefined): string | null {
  if (!v) return null;
  try {
    return new URL(v).toString().replace(/\/$/, '');
  } catch {
    throw new GatewayEnvError(`${name} 不是合法的 URL:${v}`);
  }
}

/** cwd:package.json 所在目錄,預設為目前工作目錄(npm run / node 啟動時即服務根目錄) */
export function loadGatewayEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): GatewayEnv {
  const gwEnv = (env.GW_ENV ?? 'dev') as GwEnv;
  if (!['dev', 'test', 'prod'].includes(gwEnv)) throw new GatewayEnvError(`GW_ENV 必須是 dev / test / prod:${gwEnv}`);
  const serviceCode = env.SERVICE_CODE ?? '';
  if (!SERVICE_CODE.test(serviceCode)) throw new GatewayEnvError(`SERVICE_CODE 未設定或格式錯誤:${serviceCode}`);
  const project = readProject(cwd);

  const gatewayUrl = url('GW_BASE_URL', env.GW_BASE_URL);
  const jwksUrl = url('GW_JWKS_URL', env.GW_JWKS_URL) ?? (gatewayUrl ? `${gatewayUrl}/.well-known/jwks.json` : null);
  const advertiseUrl = url('SERVICE_ADVERTISE_URL', env.SERVICE_ADVERTISE_URL);

  if (gwEnv === 'prod' && env.GW_API_KEY) throw new GatewayEnvError('正式區不可用 GW_API_KEY 明文設定,請改用 GW_API_KEY_FILE(Docker secret)');
  let apiKey = env.GW_API_KEY ?? null;
  if (env.GW_API_KEY_FILE) {
    try {
      apiKey = readFileSync(env.GW_API_KEY_FILE, 'utf8').trim();
    } catch (err) {
      throw new GatewayEnvError(`無法讀取 GW_API_KEY_FILE:${(err as Error).message}`);
    }
  }

  const autoRegister = gwEnv !== 'dev';
  if (autoRegister) {
    const missing = [!gatewayUrl && 'GW_BASE_URL', !apiKey && 'GW_API_KEY_FILE', !advertiseUrl && 'SERVICE_ADVERTISE_URL'].filter(Boolean);
    if (missing.length) throw new GatewayEnvError(`GW_ENV=${gwEnv} 需要設定:${missing.join('、')}`);
    const port = Number(new URL(advertiseUrl!).port);
    if (!isGatewayPort(port)) throw new GatewayEnvError(`SERVICE_ADVERTISE_URL 的 port 必須在 51200–51300:${advertiseUrl}`);
  }
  if (!jwksUrl) throw new GatewayEnvError('需要設定 GW_BASE_URL 或 GW_JWKS_URL(驗證 X-Internal-Token 用)');

  return { gwEnv, serviceCode, project, gatewayUrl, jwksUrl, apiKey, advertiseUrl, autoRegister };
}
