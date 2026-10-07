/**
 * 公告 API 與 /ws/notify(NOTIFY-PLAN §6.2、§6.4、W10-2)× SQL Server。
 * 路由與資料庫為真;登入者、權限、Redis、BullMQ 以替身取代(不連 Redis、不碰測試區):
 *   - 登入者:標頭 x-test-user = 測試使用者代碼
 *   - Redis:記憶體版 set NX EX / del / publish / duplicate(訂閱)
 *   - 佇列:記錄 add 的工作
 */
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../../src/config.js';
import { department, notifyAnnouncement, user } from '../../src/db/schema/index.js';
import notifySettingsAdmin from '../../src/modules/admin/notify-settings.js';
import { AnnouncementDirectory, BROADCAST_CHANNEL } from '../../src/modules/notify/announce.js';
import announceRoutes from '../../src/modules/notify/announce-routes.js';
import { SettingsStore } from '../../src/modules/notify/settings.js';
import notifyWs from '../../src/modules/notify/ws.js';
import errorsPlugin from '../../src/plugins/errors.js';
import { openTestDb, type TestDb } from './helpers.js';

/* ---------- 替身 ---------- */

class FakeRedis extends EventEmitter {
  static bus = new EventEmitter();
  private readonly kv = new Map<string, { v: string; exp: number }>();
  private patterns: string[] = [];
  private channels: string[] = [];
  constructor() {
    super();
    FakeRedis.bus.on('msg', (channel: string, message: string) => {
      if (this.channels.includes(channel)) this.emit('message', channel, message);
      for (const p of this.patterns) if (new RegExp(`^${p.replace(/\*/g, '.*')}$`).test(channel)) this.emit('pmessage', p, channel, message);
    });
  }
  async set(k: string, v: string, ...args: (string | number)[]) {
    const now = Date.now();
    const cur = this.kv.get(k);
    if (args.includes('NX') && cur && cur.exp > now) return null;
    const ex = args.indexOf('EX');
    this.kv.set(k, { v, exp: ex >= 0 ? now + Number(args[ex + 1]) * 1000 : Infinity });
    return 'OK';
  }
  async del(k: string) {
    return this.kv.delete(k) ? 1 : 0;
  }
  async publish(channel: string, message: string) {
    FakeRedis.bus.emit('msg', channel, message);
    return 1;
  }
  duplicate() {
    return new FakeRedis();
  }
  async psubscribe(p: string) {
    this.patterns.push(p);
  }
  async subscribe(c: string) {
    this.channels.push(c);
  }
  disconnect() {}
}

type QueuedJob = { name: string; data: Record<string, unknown>; opts: { jobId?: string; delay?: number } };
const jobs = new Map<string, QueuedJob>();
let jobSeq = 0;
const fakeQueue = {
  async add(name: string, data: Record<string, unknown>, opts: QueuedJob['opts'] = {}) {
    jobs.set(opts.jobId ?? `auto-${++jobSeq}`, { name, data, opts });
  },
  async getJob(id: string) {
    return jobs.has(id) ? { remove: async () => void jobs.delete(id) } : undefined;
  },
};

/* ---------- 測試資料 ---------- */

let t: TestDb;
let app: FastifyInstance;
let base: string;
const tag = Date.now().toString(36).slice(-4).toUpperCase();
const D = { top: `H${tag}0`, leaf: `H${tag}1`, other: `H${tag}9` };
const PUBLISH = 'notify.announce.publish';
const PUBLISH_ALL = 'notify.announce.publish.all';
interface TestUser {
  userId: number;
  emp: string;
  perms: Set<string>;
}
const U: Record<'boss' | 'mgr' | 'staff' | 'other', TestUser> = {} as never;

