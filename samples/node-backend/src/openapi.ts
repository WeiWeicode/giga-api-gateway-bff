/**
 * OpenAPI 根層設定(BACKEND-GUIDE.md §6.1):x-gateway 與 x-permissions 必填。
 * 每個 operation 的 operationId、summary、description、x-permission、x-gherkin 寫在各路由的 schema。
 */
import type { SwaggerOptions } from '@fastify/swagger';

/** 路由 schema 可用的 Gateway 擴充欄位(BACKEND-GUIDE.md §6.1),由 @fastify/swagger 原樣輸出到 operation */
declare module 'fastify' {
  interface FastifySchema {
    /** 權限代碼(例 sample.item.read)、authenticated(登入即可)或 public(免登入,需 IT 核准) */
    'x-permission'?: string;
    /** 行為規格:Gherkin 場景文字(zh-TW 關鍵字),存入 gw.api_route.gherkin */
    'x-gherkin'?: string;
    'x-audit-level'?: 'none' | 'meta' | 'body';
    'x-cache-ttl'?: number;
    'x-cache-scope'?: 'shared' | 'user';
    'x-timeout-ms'?: number;
    'x-gateway-path'?: string;
    'x-rate-limit'?: string;
  }
}

/** 本服務用到的權限代碼與中文名稱;Gateway 匯入時不存在者一併建立 */
export const PERMISSIONS = [
  { code: 'sample.item.read', name: '樣本項目:查詢' },
  { code: 'sample.item.write', name: '樣本項目:新增' },
];

export function swaggerOptions(serviceCode: string): SwaggerOptions {
  const extensions = { 'x-gateway': { upstream: serviceCode, system: 'sample' }, 'x-permissions': PERMISSIONS };
  return { openapi: { openapi: '3.0.3', info: { title: 'Node 後端樣本', version: '0.1.0' }, ...extensions } };
}
