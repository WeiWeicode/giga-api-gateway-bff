import fp from 'fastify-plugin';
import { NotifyService } from './send.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** 通知入列(PRD §8.5);BFF 內部(註冊、重設密碼)與 /api/notify/send 共用 */
    notifier: NotifyService;
  }
}

export default fp(
  async (app) => {
    app.decorate('notifier', new NotifyService(app.db, app.redis, app.queues.notify, app.log));
  },
  { name: 'notify', dependencies: ['db', 'redis', 'queues'] },
);
