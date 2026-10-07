/**
 * 站內通知 WebSocket /ws/notify?app=portal|itapp(PRD §7.4、§8.5;NOTIFY-PLAN §6.4)。
 *
 *   - 個人通知:Redis 頻道 gw:notify:user:{userId}(notify worker 發布),原樣轉給該使用者的所有連線。
 *   - 公告廣播:Redis 頻道 gw:notify:broadcast(announce worker 發布,一則公告一則訊息,不展開人數);
 *     各 BFF 實例以每條連線的使用者事實比對對象(audience)與管道(channels 含連線的 app)後才送出,訊息不含對象與管道。
 *   - 前端斷線重連後一律打 /api/notify/feed 補漏;WebSocket 只負責即時,正確性以 API 為準。
 * 連線時載入使用者事實(公司、部門、職級、AD 群組),連線期間不更新(重連即更新)。
 */
import websocket from '@fastify/websocket';
import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import { loadUserFacts } from '../rbac/permission.js';
import { BROADCAST_CHANNEL, inboxAppOf, type InboxApp } from './announce.js';
import type { Audience, AudienceFacts } from './audience.js';

const PING_MS = 30_000;

interface Conn {
  socket: WebSocket;
  app: InboxApp;
  facts: AudienceFacts;
}

/** gw:notify:broadcast 的訊息(worker → BFF);audience / channels 只在 BFF 之間傳遞 */
export interface BroadcastMessage {
  type: 'announcement' | 'revoked';
  announcementId: number;
  audience?: Audience;
  channels?: string[];
  [k: string]: unknown;
}

const notifyWs: FastifyPluginAsync = async (app) => {
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  const conns = new Map<number, Set<Conn>>();
  const sub = app.redis.duplicate({ enableOfflineQueue: true });
  sub.on('error', (err) => app.log.warn({ err: err.message }, 'Redis 通知訂閱連線錯誤'));

  const broadcast = async (raw: string) => {
    let msg: BroadcastMessage;
    try {
      msg = JSON.parse(raw) as BroadcastMessage;
    } catch {
      return;
    }
    // 新公告 / 撤回:本實例的公告索引立即失效,讓前端接著打 /api/notify/feed 一定看得到
    app.announcements.invalidateIndex();
    const { audience, channels, ...payload } = msg;
    const text = JSON.stringify(payload);
    for (const set of conns.values())
      for (const c of set) {
        if (msg.type === 'revoked') c.socket.send(text);
        else if (channels?.includes(c.app) && audience && (await app.announcements.matches(audience, c.facts))) c.socket.send(text);
      }
  };

  sub.on('pmessage', (_pattern, channel, message) => {
    for (const c of conns.get(Number(channel.split(':').pop())) ?? []) c.socket.send(message);
  });
  // 依收到的順序處理(比對對象是非同步的):避免「發布後立刻撤回」時撤回先送達
  let chain = Promise.resolve();
  sub.on('message', (channel, message) => {
    if (channel !== BROADCAST_CHANNEL) return;
    chain = chain.then(() => broadcast(message)).catch((err: Error) => app.log.warn({ err: err.message }, '公告廣播轉送失敗'));
  });
  await sub.psubscribe('gw:notify:user:*').catch(() => undefined);
  await sub.subscribe(BROADCAST_CHANNEL).catch(() => undefined);
  app.addHook('onClose', async () => sub.disconnect());

  app.get<{ Querystring: { app?: string } }>('/ws/notify', { websocket: true }, async (socket, req) => {
    const p = await req.principal();
    if (!p) {
      socket.close(4401, 'UNAUTHENTICATED');
      return;
    }
    const { facts } = await loadUserFacts(app.db, p.userId);
    const conn: Conn = {
      socket,
      app: inboxAppOf(req.query.app),
      facts: { employeeNo: p.claims.emp, adGroups: facts.adGroups, memberships: facts.memberships, jobLevel: facts.jobLevel },
    };
    const set = conns.get(p.userId) ?? new Set<Conn>();
    set.add(conn);
    conns.set(p.userId, set);
    socket.send(JSON.stringify({ type: 'hello', emp: p.claims.emp, app: conn.app, requestId: req.id }));
    const timer = setInterval(() => socket.ping(), PING_MS);
    socket.on('message', (data) => {
      if (data.toString() === 'ping') socket.send(JSON.stringify({ type: 'pong', time: new Date().toISOString() }));
    });
    socket.on('close', () => {
      clearInterval(timer);
      set.delete(conn);
      if (!set.size) conns.delete(p.userId);
    });
  });
};

export default notifyWs;
