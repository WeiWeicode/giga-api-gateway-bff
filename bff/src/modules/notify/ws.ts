/**
 * 站內通知 WebSocket /ws/notify(PRD §7.4、§8.5)。
 * 目前提供連線、身分驗證與 30 秒 ping;通知 Worker(W3-5.8)完成後經 Redis 頻道 gw:notify:user:{userId} 推播。
 */
import websocket from '@fastify/websocket';
import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';

const PING_MS = 30_000;

const notifyWs: FastifyPluginAsync = async (app) => {
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  const sockets = new Map<number, Set<WebSocket>>();
  const sub = app.redis.duplicate({ enableOfflineQueue: true });
  sub.on('error', (err) => app.log.warn({ err: err.message }, 'Redis 通知訂閱連線錯誤'));
  sub.on('pmessage', (_pattern, channel, message) => {
    for (const ws of sockets.get(Number(channel.split(':').pop())) ?? []) ws.send(message);
  });
  await sub.psubscribe('gw:notify:user:*').catch(() => undefined);
  app.addHook('onClose', async () => sub.disconnect());

  app.get('/ws/notify', { websocket: true }, async (socket, req) => {
    const p = await req.principal();
    if (!p) {
      socket.close(4401, 'UNAUTHENTICATED');
      return;
    }
    const set = sockets.get(p.userId) ?? new Set<WebSocket>();
    set.add(socket);
    sockets.set(p.userId, set);
    socket.send(JSON.stringify({ type: 'hello', emp: p.claims.emp, requestId: req.id }));
    const timer = setInterval(() => socket.ping(), PING_MS);
    socket.on('message', (data) => {
      if (data.toString() === 'ping') socket.send(JSON.stringify({ type: 'pong', time: new Date().toISOString() }));
    });
    socket.on('close', () => {
      clearInterval(timer);
      set.delete(socket);
    });
  });
};

export default notifyWs;