async function addUser(key: keyof typeof U, dept: string, perms: string[], jobLevel = '8') {
  const emp = `Y${tag}${key.toUpperCase()}`.slice(0, 20);
  const [u] = await t.db
    .insert(user)
    .output({ id: user.userId })
    .values({
      employeeNo: emp,
      displayName: `測試${key}`,
      profileSource: 'ad_only',
      deptCode: dept,
      department: dept,
      jobLevel,
      email: `${emp.toLowerCase()}@example.test`,
      employmentStatus: 'active',
      createdBy: 'it-http',
      updatedBy: 'it-http',
    });
  U[key] = { userId: u!.id, emp, perms: new Set(perms) };
}

const who = (req: FastifyRequest) => Object.values(U).find((u) => u.emp === req.headers['x-test-user']);

async function call(as: keyof typeof U | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as 'GET', url, headers: { ...(as ? { 'x-test-user': U[as].emp } : {}), ...headers }, payload: body as never });
  let json: Record<string, unknown> = {};
  try {
    json = res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.statusCode, json, res };
}

const content = (o: Record<string, unknown> = {}) => ({
  title: '全體員工特休',
  bodyHtml: '<p>10/10 全體特休</p>',
  level: 'important',
  audience: { depts: [{ code: D.top, sub: true }] },
  channels: ['itapp', 'email'],
  ...o,
});

/** 最小 multipart(file 欄位) */
function multipartOf(buf: Buffer, filename: string) {
  const boundary = '----giganexus-test';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  t = await openTestDb();
  const syncedAt = new Date();
  await t.db.insert(department).values([
    { deptCode: D.top, name: '測試處', parentDeptCode: null, syncedAt },
    { deptCode: D.leaf, name: '測試課', parentDeptCode: D.top, syncedAt },
    { deptCode: D.other, name: '其他部門', parentDeptCode: null, syncedAt },
  ]);
  await addUser('boss', D.other, [PUBLISH_ALL, 'notify.settings.write', 'gw.admin.notify.read'], '2');
  await addUser('mgr', D.top, [PUBLISH], '5');
  await addUser('staff', D.leaf, []);
  await addUser('other', D.other, []);

  const config = loadConfig();
  app = Fastify({ logger: false });
  await app.register(errorsPlugin);
  app.decorate('db', t.db);
  app.decorate('redis', new FakeRedis() as never);
  app.decorate('queues', { notifyFanout: fakeQueue } as never);
  app.decorate('perms', {
    has: async (userId: number, _pv: number, perm: string) =>
      Object.values(U)
        .find((u) => u.userId === userId)
        ?.perms.has(perm) ?? false,
    list: async (userId: number) => [...(Object.values(U).find((u) => u.userId === userId)?.perms ?? [])],
  } as never);
  app.decorate('announcements', new AnnouncementDirectory(t.db));
  app.decorate('notifySettings', new SettingsStore(t.db));
  app.decorateRequest('principal', async function (this: FastifyRequest) {
    const u = who(this);
    return u ? ({ userId: u.userId, claims: { emp: u.emp, pv: 1 } } as never) : null;
  });
  app.decorateRequest('requirePrincipal', async function (this: FastifyRequest) {
    const p = await this.principal();
    if (!p) throw Object.assign(new Error('請先登入'), { statusCode: 401 });
    return p;
  });
  await app.register(announceRoutes, { config });
  await app.register(notifySettingsAdmin, { config });
  await app.register(notifyWs);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await t?.close();
});

