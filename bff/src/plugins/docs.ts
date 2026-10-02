/**
 * BFF 自身的 OpenAPI 文件(PRD §8.1、§12 可維護性;IMPL-PLAN §7 完成定義「新 API 出現在 /docs」):
 *   GET /docs        Swagger UI
 *   GET /docs/json   OpenAPI 3 JSON(W4 管理介面依此串接)
 * 僅內網:Nginx 以 internal-services 白名單限制 /docs 與其下路徑。
 * 由各路由的 JSON Schema 自動產生;須在所有路由之前註冊。內部端點(auth_request、動態路由、WebSocket、指標)不列入。
 */
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';

const HIDDEN = /^\/(_auth\/|metrics$|ws\/|api\/\*$|docs(\/|$))/;

function tagOf(url: string): string {
  const m = /^\/api\/(auth|admin|notify)\//.exec(url);
  if (m) return m[1]!;
  if (url.startsWith('/webhook/')) return 'webhook';
  return 'system';
}

export default fp<{ config: AppConfig }>(
  async (app, { config }) => {
    await app.register(swagger, {
      openapi: {
        // 路由 schema 使用 type: ['string', 'null'] 等 JSON Schema 寫法,3.1 才支援
        openapi: '3.1.0',
        info: {
          title: 'GigaNexus Gateway BFF',
          description:
            '身分、權限、動態路由與管理 API。瀏覽器以 Cookie(gn_at)呼叫,非 GET 請求需帶 X-CSRF-Token;系統對系統以 X-Api-Key 呼叫。錯誤格式 { code, message, requestId, details? }(PRD §8.1.1)。',
          version: config.gwEnv,
        },
        servers: [{ url: config.publicBaseUrl }],
        tags: [
          { name: 'auth', description: '登入、Token、本機帳號(PRD §8.2)' },
          { name: 'admin', description: '管理 API(PRD §8.7)' },
          { name: 'notify', description: '通知與站內訊息(PRD §8.5)' },
          { name: 'webhook', description: '外部系統回呼(PRD §8.6)' },
          { name: 'system', description: '健康檢查、JWKS' },
        ],
        components: {
          securitySchemes: {
            cookieAuth: { type: 'apiKey', in: 'cookie', name: 'gn_at' },
            csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
            apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
          },
        },
        security: [{ cookieAuth: [], csrf: [] }, { apiKey: [] }],
      },
      transform: ({ schema, url }) => {
        const s = { ...(schema ?? {}) } as Record<string, unknown>;
        if (HIDDEN.test(url)) s.hide = true;
        if (!s.tags) s.tags = [tagOf(url)];
        return { schema: s, url };
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'none', deepLinking: true } });
  },
  { name: 'docs' },
);
