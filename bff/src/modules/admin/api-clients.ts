/**
 * API Key 管理 API(PRD §8.7、P2-5):系統對系統的 API Key(DATABASE.md §3 gw.api_client)。
 *
 *   GET    /api/admin/api-clients                 清單(不含金鑰)                      gw.admin.client.read
 *   GET    /api/admin/api-clients/:id             明細(:id 為 client_id 或代碼)        gw.admin.client.read
 *   POST   /api/admin/api-clients                 建立(回應含明文金鑰,只顯示一次)    gw.admin.client.write
 *   PATCH  /api/admin/api-clients/:id             名稱、權限範圍、允許 IP、到期、啟用   gw.admin.client.write
 *   POST   /api/admin/api-clients/:id/rotate      換發(舊金鑰立即失效,新金鑰只顯示一次)gw.admin.client.write
 *
 * - 金鑰以 Argon2id 雜湊儲存,資料庫只存前 8 碼(key_prefix)辨識;明文不寫入 log 與稽核。
 * - 權限範圍不可超過操作人本身的權限(防止以 API Key 取得自己沒有的權限)。
 * - 修改需帶 rowVer;提交後刪除 Redis 快取 gw:client:{keyPrefix}(DATABASE.md §7.2)。
 *   rowVer 為「設定版本」(名稱、權限範圍、允許 IP、到期、啟用、金鑰前綴的雜湊),不是資料表的 ROWVERSION:
 *   每次使用金鑰都會更新 last_used_at 而改變 ROWVERSION,常用的金鑰會永遠 409(2026-10-02 測試區 E2E 發現)。
 * - CLI client:create / client:disable 仍可使用(後端服務的自動註冊金鑰)。
 */
import { createHash } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { apiClient, apiClientPermission, permission } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { clientKey, generateApiKey } from '../auth/api-key.js';
import { buildBlockList } from '../auth/plugin.js';
import { writeAudit } from './audit-log.js';
import { createAuthorizer, type Actor } from './authorize.js';

const READ = 'gw.admin.client.read';
const WRITE = 'gw.admin.client.write';
const CODE = '^[a-z][a-z0-9-]{1,49}$';
const ROW_VER = { type: 'string', pattern: '^[0-9a-fA-F]{16}$' };
const REF_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 50 } } };

const clientProps = {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  permissions: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 100 } },
  allowedIps: { type: ['string', 'null'], maxLength: 500 },
  expiresAt: { type: ['string', 'null'], format: 'date-time' },
} as const;

interface ClientBody {
  code?: string;
  name?: string;
  permissions?: string[];
  allowedIps?: string | null;
  expiresAt?: string | null;
  isEnabled?: boolean;
  rowVer?: string;
}

/** 設定版本(16 碼 hex):只隨管理者可修改的欄位改變,不受 last_used_at 影響 */
function configVersion(c: typeof apiClient.$inferSelect, perms: string[]): string {
  const fields = [c.name, c.allowedIps, c.expiresAt?.toISOString() ?? null, c.isEnabled, c.keyPrefix, [...perms].sort()];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 16);
}

/** 允許 IP:逗號分隔的 IP 或 CIDR;空字串視為不限 */
function normalizeIps(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const list = (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return null;
  try {
    buildBlockList(list.join(','));
  } catch {
    throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'allowedIps', message: '需為逗號分隔的 IP 或 CIDR' }]);
  }
  return list.join(',');
}