describe('發布端', () => {
  it('沒有發布權限 403;發布畫面選項:端點 Agent 尚未開放', async () => {
    expect((await call('staff', 'GET', '/api/notify/compose-options')).status).toBe(403);
    const r = await call('mgr', 'GET', '/api/notify/compose-options');
    expect(r.status).toBe(200);
    expect(r.json.canPublishAll).toBe(false);
    expect(r.json.ownDepts).toEqual([D.top]);
    expect((r.json.channels as { code: string; available: boolean }[]).find((c) => c.code === 'agent')?.available).toBe(false);
    expect((r.json.depts as { code: string }[]).map((d) => d.code)).toEqual(expect.arrayContaining([D.top, D.leaf]));
  });

  it('預估人數與範圍:一般發布只能發本部門(含下層)', async () => {
    const own = await call('mgr', 'POST', '/api/notify/announcements/preview', { audience: { depts: [{ code: D.top, sub: true }] }, channels: ['email'] });
    expect(own.json).toMatchObject({ allowed: true, targetCount: 2, withEmail: 2 });
    const all = await call('mgr', 'POST', '/api/notify/announcements/preview', { audience: { all: true } });
    expect(all.json.allowed).toBe(false);
    const denied = await call('mgr', 'POST', '/api/notify/announcements', content({ audience: { all: true } }));
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('AUDIENCE_NOT_ALLOWED');
  });

  it('管道未開放、對象沒有人、內文空白都拒絕', async () => {
    expect((await call('boss', 'POST', '/api/notify/announcements', content({ channels: ['agent'] }))).json.code).toBe('CHANNEL_NOT_SUPPORTED');
    expect((await call('boss', 'POST', '/api/notify/announcements', content({ audience: { users: ['NOBODY'] } }))).json.code).toBe('VALIDATION_FAILED');
    expect((await call('boss', 'POST', '/api/notify/announcements', content({ bodyHtml: '<script>x</script>' }))).json.code).toBe('VALIDATION_FAILED');
  });

  let annId: number;
  let assetId: number;

  it('上傳圖片:檔頭判斷格式;未綁定前只有上傳者看得到', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
    const bad = multipartOf(Buffer.from('<svg onload="x"></svg>'), 'x.png');
    expect((await call('boss', 'POST', '/api/notify/assets', bad.payload, bad.headers)).status).toBe(400);
    const up = multipartOf(png, 'logo.png');
    const r = await call('boss', 'POST', '/api/notify/assets', up.payload, up.headers);
    expect(r.status).toBe(201);
    assetId = r.json.assetId as number;
    expect(r.json.url).toBe(`/api/notify/assets/${assetId}`);
    expect((await call('staff', 'GET', `/api/notify/assets/${assetId}`)).status).toBe(400);
    const own = await call('boss', 'GET', `/api/notify/assets/${assetId}`);
    expect(own.status).toBe(200);
    expect(own.res.headers['content-type']).toBe('image/png');
    expect(own.res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('發布:HTML 清洗、圖片綁定、入列發布工作、idempotencyKey 防重送', async () => {
    const body = content({
      bodyHtml: `<p onclick="x()">特休<script>alert(1)</script></p><img src="/api/notify/assets/${assetId}"><a href="javascript:alert(1)">連結</a>`,
      requireAck: true,
      publisherTitle: '總經理室',
      idempotencyKey: `it-${tag}`,
    });
    const r = await call('boss', 'POST', '/api/notify/announcements', body);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: 'published', targetCount: 2 });
    annId = r.json.announcementId as number;
    expect(jobs.get(`ann-pub-${annId}`)).toMatchObject({ name: 'publish', data: { kind: 'publish', announcementId: annId }, opts: { delay: 0 } });
    expect((await call('boss', 'POST', '/api/notify/announcements', body)).json.code).toBe('DUPLICATE_REQUEST');

    const d = await call('boss', 'GET', `/api/notify/announcements/${annId}`);
    expect(d.json.bodyHtml).toBe(`<p>特休</p><img src="/api/notify/assets/${assetId}" /><a target="_blank" rel="noopener noreferrer">連結</a>`);
    expect(d.json.audienceText).toBe(`部門:${D.top}(含下層)`);
    // 綁定後收件人看得到圖片
    expect((await call('staff', 'GET', `/api/notify/assets/${assetId}`)).status).toBe(200);
  });

  it('發布紀錄:只看自己的(.all 看全部),含已讀數', async () => {
    const mine = await call('mgr', 'GET', '/api/notify/announcements');
    expect((mine.json.items as { announcementId: number }[]).some((i) => i.announcementId === annId)).toBe(false);
    const all = await call('boss', 'GET', '/api/notify/announcements?mine=true');
    const item = (all.json.items as { announcementId: number; readCount: number; channels: string[] }[]).find((i) => i.announcementId === annId)!;
    expect(item).toMatchObject({ readCount: 0, channels: ['itapp', 'email'] });
  });

  describe('收件端', () => {
    it('收件匣:對象內、管道含此應用才看得到;對象外的人看不到明細', async () => {
      const feed = await call('staff', 'GET', '/api/notify/feed?app=itapp');
      const item = (feed.json.items as { kind: string; id: number; isRead: boolean; summary: string }[]).find(
        (i) => i.kind === 'announcement' && i.id === annId,
      )!;
      expect(item).toMatchObject({ isRead: false, summary: '特休 連結' });
      expect(feed.json.unread).toBeGreaterThanOrEqual(1);
      const portal = await call('staff', 'GET', '/api/notify/feed?app=portal');
      expect((portal.json.items as { id: number }[]).some((i) => i.id === annId)).toBe(false);
      expect((await call('other', 'GET', `/api/notify/announcements/${annId}`)).status).toBe(400);
      const detail = await call('staff', 'GET', `/api/notify/announcements/${annId}`);
      expect(detail.json.audience).toBeUndefined();
      expect(detail.json.title).toBe('全體員工特休');
    });

    it('已讀、確認已閱讀 → 已讀名單與 CSV', async () => {
      expect((await call('staff', 'POST', `/api/notify/announcements/${annId}/read`, { via: 'itapp' })).json.readAt).toBeTruthy();
      expect((await call('staff', 'POST', `/api/notify/announcements/${annId}/ack`, {})).json.ackAt).toBeTruthy();
      expect((await call('other', 'POST', `/api/notify/announcements/${annId}/read`, {})).status).toBe(400);
      const r = await call('boss', 'GET', `/api/notify/announcements/${annId}/receipts?state=unread`);
      expect(r.json).toMatchObject({ targetCount: 2, readCount: 1, ackCount: 1, total: 1 });
      expect((r.json.items as { employeeNo: string }[])[0]!.employeeNo).toBe(U.mgr.emp);
      const csv = await call('boss', 'GET', `/api/notify/announcements/${annId}/receipts?format=csv&state=read`);
      expect(csv.res.headers['content-type']).toContain('text/csv');
      expect(csv.res.body.charCodeAt(0)).toBe(0xfeff);
      expect(csv.res.body).toContain(U.staff.emp);
      expect((await call('mgr', 'GET', `/api/notify/announcements/${annId}/receipts`)).status).toBe(403);
    });

    it('公告查詢:關鍵字搜尋內文', async () => {
      const r = await call('staff', 'GET', `/api/notify/archive?q=${encodeURIComponent('特休')}`);
      expect((r.json.items as { id: number }[]).some((i) => i.id === annId)).toBe(true);
      const none = await call('staff', 'GET', `/api/notify/archive?q=${encodeURIComponent('不存在的字')}`);
      expect((none.json.items as { id: number }[]).some((i) => i.id === annId)).toBe(false);
    });
  });

  it('排程:延遲工作;改回草稿移除工作;草稿可修改,版本不符 409', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const r = await call('boss', 'POST', '/api/notify/announcements', content({ publishAt: at }));
    const id = r.json.announcementId as number;
    expect(r.json.status).toBe('scheduled');
    expect(jobs.get(`ann-pub-${id}`)!.opts.delay).toBeGreaterThan(3500_000);
    const cur = await call('boss', 'GET', `/api/notify/announcements/${id}`);
    const p = await call('boss', 'PATCH', `/api/notify/announcements/${id}`, { rowVer: cur.json.rowVer, publish: false, title: '改期' });
    expect(p.json).toMatchObject({ status: 'draft', title: '改期' });
    expect(jobs.has(`ann-pub-${id}`)).toBe(false);
    expect((await call('boss', 'PATCH', `/api/notify/announcements/${id}`, { rowVer: cur.json.rowVer, title: 'x' })).status).toBe(409);
  });

  it('撤回:入列撤回工作,收件匣不再出現;一般發布者不能撤回別人的公告', async () => {
    expect((await call('mgr', 'POST', `/api/notify/announcements/${annId}/revoke`)).status).toBe(403);
    expect((await call('boss', 'POST', `/api/notify/announcements/${annId}/revoke`)).json.status).toBe('revoked');
    expect([...jobs.values()].some((j) => j.name === 'revoke' && j.data.announcementId === annId)).toBe(true);
    const feed = await call('staff', 'GET', '/api/notify/feed?app=itapp');
    expect((feed.json.items as { id: number }[]).some((i) => i.id === annId)).toBe(false);
    const [row] = await t.db.select({ status: notifyAnnouncement.status }).from(notifyAnnouncement).where(eq(notifyAnnouncement.announcementId, annId));
    expect(row!.status).toBe('revoked');
  });
});

