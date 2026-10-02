/**
 * 人員同步紀錄與手動觸發(PRD §8.7、P2-3、DATABASE.md §8.5):權限 gw.admin.user.sync。
 *
 *   GET  /api/admin/employee-sync/runs        同步紀錄(新到舊,分頁;可依狀態篩選)
 *   GET  /api/admin/employee-sync/runs/:id    單筆紀錄
 *   POST /api/admin/employee-sync/runs        手動觸發:建立紀錄(queued)並排入 worker(佇列 employee-sync,工作 employees)→ 202
 *
 * 已有排隊或執行中(2 小時內)的同步時不重複建立,直接回傳該筆。同步本身由 worker 執行(workers/employee-sync.worker.ts)。
 */
import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { employeeSyncRun } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { createSyncRun } from '../auth/employee-sync.js';
import { writeAudit } from './audit-log.js';
import { createAuthorizer } from './authorize.js';

const PERM = 'gw.admin.user.sync';
const STATUSES = ['queued', 'running', 'success', 'partial', 'aborted', 'failed'] as const;
const PENDING_WINDOW_MS = 2 * 60 * 60 * 1000;

const employeeSync: FastifyPluginAsync = async (app) => {
  const authorize = createAuthorizer(app);

  app.get<{ Querystring: { status?: string; page?: number; pageSize?: number } }>(
    '/api/admin/employee-sync/runs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: [...STATUSES] },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => {
      await authorize(req, PERM);
      const { status, page = 1, pageSize = 50 } = req.query;
      const where = status ? eq(employeeSyncRun.status, status) : undefined;
      const [[total], items] = await Promise.all([
        app.db.select({ n: count() }).from(employeeSyncRun).where(where),
        app.db
          .select()
          .from(employeeSyncRun)
          .where(where)
          .orderBy(desc(employeeSyncRun.runId))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
      ]);
      return { total: total?.n ?? 0, page, pageSize, items };
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/admin/employee-sync/runs/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } } },
    async (req) => {
      await authorize(req, PERM);
      const [run] = await app.db.select().from(employeeSyncRun).where(eq(employeeSyncRun.runId, req.params.id));
      if (!run) throw new GwError('VALIDATION_FAILED', '同步紀錄不存在', [{ field: 'id', message: String(req.params.id) }]);
      return run;
    },
  );

  app.post('/api/admin/employee-sync/runs', async (req, reply) => {
    const actor = await authorize(req, PERM);
    const [pending] = await app.db
      .select()
      .top(1)
      .from(employeeSyncRun)
      .where(and(inArray(employeeSyncRun.status, ['queued', 'running']), gt(employeeSyncRun.startedAt, new Date(Date.now() - PENDING_WINDOW_MS))))
      .orderBy(desc(employeeSyncRun.runId));
    if (pending) return reply.code(202).send({ ...pending, alreadyPending: true, requestId: req.id });

    const runId = await createSyncRun(app.db, 'manual', actor.name.slice(0, 64), 'queued');
    try {
      await app.queues.employeeSync.add('employees', { runId }, { jobId: `employees-manual-${runId}`, removeOnComplete: 24, removeOnFail: 50 });
    } catch (err) {
      await app.db
        .update(employeeSyncRun)
        .set({ status: 'failed', finishedAt: new Date(), errorMessage: `入列失敗:${(err as Error).message}`.slice(0, 2000) })
        .where(eq(employeeSyncRun.runId, runId));
      throw err;
    }
    await app.db.transaction((tx) => writeAudit(tx, actor, 'employee_sync.trigger', 'employee_sync_run', String(runId), null, { trigger: 'manual' }));
    const [run] = await app.db.select().from(employeeSyncRun).where(eq(employeeSyncRun.runId, runId));
    return reply.code(202).send({ ...run, alreadyPending: false, requestId: req.id });
  });
};

export default employeeSync;
