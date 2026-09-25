/**
 * 後端自動註冊與路由查詢(BACKEND-GUIDE.md §7.5、PRD §8.4.4、§8.7):
 *
 *   POST /api/admin/registrations      後端服務啟動時以 API Key 送出 OpenAPI → 寫入草稿(不發佈,由 IT 核可發佈)
 *                                      權限 gw.admin.route.register;只能註冊 API Key 代碼 = x-gateway.upstream 的服務
 *   GET  /api/admin/routes/catalog     查詢既有路由(含說明與 Gherkin),新增 API 前先查,避免重複開發
 *                                      權限 gw.admin.route.read;API Key 或登入者皆可
 *
 * 測試區與正式區各自一套資料庫(PRD Q3),各區由後端各自註冊;上游位址的部署區取自本 BFF 的 GW_ENV(dev 視同 test)。
 */
import { and, asc, eq, inArray, like, ne, or, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { apiRoute, upstream } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { ApiKeyService } from '../auth/api-key.js';
import { ImportError, importOpenApiDoc } from './route-import.js';

const CATALOG_LIMIT = 200;
const STATUSES = ['draft', 'published', 'deprecated', 'disabled'] as const;

/** LIKE 的萬用字元跳脫(SQL Server:[%]、[_]、[[]) */
const likeEscape = (s: string) => s.replace(/[[%_]/g, (c) => `[${c}]`);

const registration: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  const apiKeys = new ApiKeyService(app.db, app.redis, app.log);
  const env = config.gwEnv === 'prod' ? 'prod' : 'test';

  async function requireClient(req: FastifyRequest, perm: string) {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !key) throw new GwError('UNAUTHENTICATED', '需要 X-Api-Key');
    const c = await apiKeys.verify(key, req.ip);
    if (!c.permissions.has(perm)) throw new GwError('PERMISSION_DENIED');
    return c;
  }

  app.post<{ Body: { spec: unknown; target: string } }>(
    '/api/admin/registrations',
    {
      schema: {
        body: { type: 'object', required: ['spec', 'target'], properties: { spec: { type: 'object' }, target: { type: 'string', maxLength: 300 } } },
      },
    },
    async (req) => {
      const c = await requireClient(req, 'gw.admin.route.register');
      const doc = req.body.spec as Record<string, unknown>;
      try {
        const r = await importOpenApiDoc(app.db, {
          doc,
          text: JSON.stringify(doc),
          fileName: `registration:${c.code}`,
          target: req.body.target,
          env,
          actor: `client:${c.code}`,
          targetMode: 'add',
          lockUpstream: c.code,
          auditAction: 'route.register',
        });
        req.log.info({ client: c.code, ...r }, '後端自動註冊');
        return { ...r, environment: env, pendingPublish: r.created + r.updated > 0 };
      } catch (err) {
        if (err instanceof ImportError) throw new GwError(err.code, undefined, err.details);
        throw err;
      }
    },
  );

  app.get<{ Querystring: { q?: string; system?: string; status?: string } }>(
    '/api/admin/routes/catalog',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { q: { type: 'string', maxLength: 100 }, system: { type: 'string', maxLength: 30 }, status: { type: 'string', maxLength: 60 } },
        },
      },
    },
    async (req) => {
      if (req.headers['x-api-key']) await requireClient(req, 'gw.admin.route.read');
      else {
        const p = await req.requirePrincipal();
        if (!(await app.perms.has(p.userId, p.claims.pv, 'gw.admin.route.read'))) throw new GwError('PERMISSION_DENIED');
      }
      const conds: (SQL | undefined)[] = [];
      const statuses = (req.query.status ?? '').split(',').filter((s): s is (typeof STATUSES)[number] => (STATUSES as readonly string[]).includes(s));
      conds.push(statuses.length ? inArray(apiRoute.status, statuses) : ne(apiRoute.status, 'disabled'));
      if (req.query.system) conds.push(eq(apiRoute.systemCode, req.query.system));
      const q = req.query.q?.trim();
      if (q) {
        const pat = `%${likeEscape(q)}%`;
        conds.push(
          or(
            like(apiRoute.routeCode, pat),
            like(apiRoute.name, pat),
            like(apiRoute.publicPath, pat),
            like(apiRoute.permissionCode, pat),
            like(apiRoute.tags, pat),
            like(apiRoute.description, pat),
          ),
        );
      }
      const rows = await app.db
        .select({
          routeCode: apiRoute.routeCode,
          name: apiRoute.name,
          systemCode: apiRoute.systemCode,
          method: apiRoute.method,
          publicPath: apiRoute.publicPath,
          routeType: apiRoute.routeType,
          upstream: upstream.code,
          upstreamPath: apiRoute.upstreamPath,
          authMode: apiRoute.authMode,
          permissionCode: apiRoute.permissionCode,
          status: apiRoute.status,
          tags: apiRoute.tags,
          description: apiRoute.description,
          gherkin: apiRoute.gherkin,
        })
        .top(CATALOG_LIMIT + 1)
        .from(apiRoute)
        .leftJoin(upstream, eq(apiRoute.upstreamId, upstream.upstreamId))
        .where(and(...conds))
        .orderBy(asc(apiRoute.routeCode));
      return { environment: env, total: Math.min(rows.length, CATALOG_LIMIT), truncated: rows.length > CATALOG_LIMIT, items: rows.slice(0, CATALOG_LIMIT) };
    },
  );
};

export default registration;