const apiClients: FastifyPluginAsync = async (app) => {
  const authorize = createAuthorizer(app);

  async function findClient(ref: string) {
    const [c] = await app.db
      .select()
      .from(apiClient)
      .where(/^\d+$/.test(ref) ? eq(apiClient.clientId, Number(ref)) : eq(apiClient.code, ref));
    if (!c) throw new GwError('VALIDATION_FAILED', 'API Key 不存在', [{ field: 'id', message: ref }]);
    return c;
  }

  async function permsOf(clientIds: number[]) {
    if (!clientIds.length) return [];
    return app.db
      .select({ clientId: apiClientPermission.clientId, code: permission.code })
      .from(apiClientPermission)
      .innerJoin(permission, eq(permission.permissionId, apiClientPermission.permissionId))
      .where(inArray(apiClientPermission.clientId, clientIds))
      .orderBy(asc(permission.code));
  }

  const out = (c: typeof apiClient.$inferSelect, perms: string[]) => ({
    clientId: c.clientId,
    code: c.code,
    name: c.name,
    keyPrefix: c.keyPrefix,
    allowedIps: c.allowedIps,
    expiresAt: c.expiresAt,
    isEnabled: c.isEnabled,
    lastUsedAt: c.lastUsedAt,
    permissions: perms,
    createdAt: c.createdAt,
    createdBy: c.createdBy,
    updatedAt: c.updatedAt,
    updatedBy: c.updatedBy,
    rowVer: configVersion(c, perms),
  });

  /** 樂觀鎖:比對設定版本,不符回 409 */
  async function checkVersion(c: typeof apiClient.$inferSelect, rowVer: string) {
    const perms = (await permsOf([c.clientId])).map((p) => p.code);
    if (configVersion(c, perms).toLowerCase() !== rowVer.toLowerCase()) throw new GwError('VERSION_CONFLICT');
    return perms;
  }

  /** 權限代碼須存在,且操作人本身具備(API Key 操作人同樣受限於自己的權限範圍) */
  async function resolvePermissions(actor: Actor, codes: string[]) {
    const unique = [...new Set(codes)];
    const found = unique.length
      ? await app.db.select({ id: permission.permissionId, code: permission.code }).from(permission).where(inArray(permission.code, unique))
      : [];
    const unknown = unique.filter((c) => !found.some((f) => f.code === c));
    if (unknown.length)
      throw new GwError(
        'VALIDATION_FAILED',
        '權限代碼不存在',
        unknown.map((c) => ({ field: 'permissions', message: c })),
      );
    const own = await actor.permissions();
    const beyond = unique.filter((c) => !own.has(c));
    if (beyond.length) throw new GwError('PERMISSION_DENIED', `不可授予自己沒有的權限:${beyond.join(', ')}`);
    return found;
  }

  const dropCache = (keyPrefix: string) =>
    app.redis.del(clientKey(keyPrefix)).catch((err: Error) => app.log.warn({ err: err.message }, 'API Key 快取清除失敗(5 分鐘內自然過期)'));

  app.get('/api/admin/api-clients', async (req) => {
    await authorize(req, READ);
    const rows = await app.db.select().from(apiClient).orderBy(asc(apiClient.code));
    const perms = await permsOf(rows.map((r) => r.clientId));
    return {
      items: rows.map((c) =>
        out(
          c,
          perms.filter((p) => p.clientId === c.clientId).map((p) => p.code),
        ),
      ),
    };
  });

  app.get<{ Params: { id: string } }>('/api/admin/api-clients/:id', { schema: { params: REF_PARAMS } }, async (req) => {
    await authorize(req, READ);
    const c = await findClient(req.params.id);
    return out(
      c,
      (await permsOf([c.clientId])).map((p) => p.code),
    );
  });

  app.post<{ Body: ClientBody & { code: string; permissions: string[] } }>(
    '/api/admin/api-clients',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'permissions'],
          additionalProperties: false,
          properties: { code: { type: 'string', pattern: CODE }, ...clientProps },
        },
      },
    },
    async (req, reply) => {
      const actor = await authorize(req, WRITE);
      const b = req.body;
      const [dup] = await app.db.select({ id: apiClient.clientId }).from(apiClient).where(eq(apiClient.code, b.code));
      if (dup) throw new GwError('VALIDATION_FAILED', 'API Key 代碼已存在(換發請用 rotate)', [{ field: 'code', message: b.code }]);
      const perms = await resolvePermissions(actor, b.permissions);
      const allowedIps = normalizeIps(b.allowedIps) ?? null;
      const { key, keyPrefix, keyHash } = await generateApiKey();
      const clientId = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(apiClient)
          .output({ id: apiClient.clientId })
          .values({
            code: b.code,
            name: b.name ?? b.code,
            keyPrefix,
            keyHash,
            allowedIps,
            expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
            createdBy: actor.name.slice(0, 64),
            updatedBy: actor.name.slice(0, 64),
          });
        for (const p of perms) await tx.insert(apiClientPermission).values({ clientId: row!.id, permissionId: p.id });
        await writeAudit(tx, actor, 'client.create', 'api_client', b.code, null, {
          keyPrefix,
          permissions: perms.map((p) => p.code),
          allowedIps,
          expiresAt: b.expiresAt ?? null,
        });
        return row!.id;
      });
      const [c] = await app.db.select().from(apiClient).where(eq(apiClient.clientId, clientId));
      return reply.code(201).send({
        ...out(
          c!,
          perms.map((p) => p.code),
        ),
        key,
        message: '明文 API Key 只顯示這一次,請存入該服務的 Docker secret',
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: ClientBody & { rowVer: string } }>(
    '/api/admin/api-clients/:id',
    {
      schema: {
        params: REF_PARAMS,
        body: {
          type: 'object',
          required: ['rowVer'],
          additionalProperties: false,
          properties: { rowVer: ROW_VER, ...clientProps, isEnabled: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const b = req.body;
      const cur = await findClient(req.params.id);
      await checkVersion(cur, b.rowVer);
      const perms = b.permissions ? await resolvePermissions(actor, b.permissions) : null;
      const allowedIps = normalizeIps(b.allowedIps);
      const set = {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(allowedIps !== undefined ? { allowedIps } : {}),
        ...(b.expiresAt !== undefined ? { expiresAt: b.expiresAt ? new Date(b.expiresAt) : null } : {}),
        ...(b.isEnabled !== undefined ? { isEnabled: b.isEnabled } : {}),
        updatedBy: actor.name.slice(0, 64),
      };
      await app.db.transaction(async (tx) => {
        await tx.update(apiClient).set(set).where(eq(apiClient.clientId, cur.clientId));
        if (perms) {
          await tx.delete(apiClientPermission).where(eq(apiClientPermission.clientId, cur.clientId));
          for (const p of perms) await tx.insert(apiClientPermission).values({ clientId: cur.clientId, permissionId: p.id });
        }
        const { updatedBy: _u, ...after } = set;
        await writeAudit(
          tx,
          actor,
          b.isEnabled === false ? 'client.disable' : 'client.update',
          'api_client',
          cur.code,
          { name: cur.name, allowedIps: cur.allowedIps, expiresAt: cur.expiresAt, isEnabled: cur.isEnabled },
          { ...after, ...(perms ? { permissions: perms.map((p) => p.code) } : {}) },
        );
      });
      await dropCache(cur.keyPrefix);
      const [c] = await app.db.select().from(apiClient).where(eq(apiClient.clientId, cur.clientId));
      return out(
        c!,
        (await permsOf([cur.clientId])).map((p) => p.code),
      );
    },
  );

  app.post<{ Params: { id: string }; Body: { rowVer: string } }>(
    '/api/admin/api-clients/:id/rotate',
    { schema: { params: REF_PARAMS, body: { type: 'object', required: ['rowVer'], additionalProperties: false, properties: { rowVer: ROW_VER } } } },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const cur = await findClient(req.params.id);
      // 換發不改變權限範圍,但操作人仍須具備該 API Key 的全部權限
      await resolvePermissions(actor, await checkVersion(cur, req.body.rowVer));
      const { key, keyPrefix, keyHash } = await generateApiKey();
      await app.db.transaction(async (tx) => {
        await tx
          .update(apiClient)
          .set({ keyPrefix, keyHash, updatedBy: actor.name.slice(0, 64) })
          .where(eq(apiClient.clientId, cur.clientId));
        await writeAudit(tx, actor, 'client.rotate', 'api_client', cur.code, { keyPrefix: cur.keyPrefix }, { keyPrefix });
      });
      await dropCache(cur.keyPrefix);
      const [c] = await app.db.select().from(apiClient).where(eq(apiClient.clientId, cur.clientId));
      return {
        ...out(
          c!,
          (await permsOf([cur.clientId])).map((p) => p.code),
        ),
        key,
        message: '明文 API Key 只顯示這一次;舊金鑰已失效',
      };
    },
  );
};

export default apiClients;