describe('/ws/notify 廣播', () => {
  const connect = (as: keyof typeof U, appCode: string) =>
    new Promise<{ ws: WebSocket; messages: Record<string, unknown>[] }>((resolve, reject) => {
      const ws = new WebSocket(`${base}/ws/notify?app=${appCode}`, { headers: { 'x-test-user': U[as].emp } });
      const messages: Record<string, unknown>[] = [];
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as Record<string, unknown>;
        messages.push(m);
        if (m.type === 'hello') resolve({ ws, messages });
      });
      ws.on('error', reject);
    });

  it('只送給對象內、且連線的應用在管道內的人;訊息不含對象與管道;撤回送給所有人', async () => {
    const staffIt = await connect('staff', 'itapp');
    const staffPortal = await connect('staff', 'portal');
    const other = await connect('other', 'itapp');
    expect(staffIt.messages[0]).toMatchObject({ type: 'hello', emp: U.staff.emp, app: 'itapp' });
    await app.redis.publish(
      BROADCAST_CHANNEL,
      JSON.stringify({ type: 'announcement', announcementId: 999001, title: '測試', audience: { depts: [{ code: D.top, sub: true }] }, channels: ['itapp'] }),
    );
    await app.redis.publish(BROADCAST_CHANNEL, JSON.stringify({ type: 'revoked', announcementId: 999001 }));
    await new Promise((r) => setTimeout(r, 300));
    expect(staffIt.messages.slice(1)).toEqual([
      { type: 'announcement', announcementId: 999001, title: '測試' },
      { type: 'revoked', announcementId: 999001 },
    ]);
    expect(staffPortal.messages.slice(1)).toEqual([{ type: 'revoked', announcementId: 999001 }]);
    expect(other.messages.slice(1)).toEqual([{ type: 'revoked', announcementId: 999001 }]);
    for (const c of [staffIt, staffPortal, other]) c.ws.close();
  });
});

