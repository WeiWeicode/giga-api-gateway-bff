import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import dbViewer from './modules/admin/db-viewer.js';
import onboarding from './modules/admin/onboarding.js';
import authPlugin from './modules/auth/plugin.js';
import authRoutes from './modules/auth/routes.js';
import healthRoutes from './modules/health/routes.js';
import notifyWs from './modules/notify/ws.js';
import routerPlugin from './modules/router/plugin.js';
import dbPlugin from './plugins/db.js';
import errorsPlugin from './plugins/errors.js';
import redisPlugin from './plugins/redis.js';

/** Nginx 產生的 X-Request-Id 為 32 位 hex($request_id) */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      base: { instance: config.instanceId },
      ...(config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } } : {}),
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers["x-internal-token"]', 'req.headers["x-csrf-token"]'],
    },
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID().replaceAll('-', '');
    },
    // 只信任 Nginx 設定的 X-Forwarded-For(BFF 不直接對外)
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(errorsPlugin);
  await app.register(dbPlugin, { config });
  await app.register(redisPlugin, { config });
  await app.register(authPlugin, { config });
  await app.register(routerPlugin, { config });
  await app.register(authRoutes, { config, routes: app.routeTable });
  await app.register(notifyWs);
  await app.register(healthRoutes);
  // 資料庫檢視為 demo 用,正式區不提供
  if (config.gwEnv !== 'prod') {
    await app.register(dbViewer);
    await app.register(onboarding);
  }

  return app;
}
