/**
 * Fastify 應用程式:
 *   - 驗證 X-Internal-Token(BACKEND-GUIDE.md §4.2),身分放在 req.identity;x-permission: public 的 API 可不帶 Token
 *   - 錯誤格式 { code, message, requestId, details? }(§5.3),不回傳堆疊或 SQL
 *   - GET /healthz(必備)、GET /readyz、GET /openapi.json(§5.4、§6)
 *   - setupGateway:API 監控送 giga-observe、開始服務後自動註冊(§7.5、§11);req.monitor.action() 記錄步驟
 */
import swagger from '@fastify/swagger';
import { createTokenVerifier, errorBody, INTERNAL_TOKEN_HEADER, type GatewayIdentity } from '@giganexus/backend-sdk';
import { setupGateway } from '@giganexus/backend-sdk/fastify';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { swaggerOptions } from './openapi.js';
import itemRoutes from './routes/items.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity: GatewayIdentity | null;
  }
  interface FastifyContextConfig {
    /** false:不驗證 Token(健康檢查、OpenAPI) */
    gatewayAuth?: boolean;
  }
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers["x-internal-token"]'] },
    // 沿用 Gateway 傳下來的 X-Request-Id,寫入每一筆日誌(§5.2)
    requestIdHeader: 'x-request-id',
  });
  const verify = createTokenVerifier({ jwksUrl: config.gateway.jwksUrl!, audience: config.gateway.serviceCode });

  await app.register(swagger, swaggerOptions(config.gateway.serviceCode, config.gateway.project));
  // 監控 + 自動註冊;需在路由之前註冊。version 隨心跳回報,架構圖的服務詳情會顯示
  await app.register(setupGateway, { env: config.gateway, monitor: config.monitor, version: process.env.npm_package_version });

  app.decorateRequest('identity', null);
  app.addHook('onRequest', async (req) => {
    // 找不到路由交給 404;健康檢查與 OpenAPI 不驗證
    if (!req.routeOptions.url || req.routeOptions.config.gatewayAuth === false) return;
    const token = req.headers[INTERNAL_TOKEN_HEADER];
    const isPublic = req.routeOptions.schema?.['x-permission'] === 'public';
    if (typeof token !== 'string' || !token) {
      if (isPublic) return;
      throw new AppError(401, 'SAMPLE_INTERNAL_TOKEN_INVALID', '缺少內部 Token');
    }
    try {
      req.identity = await verify(token);
    } catch {
      // 只有 Token 驗證失敗才回 401;Gateway 收到會視為設定錯誤並告警(§5.3)
      throw new AppError(401, 'SAMPLE_INTERNAL_TOKEN_INVALID', '內部 Token 無效');
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.removeHeader('x-powered-by');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send(errorBody(err.code, err.message, req.id, err.details));
    const e = err as { validation?: { instancePath: string; message?: string }[]; statusCode?: number };
    if (e.validation)
      return reply.status(400).send(
        errorBody(
          'VALIDATION_FAILED',
          '參數驗證失敗',
          req.id,
          e.validation.map((v) => ({ field: v.instancePath.replace(/^\//, '') || '(body)', message: v.message ?? '' })),
        ),
      );
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send(errorBody('VALIDATION_FAILED', '請求格式錯誤', req.id));
    req.log.error({ err }, '非預期錯誤');
    return reply.status(500).send(errorBody('INTERNAL_ERROR', '系統發生錯誤', req.id));
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send(errorBody('SAMPLE_NOT_FOUND', '找不到此 API', req.id)));

  const noAuth = { config: { gatewayAuth: false }, schema: { hide: true } };
  app.get('/healthz', noAuth, async () => ({ status: 'ok' }));
  // 範例沒有相依服務;接資料庫後在此檢查連線,不可用時回 503
  app.get('/readyz', noAuth, async () => ({ status: 'ok' }));
  app.get('/openapi.json', noAuth, async () => app.swagger());

  await app.register(itemRoutes);
  return app;
}