describe('通知設定', () => {
  it('讀取預設值;超級管理員修改;驗證錯誤 400;沒有權限 403;保留期限預覽', async () => {
    const g = await call('boss', 'GET', '/api/admin/notify/settings');
    expect((g.json.settings as Record<string, unknown>).retentionYears).toBeNull();
    expect((await call('mgr', 'PUT', '/api/admin/notify/settings', { changes: { retentionYears: 3 } })).status).toBe(403);
    expect((await call('boss', 'PUT', '/api/admin/notify/settings', { changes: { retentionYears: 0 } })).status).toBe(400);
    expect((await call('boss', 'PUT', '/api/admin/notify/settings', { changes: { nope: 1 } })).status).toBe(400);
    const p = await call('boss', 'PUT', '/api/admin/notify/settings', { changes: { retentionYears: 3, maxEmailRecipients: 3000 } });
    expect(p.json.settings).toMatchObject({ retentionYears: 3, maxEmailRecipients: 3000 });
    const back = await call('boss', 'PUT', '/api/admin/notify/settings', { changes: { retentionYears: null, maxEmailRecipients: null } });
    expect(back.json.settings).toMatchObject({ retentionYears: null, maxEmailRecipients: 5000 });
    const pv = await call('boss', 'GET', '/api/admin/notify/settings/retention-preview?years=1');
    expect(pv.json).toMatchObject({ years: 1 });
  });
});
