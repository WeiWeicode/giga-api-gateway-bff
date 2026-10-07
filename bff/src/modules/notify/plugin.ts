import fp from 'fastify-plugin';
import { AnnouncementDirectory } from './announce.js';
import { NotifyService } from './send.js';
import { SettingsStore } from './settings.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** 通知入列(PRD §8.5);BFF 內部(註冊、重設密碼)與 /api/notify/send 共用 */
    notifier: NotifyService;
    /** 公告對象展開、索引(NOTIFY-PLAN §6) */
    announcements: AnnouncementDirectory;
    /** 通知設定(NOTIFY-PLAN §6.9),快取 60 秒 */
    notifySettings: SettingsStore;
  }
}

export default fp(
  async (app) => {
    app.decorate('notifier', new NotifyService(app.db, app.redis, app.queues.notify, app.log));
    app.decorate('announcements', new AnnouncementDirectory(app.db));
    app.decorate('notifySettings', new SettingsStore(app.db));
  },
  { name: 'notify', dependencies: ['db', 'redis', 'queues'] },
);
