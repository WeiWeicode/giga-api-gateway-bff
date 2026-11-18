/**
 * 註冊「已有帳號」提示與註冊 / 登入紀錄查詢(2026-11-18 正式區問題 #2)× SQL Server。
 *   - register:已有本機帳號 → REGISTRATION_ACCOUNT_EXISTS(409);其他原因維持 REGISTRATION_NOT_ALLOWED;都先過節流;auth_log 記實際原因
 *   - GET /api/admin/users/:id/auth-logs:gw.admin.user.read;依工號(含尚未建立使用者者)或 user_id,只回必要欄位
 * 登入者、權限、Redis 以替身取代(不連 Redis、不碰測試區)。
 */
import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { authLog, localCredential, user } from '../../src/db/schema/index.js';
import { GwError } from '../../src/errors.js';
import usersAdmin from '../../src/modules/admin/users.js';
import { LocalAccountService } from '../../src/modules/auth/local-account.js';
import errorsPlugin from '../../src/plugins/errors.js';
import { openTestDb, type TestDb } from './helpers.js';

/** 只實作節流用到的 incr / expire */
class FakeRedis {
  private readonly kv = new Map<string, number>();
  async incr(k: string) {
    const n = (this.kv.get(k) ?? 0) + 1;
    this.kv.set(k, n);
    return n;
  }
  async expire() {
    return 1;
  }
}

const noop = () => undefined;
const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log } as never;

let t: TestDb;
let app: FastifyInstance;
let svc: LocalAccountService;
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const EMP = { active: `R${tag}A`, locked: `R${tag}L`, none: `R${tag}N`, reader: `R${tag}R`, plain: `R${tag}P` };
const ids: Record<string, number> = {};
let ipSeq = 0;
const ip = () => `10.99.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`;

async function addUser(emp: string, status?: 'active' | 'locked') {
  const [u] = await t.db
    .insert(user)
    .output({ id: user.userId })
    .values({ employeeNo: emp, displayName: `測試${emp}`, profileSource: 'ad_only', createdBy: 'it-test', updatedBy: 'it-test' });
  if (status) await t.db.insert(localCredential).values({ userId: u!.id, status, registeredVia: 'admin', createdBy: 'it-test', updatedBy: 'it-test' });
  ids[emp] = u!.id;
}

async function rejectCode(employeeNo: string, from = ip()) {
  try {
    await svc.register({ employeeNo, name: '測試', ip: from, userAgent: 'vitest' });
  } catch (err) {
    expect(err).toBeInstanceOf(GwError);
    return { code: (err as GwError).code, status: (err as GwError).status, message: (err as GwError).message };
  }
  throw new Error('應該被拒絕');
}

const reasonsOf = async (emp: string) =>
  (
    await t.db
      .select({ reason: authLog.reason })
      .from(authLog)
      .where(and(eq(authLog.username, emp), eq(authLog.event, 'register_rejected')))
  ).map((r) => r.reason);

async function call(as: string | null, url: string) {
  const res = await app.inject({ method: 'GET', url, headers: as ? { 'x-test-user': as } : {} });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  t = await openTestDb();
  await addUser(EMP.active, 'active');
  await addUser(EMP.locked, 'locked');
  await addUser(EMP.reader);
  await addUser(EMP.plain);

  svc = new LocalAccountService({
    db: t.db,
    redis: new FakeRedis() as never,
    ad: { codes: [], exists: async () => false } as never,
    ext: {},
    notifier: { send: async () => undefined } as never,
    log,
    publicBaseUrl: 'https://example.test',
    revokeUser: async () => undefined,
    resetFallbackTo: 'it@example.test',
  });

  app = Fastify({ logger: false });
  await app.register(errorsPlugin);
  app.decorate('db', t.db);
  app.decorate('redis', new FakeRedis() as never);
  const perms: Record<number, string[]> = { [ids[EMP.reader]!]: ['gw.admin.user.read'] };
  app.decorate('perms', {
    has: async (userId: number, _pv: number, perm: string) => perms[userId]?.includes(perm) ?? false,
    list: async (userId: number) => perms[userId] ?? [],
  } as never);
  app.decorateRequest('principal', async function (this: FastifyRequest) {
    const emp = this.headers['x-test-user'];
    return typeof emp === 'string' && ids[emp] ? ({ userId: ids[emp], claims: { emp, pv: 1 } } as never) : null;
  });
  app.decorateRequest('requirePrincipal', async function (this: FastifyRequest) {
    const p = await this.principal();
    if (!p) throw new GwError('UNAUTHENTICATED');
    return p;
  });
  await app.register(usersAdmin, { config: loadConfig() });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await t?.close();
});

