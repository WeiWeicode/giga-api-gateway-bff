import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

/**
 * Redis 為衍生資料(DATABASE.md §7.1):連不上時 BFF 仍需能啟動,以記憶體 / 本地快照服務既有路由。
 * 因此不在啟動時等待連線成功;就緒狀態由 /readyz 回報。
 */
export default fp<{ config: AppConfig }>(
  async (app, { config }) => {
    const redis = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectionName: 'giganexus-bff',
    });
    redis.on('error', (err) => app.log.warn({ err: err.message }, 'Redis 連線錯誤'));
    app.decorate('redis', redis);
    app.addHook('onClose', async () => {
      redis.disconnect();
    });
  },
  { name: 'redis' },
);
