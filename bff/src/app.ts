import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import accessAdmin from './modules/admin/access.js';
import apiClientsAdmin from './modules/admin/api-clients.js';
import auditQuery from './modules/admin/audit-query.js';
import dbViewer from './modules/admin/db-viewer.js';
import employeeSyncAdmin from './modules/admin/employee-sync.js';
import grantsAdmin from './modules/admin/grants.js';
import importsAdmin from './modules/admin/imports.js';
import notifyAdmin from './modules/admin/notify-admin.js';
import onboarding from './modules/admin/onboarding.js';
import rbacAdmin from './modules/admin/rbac.js';
import registration from './modules/admin/registration.js';
import releasesAdmin from './modules/admin/releases.js';
import rolesAdmin from './modules/admin/roles.js';
import routeTest from './modules/admin/route-test.js';
import routingAdmin from './modules/admin/routing.js';
import usersAdmin from './modules/admin/users.js';
import authPlugin from './modules/auth/plugin.js';
import authRoutes from './modules/auth/routes.js';
import healthRoutes from './modules/health/routes.js';
import notifyInbox from './modules/notify/inbox.js';
import notifyPlugin from './modules/notify/plugin.js';
import notifyRoutes from './modules/notify/routes.js';
import notifyWs from './modules/notify/ws.js';
import routerPlugin from './modules/router/plugin.js';
import webhookRoutes from './modules/webhook/routes.js';
import dbPlugin from './plugins/db.js';
import docsPlugin from './plugins/docs.js';
import errorsPlugin from './plugins/errors.js';
import metricsPlugin from './plugins/metrics.js';
import queuesPlugin from './plugins/queues.js';
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
    // 只信任 Nginx 設定的 X-Forwarded-For(BFF 不直接對外);限定來源網段,避免直連 BFF 時偽造來源 IP
    trustProxy: config.trustedProxies,
    bodyLimit: 10 * 1024 * 1024,
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(errorsPlugin);
  // 指標 hook 與文件需在所有路由之前註冊(W3-5.11)
  await app.register(metricsPlugin);
  await app.register(docsPlugin, { config });
  await app.register(dbPlugin, { config });
  await app.register(redisPlugin, { config });
  await app.register(queuesPlugin, { config });
  await app.register(notifyPlugin);
  await app.register(authPlugin, { config });
  await app.register(routerPlugin, { config });
  await app.register(authRoutes, { config, routes: app.routeTable });
  await app.register(notifyWs);
  await app.register(notifyRoutes);
  await app.register(notifyInbox);
  await app.register(healthRoutes);
  await app.register(registration, { config });
  await app.register(rbacAdmin, { config });
  await app.register(rolesAdmin);
  await app.register(routingAdmin, { config });
  await app.register(routeTest, { config });
  await app.register(releasesAdmin, { config });
  await app.register(usersAdmin, { config });
  await app.register(accessAdmin);
  await app.register(grantsAdmin);
  await app.register(apiClientsAdmin);
  await app.register(employeeSyncAdmin);
  await app.register(importsAdmin, { config });
  await app.register(notifyAdmin);
  await app.register(auditQuery);
  await app.register(webhookRoutes, { config });
  // 資料庫檢視為 demo 用,正式區不提供
  if (config.gwEnv !== 'prod') {
    await app.register(dbViewer);
    await app.register(onboarding);
  }

  return app;
}
