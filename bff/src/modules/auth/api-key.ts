/**
 * API Key(系統對系統,DATABASE.md §3、§6、§7.2):
 *   - 明文只在建立時顯示一次;資料庫只存前 8 碼(key_prefix,辨識用)與 Argon2id 雜湊
 *   - 請求標頭 X-Api-Key;檢查啟用、到期、允許 IP,權限範圍取自 gw.api_client_permission
 *   - 快取 gw:client:{keyPrefix}(Hash,5 分)cache-aside;停用時提交後直接 DEL
 *   - Redis 不可用時退回資料庫查詢(PRD §12 降級)
 * 目前用於後端自動註冊與路由查詢(BACKEND-GUIDE.md §7.5);路由的 api_key 驗證模式仍待 P2-5。
 */
import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { GwDatabase } from '../../db/client.js';
import { apiClient, apiClientPermission, permission } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { buildBlockList } from './plugin.js';

const ARGON2 = { algorithm: 2 /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const CACHE_TTL_SEC = 5 * 60;
const KEY_PATTERN = /^[A-Za-z0-9_-]{40}$/;

export const clientKey = (keyPrefix: string) => `gw:client:${keyPrefix}`;

export interface ApiClientPrincipal {
  clientId: number;
  code: string;
  permissions: Set<string>;
}

interface CachedClient {
  clientId: string;
  code: string;
  keyHash: string;
  allowedIps: string;
  expiresAt: string;
  isEnabled: string;
  permissions: string;
}

/** 產生 API Key:40 碼 base64url,前 8 碼為 key_prefix */
export async function generateApiKey(): Promise<{ key: string; keyPrefix: string; keyHash: string }> {
  const key = randomBytes(30).toString('base64url');
  return { key, keyPrefix: key.slice(0, 8), keyHash: await hash(key, ARGON2) };
}

export class ApiKeyService {
  constructor(
    private readonly db: GwDatabase,
    private readonly redis: Redis,
    private readonly log: FastifyBaseLogger,
  ) {}

  private async load(keyPrefix: string): Promise<CachedClient | null> {
    try {
      const hit = (await this.redis.hgetall(clientKey(keyPrefix))) as unknown as CachedClient;
      if (hit.clientId) return hit;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Redis 無法讀取 API Key 快取,改查資料庫');
    }
    const [c] = await this.db.select().from(apiClient).where(eq(apiClient.keyPrefix, keyPrefix));
    if (!c) return null;
    const perms = await this.db
      .select({ code: permission.code })
      .from(apiClientPermission)
      .innerJoin(permission, eq(permission.permissionId, apiClientPermission.permissionId))
      .where(eq(apiClientPermission.clientId, c.clientId));
    const row: CachedClient = {
      clientId: String(c.clientId),
      code: c.code,
      keyHash: c.keyHash,
      allowedIps: c.allowedIps ?? '',
      expiresAt: c.expiresAt?.toISOString() ?? '',
      isEnabled: c.isEnabled ? '1' : '0',
      permissions: perms.map((p) => p.code).join(','),
    };
    try {
      await this.redis.multi().hset(clientKey(keyPrefix), row).expire(clientKey(keyPrefix), CACHE_TTL_SEC).exec();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'Redis 無法寫入 API Key 快取');
    }
    return row;
  }

  /** 驗證 X-Api-Key;金鑰錯誤、停用、過期回 UNAUTHENTICATED,來源 IP 不在允許清單回 PERMISSION_DENIED */
  async verify(key: string, ip: string): Promise<ApiClientPrincipal> {
    if (!KEY_PATTERN.test(key)) throw new GwError('UNAUTHENTICATED', 'API Key 無效');
    const c = await this.load(key.slice(0, 8));
    // 雜湊格式錯誤視同金鑰不符
    const ok = !!c && (await verify(c.keyHash, key).catch(() => false));
    if (!c || !ok || c.isEnabled !== '1' || (c.expiresAt && new Date(c.expiresAt) <= new Date())) throw new GwError('UNAUTHENTICATED', 'API Key 無效');
    if (c.allowedIps) {
      const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
      if (!buildBlockList(c.allowedIps).check(v4, v4.includes(':') ? 'ipv6' : 'ipv4'))
        throw new GwError('PERMISSION_DENIED', '來源 IP 不在此 API Key 的允許清單');
    }
    const clientId = Number(c.clientId);
    this.db
      .update(apiClient)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiClient.clientId, clientId))
      .catch((err: Error) => this.log.warn({ err: err.message, clientId }, '無法更新 API Key 最後使用時間'));
    return { clientId, code: c.code, permissions: new Set(c.permissions ? c.permissions.split(',') : []) };
  }
}
