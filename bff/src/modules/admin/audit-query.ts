/**
 * 稽核查詢 API(PRD §8.7、§12 稽核、P2-7):權限 gw.admin.audit.read。
 *
 *   GET /api/admin/audit-logs   管理操作紀錄(gw.audit_log):操作人、動作、對象、時間區間
 *   GET /api/admin/auth-logs    登入與帳號事件(gw.auth_log):帳號、使用者、事件、來源 IP、時間區間
 *
 * 新到舊、分頁;未指定時間區間時預設最近 30 天(稽核表依 occurred_at 叢集索引,避免全表掃描)。before / after 以物件回傳。
 */
import { and, count, desc, eq, gte, like, lt, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { auditLog, authLog } from '../../db/schema/index.js';
import { normalizeEmpNo } from '../auth/profile.js';
import { createAuthorizer } from './authorize.js';

const PERM = 'gw.admin.audit.read';
const DEFAULT_DAYS = 30;
const PAGING = { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 } };
const RANGE = { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } };

const likeOf = (q: string) => `%${q.replace(/[[%_]/g, (c) => `[${c}]`)}%`;

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function range(from?: string, to?: string) {
  const start = from ? new Date(from) : new Date(Date.now() - DEFAULT_DAYS * 86_400_000);
  return { start, end: to ? new Date(to) : null };
}

const auditQuery: FastifyPluginAsync = async (app) => {
  const authorize = createAuthorizer(app);

  app.get<{
    Querystring: {
      actor?: string;
      action?: string;
      entityType?: string;
      entityId?: string;
      requestId?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    };
  }>(
    '/api/admin/audit-logs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            actor: { type: 'string', maxLength: 100 },
            action: { type: 'string', maxLength: 60 },
            entityType: { type: 'string', maxLength: 40 },
            entityId: { type: 'string', maxLength: 100 },
            requestId: { type: 'string', maxLength: 64 },
            ...RANGE,
            ...PAGING,
          },
        },
      },
    },
    async (req) => {
      await authorize(req, PERM);
      const q = req.query;
      const { page = 1, pageSize = 50 } = q;
      const { start, end } = range(q.from, q.to);
      const conds: (SQL | undefined)[] = [gte(auditLog.occurredAt, start)];
      if (end) conds.push(lt(auditLog.occurredAt, end));
      if (q.actor?.trim()) conds.push(like(auditLog.actorName, likeOf(q.actor.trim())));
      // 動作以前綴比對:route. 可查所有路由操作
      if (q.action?.trim()) conds.push(like(auditLog.action, `${q.action.trim().replace(/[[%_]/g, (c) => `[${c}]`)}%`));
      if (q.entityType) conds.push(eq(auditLog.entityType, q.entityType));
      if (q.entityId) conds.push(eq(auditLog.entityId, q.entityId));
      if (q.requestId) conds.push(eq(auditLog.requestId, q.requestId));
      const where = and(...conds);
      const [[total], rows] = await Promise.all([
        app.db.select({ n: count() }).from(auditLog).where(where),
        app.db
          .select()
          .from(auditLog)
          .where(where)
          .orderBy(desc(auditLog.occurredAt), desc(auditLog.auditId))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
      ]);
      return {
        total: total?.n ?? 0,
        page,
        pageSize,
        from: start,
        to: end,
        items: rows.map(({ beforeJson, afterJson, ...r }) => ({ ...r, before: parseJson(beforeJson), after: parseJson(afterJson) })),
      };
    },
  );

  app.get<{ Querystring: { username?: string; userId?: number; event?: string; ip?: string; from?: string; to?: string; page?: number; pageSize?: number } }>(
    '/api/admin/auth-logs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            username: { type: 'string', maxLength: 128 },
            userId: { type: 'integer', minimum: 1 },
            event: { type: 'string', maxLength: 30 },
            ip: { type: 'string', maxLength: 45 },
            ...RANGE,
            ...PAGING,
          },
        },
      },
    },
    async (req) => {
      await authorize(req, PERM);
      const q = req.query;
      const { page = 1, pageSize = 50 } = q;
      const { start, end } = range(q.from, q.to);
      const conds: (SQL | undefined)[] = [gte(authLog.occurredAt, start)];
      if (end) conds.push(lt(authLog.occurredAt, end));
      if (q.username?.trim()) conds.push(like(authLog.username, likeOf(normalizeEmpNo(q.username))));
      if (q.userId) conds.push(eq(authLog.userId, q.userId));
      if (q.event) conds.push(eq(authLog.event, q.event));
      if (q.ip) conds.push(eq(authLog.ip, q.ip));
      const where = and(...conds);
      const [[total], items] = await Promise.all([
        app.db.select({ n: count() }).from(authLog).where(where),
        app.db
          .select()
          .from(authLog)
          .where(where)
          .orderBy(desc(authLog.occurredAt), desc(authLog.logId))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
      ]);
      return { total: total?.n ?? 0, page, pageSize, from: start, to: end, items };
    },
  );
};

export default auditQuery;
