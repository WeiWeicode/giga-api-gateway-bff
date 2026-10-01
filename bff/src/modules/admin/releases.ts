/**
 * 發佈 / 回滾管理 API(PRD §8.4.3、§8.7、P2-2,取代 W3-5.7 CLI publish / rollback / releases):權限 gw.admin.release。
 *
 *   GET  /api/admin/releases                 歷史版本(新到舊,不含快照)
 *   GET  /api/admin/releases/preview         發佈前預覽:草稿清單與「目前發佈版本 → 發佈後」的差異
 *   GET  /api/admin/releases/:id             版本明細(含快照)
 *   POST /api/admin/releases                 發佈所有草稿 { note? }
 *   POST /api/admin/releases/:id/rollback    以歷史版本內容產生新版本 { note? }
 *
 * 發佈與回滾沿用 db/sync/release.ts(先提交資料庫、再更新 Redis;Redis 失敗由補償機制修正,DATABASE.md §7.3)。
 */
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../../config.js';
import { publishRelease, releaseById, rollbackRelease } from '../../db/sync/release.js';
import { apiRoute, configRelease } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { buildSnapshotContent, diffSnapshots, type RouteSnapshotContent } from '../router/snapshot.js';
import { createAuthorizer } from './authorize.js';

const PERM = 'gw.admin.release';
const LIST_LIMIT = 50;
const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const NOTE_BODY = { type: 'object', additionalProperties: false, properties: { note: { type: 'string', maxLength: 500 } } };

const releases: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  const authorize = createAuthorizer(app);

  const parseDiff = (raw: string | null) => (raw ? (JSON.parse(raw) as ReturnType<typeof diffSnapshots>) : null);

  app.get('/api/admin/releases', async (req) => {
    await authorize(req, PERM);
    const rows = await app.db
      .select({
        version: configRelease.releaseId,
        publishedBy: configRelease.publishedBy,
        publishedAt: configRelease.publishedAt,
        note: configRelease.note,
        rolledBackFrom: configRelease.rolledBackFrom,
        diffSummary: configRelease.diffSummary,
      })
      .top(LIST_LIMIT)
      .from(configRelease)
      .orderBy(desc(configRelease.releaseId));
    return { items: rows.map(({ diffSummary, ...r }) => ({ ...r, diff: parseDiff(diffSummary) })) };
  });

  // 靜態路徑優先於 :id(find-my-way)
  app.get('/api/admin/releases/preview', async (req) => {
    await authorize(req, PERM);
    const [prev] = await app.db.select().top(1).from(configRelease).orderBy(desc(configRelease.releaseId));
    const next = await buildSnapshotContent(app.db, config.gwEnv, { includeDrafts: true });
    const drafts = await app.db
      .select({ routeId: apiRoute.routeId, routeCode: apiRoute.routeCode, name: apiRoute.name, updatedAt: apiRoute.updatedAt, updatedBy: apiRoute.updatedBy })
      .from(apiRoute)
      .where(eq(apiRoute.status, 'draft'));
    const diff = diffSnapshots(prev ? (JSON.parse(prev.snapshot) as RouteSnapshotContent) : null, next);
    const changed = diff.added.length + diff.modified.length + diff.removed.length > 0 || diff.upstreamsChanged || diff.policiesChanged;
    return { currentVersion: prev?.releaseId ?? 0, drafts, diff, changed };
  });

  app.get<{ Params: { id: number } }>('/api/admin/releases/:id', { schema: { params: ID_PARAMS } }, async (req) => {
    await authorize(req, PERM);
    const [r] = await app.db.select().from(configRelease).where(eq(configRelease.releaseId, req.params.id));
    if (!r) throw new GwError('VALIDATION_FAILED', '版本不存在', [{ field: 'id', message: String(req.params.id) }]);
    const snap = await releaseById(app.db, r.releaseId);
    return {
      version: r.releaseId,
      publishedBy: r.publishedBy,
      publishedAt: r.publishedAt,
      note: r.note,
      rolledBackFrom: r.rolledBackFrom,
      diff: parseDiff(r.diffSummary),
      snapshot: snap,
    };
  });

  app.post<{ Body: { note?: string } }>('/api/admin/releases', { schema: { body: NOTE_BODY } }, async (req) => {
    const actor = await authorize(req, PERM);
    const r = await publishRelease(app.db, app.redis, { actor: actor.name, note: req.body?.note, environment: config.gwEnv, requestId: req.id });
    if (!r.redisSynced) req.log.warn({ version: r.version, err: r.redisError }, '已發佈,Redis 同步失敗(由補償機制於 60 秒內修正)');
    return { version: r.version, diff: r.diff, redisSynced: r.redisSynced };
  });

  app.post<{ Params: { id: number }; Body: { note?: string } }>(
    '/api/admin/releases/:id/rollback',
    { schema: { params: ID_PARAMS, body: NOTE_BODY } },
    async (req) => {
      const actor = await authorize(req, PERM);
      if (!(await app.db.select({ id: configRelease.releaseId }).from(configRelease).where(eq(configRelease.releaseId, req.params.id))).length)
        throw new GwError('VALIDATION_FAILED', '版本不存在', [{ field: 'id', message: String(req.params.id) }]);
      const r = await rollbackRelease(app.db, app.redis, { actor: actor.name, toVersion: req.params.id, note: req.body?.note });
      if (!r.redisSynced) req.log.warn({ version: r.version, err: r.redisError }, '已回滾,Redis 同步失敗(由補償機制於 60 秒內修正)');
      return { version: r.version, rolledBackFrom: req.params.id, diff: r.diff, redisSynced: r.redisSynced };
    },
  );
};

export default releases;
