/**
 * 站內通知收件匣(PRD §8.5,gw.notify_message):登入者只能讀寫自己的通知;/ws/notify 只推播新通知,未連線期間的通知以此查詢。
 *
 *   GET  /api/notify/messages?unread=&page=&pageSize=   我的通知(新到舊)與未讀數
 *   POST /api/notify/messages/:id/read                  標記已讀(重複標記不報錯)
 *   POST /api/notify/messages/read-all                  全部標記已讀
 */
import { and, count, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { notifyMessage } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';

const inbox: FastifyPluginAsync = async (app) => {
  const unreadOf = async (userId: number) =>
    (
      await app.db
        .select({ n: count() })
        .from(notifyMessage)
        .where(and(eq(notifyMessage.userId, userId), eq(notifyMessage.isRead, false)))
    )[0]?.n ?? 0;

  app.get<{ Querystring: { unread?: boolean; page?: number; pageSize?: number } }>(
    '/api/notify/messages',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            unread: { type: 'boolean' },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req) => {
      const p = await req.requirePrincipal();
      const { unread, page = 1, pageSize = 20 } = req.query;
      const where = and(eq(notifyMessage.userId, p.userId), unread ? eq(notifyMessage.isRead, false) : undefined);
      const [[total], items, unreadCount] = await Promise.all([
        app.db.select({ n: count() }).from(notifyMessage).where(where),
        app.db
          .select({
            messageId: notifyMessage.messageId,
            title: notifyMessage.title,
            body: notifyMessage.body,
            linkUrl: notifyMessage.linkUrl,
            isRead: notifyMessage.isRead,
            readAt: notifyMessage.readAt,
            createdAt: notifyMessage.createdAt,
          })
          .from(notifyMessage)
          .where(where)
          .orderBy(desc(notifyMessage.createdAt), desc(notifyMessage.messageId))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
        unreadOf(p.userId),
      ]);
      return { total: total?.n ?? 0, unread: unreadCount, page, pageSize, items };
    },
  );

  app.post<{ Params: { id: number } }>(
    '/api/notify/messages/:id/read',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } } },
    async (req) => {
      const p = await req.requirePrincipal();
      const [m] = await app.db
        .select({ isRead: notifyMessage.isRead })
        .from(notifyMessage)
        .where(and(eq(notifyMessage.messageId, req.params.id), eq(notifyMessage.userId, p.userId)));
      // 別人的通知與不存在一視同仁
      if (!m) throw new GwError('VALIDATION_FAILED', '通知不存在', [{ field: 'id', message: String(req.params.id) }]);
      if (!m.isRead)
        await app.db
          .update(notifyMessage)
          .set({ isRead: true, readAt: new Date() })
          .where(and(eq(notifyMessage.messageId, req.params.id), eq(notifyMessage.userId, p.userId)));
      return { messageId: req.params.id, isRead: true, unread: await unreadOf(p.userId) };
    },
  );

  app.post('/api/notify/messages/read-all', async (req) => {
    const p = await req.requirePrincipal();
    await app.db
      .update(notifyMessage)
      .set({ isRead: true, readAt: new Date() })
      .where(and(eq(notifyMessage.userId, p.userId), eq(notifyMessage.isRead, false)));
    return { unread: 0 };
  });
};

export default inbox;