describe('register:已有帳號明確提示', () => {
  it('已有啟用中 / 鎖定的本機帳號 → REGISTRATION_ACCOUNT_EXISTS 409,auth_log 記 already_*', async () => {
    expect(await rejectCode(EMP.active)).toEqual({
      code: 'REGISTRATION_ACCOUNT_EXISTS',
      status: 409,
      message: '此工號可能已有帳號,請直接登入或使用忘記密碼',
    });
    expect((await rejectCode(EMP.locked)).code).toBe('REGISTRATION_ACCOUNT_EXISTS');
    expect(await reasonsOf(EMP.active)).toEqual(['already_active']);
    expect(await reasonsOf(EMP.locked)).toEqual(['already_locked']);
  });

  it('其他原因(工號格式)維持 REGISTRATION_NOT_ALLOWED 403', async () => {
    expect(await rejectCode(`R-${tag}`)).toMatchObject({ code: 'REGISTRATION_NOT_ALLOWED', status: 403, message: '無法註冊,請聯絡 IT' });
  });

  it('仍先過節流:同一工號超過每小時 3 次 → RATE_LIMITED,不回已有帳號', async () => {
    // EMP.active 已在第一個測試用掉 1 次
    expect((await rejectCode(EMP.active)).code).toBe('REGISTRATION_ACCOUNT_EXISTS');
    expect((await rejectCode(EMP.active)).code).toBe('REGISTRATION_ACCOUNT_EXISTS');
    expect((await rejectCode(EMP.active)).code).toBe('RATE_LIMITED');
    expect(await reasonsOf(EMP.active)).toHaveLength(3);
  });
});

describe('GET /api/admin/users/:id/auth-logs', () => {
  it('需要 gw.admin.user.read', async () => {
    expect((await call(null, `/api/admin/users/${EMP.active}/auth-logs`)).status).toBe(401);
    expect((await call(EMP.plain, `/api/admin/users/${EMP.active}/auth-logs`)).status).toBe(403);
  });

  it('依工號查:新到舊、分頁、只回必要欄位;user_id 相同但 username 不同的紀錄(例 網域\\工號)也列出', async () => {
    await t.db.insert(authLog).values({
      username: `gsmc\\${EMP.active.toLowerCase()}`,
      userId: ids[EMP.active],
      authMethod: 'ad',
      event: 'login_fail',
      reason: 'bad_password',
      ip: '10.1.1.1',
    });
    const r = await call(EMP.reader, `/api/admin/users/${EMP.active.toLowerCase()}/auth-logs?pageSize=2`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ employeeNo: EMP.active, userId: ids[EMP.active], total: 4, page: 1, pageSize: 2 });
    const items = r.json.items as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ event: 'login_fail', reason: 'bad_password', authMethod: 'ad', ip: '10.1.1.1' });
    expect(Object.keys(items[0]!).sort()).toEqual(['authMethod', 'event', 'ip', 'logId', 'occurredAt', 'reason', 'userAgent']);
    expect((await call(EMP.reader, `/api/admin/users/${ids[EMP.active]}/auth-logs`)).json.total).toBe(4);
  });

  it('尚未建立使用者的工號也可查(註冊被拒時沒有 gw.user)', async () => {
    await t.db.insert(authLog).values({ username: EMP.none, authMethod: 'local', event: 'register_rejected', reason: 'name_mismatch', ip: '10.2.2.2' });
    const r = await call(EMP.reader, `/api/admin/users/${EMP.none}/auth-logs`);
    expect(r.json).toMatchObject({ employeeNo: EMP.none, userId: null, total: 1 });
    expect((r.json.items as { reason: string }[])[0]!.reason).toBe('name_mismatch');
  });

  it('區間外的紀錄不列出', async () => {
    const r = await call(EMP.reader, `/api/admin/users/${EMP.active}/auth-logs?to=2000-01-01T00:00:00Z`);
    expect(r.json.total).toBe(0);
  });

  it('查詢區間超過 366 天 → 400', async () => {
    const r = await call(EMP.reader, `/api/admin/users/${EMP.active}/auth-logs?from=2000-01-01T00:00:00Z`);
    expect(r.status).toBe(400);
  });

  it('工號格式錯誤、不存在的 user_id → 400', async () => {
    expect((await call(EMP.reader, `/api/admin/users/${encodeURIComponent('A%B')}/auth-logs`)).status).toBe(400);
    expect((await call(EMP.reader, '/api/admin/users/999999999/auth-logs')).status).toBe(400);
  });
});
