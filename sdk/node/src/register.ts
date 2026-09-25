/**
 * 啟動時自動註冊(BACKEND-GUIDE.md §7.5):
 *   - dev:不註冊(回傳 null)
 *   - test / prod:送出 OpenAPI,Gateway 寫入草稿;路由由 IT 核可發佈後才生效
 * Gateway 暫時無法連線或回 5xx / 429 時以指數退避重試;4xx(規格錯誤、API Key 無效)不重試,直接丟出 GatewayError。
 */
import { GatewayClient, GatewayError, type RegistrationResult } from './client.js';
import type { GatewayEnv } from './env.js';

export interface AutoRegisterOptions {
  env: GatewayEnv;
  /** OpenAPI 規格(需含 x-gateway、x-permissions,BACKEND-GUIDE.md §6.1) */
  spec: object;
  /** 重試次數,預設 5(間隔 1、2、4、8、16 秒) */
  retries?: number;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function autoRegister(opts: AutoRegisterOptions): Promise<RegistrationResult | null> {
  const { env } = opts;
  if (!env.autoRegister) {
    opts.log?.info({ gwEnv: env.gwEnv }, '開發模式不自動註冊 API');
    return null;
  }
  const client = new GatewayClient(env.gatewayUrl!, env.apiKey!);
  const retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await client.register(opts.spec, env.advertiseUrl!);
      opts.log?.info({ ...r }, r.pendingPublish ? 'API 已註冊為草稿,待 IT 發佈' : 'API 已註冊,與 Gateway 現有設定相同');
      return r;
    } catch (err) {
      const retryable = !(err instanceof GatewayError) || err.status >= 500 || err.status === 429;
      if (!retryable || attempt >= retries) throw err;
      const wait = 1000 * 2 ** attempt;
      opts.log?.warn({ err: (err as Error).message, attempt: attempt + 1, waitMs: wait }, 'API 自動註冊失敗,稍後重試');
      await sleep(wait);
    }
  }
}
