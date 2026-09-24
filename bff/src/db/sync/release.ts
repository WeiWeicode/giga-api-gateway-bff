/**
 * 路由設定發佈與 Redis 同步(DATABASE.md §7.3、PRD §8.4.3):
 *
 *   發佈:Drizzle 交易(draft → published、寫 gw.config_release N、寫 gw.audit_log)→ COMMIT
 *         → SET gw:routes:snapshot / gw:routes:version = N → PUBLISH gw:config:changed N
 *         Redis 失敗不回滾資料庫,回報「已發佈,同步中」,由補償機制修正。
 *   補償:各實例每 60 秒比對 Redis 版本與 MAX(release_id);Redis 落後時以 gw:lock:sync(SET NX PX 30000)
 *         取得鎖的實例自資料庫重推快照。
 */
import { desc, eq, max } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { GwDatabase } from '../client.js';
import { apiRoute, auditLog, configRelease } from '../schema/index.js';
import { buildSnapshotContent, diffSnapshots, type RouteSnapshot, type RouteSnapshotContent } from '../../modules/router/snapshot.js';

export const SNAPSHOT_KEY = 'gw:routes:snapshot';
export const VERSION_KEY = 'gw:routes:version';
export const CHANGED_CHANNEL = 'gw:config:changed';
export const SYNC_LOCK_KEY = 'gw:lock:sync';

export interface PublishResult {
  version: number;
  diff: ReturnType<typeof diffSnapshots>;
  redisSynced: boolean;
  redisError?: string;
}

function toSnapshot(release: { releaseId: number; snapshot: string; publishedAt: Date }): RouteSnapshot {
  return { ...(JSON.parse(release.snapshot) as RouteSnapshotContent), version: release.releaseId, publishedAt: release.publishedAt.toISOString() };
}

export async function latestRelease(db: GwDatabase): Promise<RouteSnapshot | null> {
  const [r] = await db.select().top(1).from(configRelease).orderBy(desc(configRelease.releaseId));
  return r ? toSnapshot(r) : null;
}

export async function releaseById(db: GwDatabase, id: number): Promise<RouteSnapshot | null> {
  const [r] = await db.select().from(configRelease).where(eq(configRelease.releaseId, id));
  return r ? toSnapshot(r) : null;
}

export async function maxReleaseId(db: GwDatabase): Promise<number> {
  const [r] = await db.select({ v: max(configRelease.releaseId) }).from(configRelease);
  return r?.v ?? 0;
}

/** 推送快照到 Redis 並通知所有 BFF 實例 */
export async function pushSnapshot(redis: Redis, snapshot: RouteSnapshot): Promise<void> {
  await redis
    .multi()
    .set(SNAPSHOT_KEY, JSON.stringify(snapshot))
    .set(VERSION_KEY, String(snapshot.version))
    .publish(CHANGED_CHANNEL, String(snapshot.version))
    .exec();
}

async function syncAfterCommit(redis: Redis, snapshot: RouteSnapshot): Promise<Pick<PublishResult, 'redisSynced' | 'redisError'>> {
  try {
    await pushSnapshot(redis, snapshot);
    return { redisSynced: true };
  } catch (err) {
    return { redisSynced: false, redisError: (err as Error).message };
  }
}

/** 發佈所有草稿(W3-5.6;MVP 由 CLI 呼叫,第二階段由管理 API 呼叫) */
export async function publishRelease(
  db: GwDatabase,
  redis: Redis,
  opts: { actor: string; note?: string; environment: string; requestId?: string },
): Promise<PublishResult> {
  const { version, snapshot, diff } = await db.transaction(async (tx) => {
    await tx.update(apiRoute).set({ status: 'published', updatedBy: opts.actor }).where(eq(apiRoute.status, 'draft'));
    const content = await buildSnapshotContent(tx, opts.environment);
    const [prev] = await tx.select().top(1).from(configRelease).orderBy(desc(configRelease.releaseId));
    const diff = diffSnapshots(prev ? (JSON.parse(prev.snapshot) as RouteSnapshotContent) : null, content);
    const [rel] = await tx
      .insert(configRelease)
      .output()
      .values({ snapshot: JSON.stringify(content), diffSummary: JSON.stringify(diff), note: opts.note ?? null, publishedBy: opts.actor });
    await tx.insert(auditLog).values({
      actorName: opts.actor,
      action: 'release.publish',
      entityType: 'config_release',
      entityId: String(rel!.releaseId),
      afterJson: JSON.stringify(diff),
      requestId: opts.requestId ?? null,
    });
    return { version: rel!.releaseId, snapshot: toSnapshot(rel!), diff };
  });
  return { version, diff, ...(await syncAfterCommit(redis, snapshot)) };
}

/** 回滾:以歷史版本內容產生新版本(版本號仍遞增,rolled_back_from 記錄來源) */
export async function rollbackRelease(db: GwDatabase, redis: Redis, opts: { actor: string; toVersion: number; note?: string }): Promise<PublishResult> {
  const { snapshot, diff } = await db.transaction(async (tx) => {
    const [target] = await tx.select().from(configRelease).where(eq(configRelease.releaseId, opts.toVersion));
    if (!target) throw new Error(`找不到版本 ${opts.toVersion}`);
    const [prev] = await tx.select().top(1).from(configRelease).orderBy(desc(configRelease.releaseId));
    const diff = diffSnapshots(prev ? (JSON.parse(prev.snapshot) as RouteSnapshotContent) : null, JSON.parse(target.snapshot) as RouteSnapshotContent);
    const [rel] = await tx
      .insert(configRelease)
      .output()
      .values({
        snapshot: target.snapshot,
        diffSummary: JSON.stringify(diff),
        note: opts.note ?? `rollback to ${opts.toVersion}`,
        publishedBy: opts.actor,
        rolledBackFrom: opts.toVersion,
      });
    await tx.insert(auditLog).values({
      actorName: opts.actor,
      action: 'release.rollback',
      entityType: 'config_release',
      entityId: String(rel!.releaseId),
      afterJson: JSON.stringify({ from: opts.toVersion }),
    });
    return { snapshot: toSnapshot(rel!), diff };
  });
  return { version: snapshot.version, diff, ...(await syncAfterCommit(redis, snapshot)) };
}

/**
 * 補償:Redis 版本落後資料庫時,取得分散式鎖的實例自資料庫重推快照。
 * 回傳資料庫最新版本號(供呼叫端判斷自己的路由樹是否需要重載)。
 */
export async function compensate(db: GwDatabase, redis: Redis, instanceId: string): Promise<{ dbVersion: number; redisVersion: number; pushed: boolean }> {
  const dbVersion = await maxReleaseId(db);
  const redisVersion = Number((await redis.get(VERSION_KEY)) ?? 0);
  if (dbVersion > redisVersion) {
    const locked = await redis.set(SYNC_LOCK_KEY, instanceId, 'PX', 30_000, 'NX');
    if (locked === 'OK') {
      const latest = await latestRelease(db);
      if (latest) await pushSnapshot(redis, latest);
      return { dbVersion, redisVersion, pushed: true };
    }
  }
  return { dbVersion, redisVersion, pushed: false };
}
