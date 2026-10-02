/**
 * 通知範本與發送紀錄管理 API(PRD §8.5、§8.7、P2-7):
 *
 *   GET   /api/admin/notify/templates               範本清單                                gw.admin.notify.read
 *   GET   /api/admin/notify/templates/:id           範本明細(:id 為 template_id 或代碼)    gw.admin.notify.read
 *   POST  /api/admin/notify/templates               新增範本                                gw.admin.notify.write
 *   PATCH /api/admin/notify/templates/:id           修改範本(含停用 isEnabled = false)    gw.admin.notify.write
 *   POST  /api/admin/notify/templates/:id/preview   以測試資料預覽主旨與內文(不寄送)      gw.admin.notify.read
 *   GET   /api/admin/notify/logs                    發送紀錄(篩選、分頁,新到舊)          gw.admin.notify.read
 *
 * - 範本變數為 {{name}} 子集(modules/notify/template.ts);通道只開放 email / inapp(LINE 暫緩,PRD Q7)。
 * - 修改需帶 rowVer;範本不刪除(停用即可,發送紀錄仍以代碼對應)。寫入與 gw.audit_log 同一交易。
 */
import { and, asc, count, desc, eq, gte, like, lt, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { notifyLog, notifyTemplate, rowVerFromHex, rowVerToHex } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { CHANNELS, isChannel, parseChannels, renderTemplate } from '../notify/template.js';
import { writeAudit } from './audit-log.js';
import { createAuthorizer } from './authorize.js';

const READ = 'gw.admin.notify.read';
const WRITE = 'gw.admin.notify.write';
const ROW_VER = { type: 'string', pattern: '^[0-9a-fA-F]{16}$' };
const REF_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 50 } } };
const LOG_STATUSES = ['queued', 'sent', 'failed', 'dead', 'skipped'] as const;

const templateProps = {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  channels: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: [...CHANNELS] } },
  emailSubject: { type: ['string', 'null'], maxLength: 200 },
  emailBody: { type: ['string', 'null'], maxLength: 100_000 },
  inappBody: { type: ['string', 'null'], maxLength: 2000 },
  isEnabled: { type: 'boolean' },
} as const;

interface TemplateBody {
  code?: string;
  name?: string;
  channels?: string[];
  emailSubject?: string | null;
  emailBody?: string | null;
  inappBody?: string | null;
  isEnabled?: boolean;
  rowVer?: string;
}

function verOf(hex: string): Buffer {
  try {
    return rowVerFromHex(hex);
  } catch {
    throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'rowVer', message: '格式錯誤' }]);
  }
}

/** 啟用的通道必須有對應內容(Email:主旨與內文;站內:內文) */
function checkContent(t: { channels: string[]; emailSubject: string | null; emailBody: string | null; inappBody: string | null }) {
  const errors: { field: string; message: string }[] = [];
  if (t.channels.some((c) => !isChannel(c))) errors.push({ field: 'channels', message: `通道只能是 ${CHANNELS.join(' / ')}` });
  if (t.channels.includes('email') && (!t.emailSubject || !t.emailBody)) errors.push({ field: 'emailBody', message: 'Email 通道需有主旨與內文' });
  if (t.channels.includes('inapp') && !t.inappBody) errors.push({ field: 'inappBody', message: '站內通道需有內文' });
  if (errors.length) throw new GwError('VALIDATION_FAILED', undefined, errors);
}

const out = (t: typeof notifyTemplate.$inferSelect) => {
  const { rowVer, channels, ...rest } = t;
  return { ...rest, channels: parseChannels(channels), rowVer: rowVerToHex(rowVer) };
};

const notifyAdmin: FastifyPluginAsync = async (app) => {
  const authorize = createAuthorizer(app);

  async function findTemplate(ref: string) {
    const [t] = await app.db
      .select()
      .from(notifyTemplate)
      .where(/^\d+$/.test(ref) ? eq(notifyTemplate.templateId, Number(ref)) : eq(notifyTemplate.code, ref));
    if (!t) throw new GwError('VALIDATION_FAILED', '通知範本不存在', [{ field: 'id', message: ref }]);
    return t;
  }

  app.get('/api/admin/notify/templates', async (req) => {
    await authorize(req, READ);
    const rows = await app.db.select().from(notifyTemplate).orderBy(asc(notifyTemplate.code));
    return { items: rows.map(out) };
  });

  app.get<{ Params: { id: string } }>('/api/admin/notify/templates/:id', { schema: { params: REF_PARAMS } }, async (req) => {
    await authorize(req, READ);
    return out(await findTemplate(req.params.id));
  });

  app.post<{ Body: TemplateBody & { code: string; name: string; channels: string[] } }>(
    '/api/admin/notify/templates',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'name', 'channels'],
          additionalProperties: false,
          properties: { code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,49}$' }, ...templateProps },
        },
      },
    },
    async (req, reply) => {
      const actor = await authorize(req, WRITE);
      const b = req.body;
      const [dup] = await app.db.select({ id: notifyTemplate.templateId }).from(notifyTemplate).where(eq(notifyTemplate.code, b.code));
      if (dup) throw new GwError('VALIDATION_FAILED', '範本代碼已存在', [{ field: 'code', message: b.code }]);
      const values = {
        name: b.name,
        channels: [...new Set(b.channels)],
        emailSubject: b.emailSubject ?? null,
        emailBody: b.emailBody ?? null,
        inappBody: b.inappBody ?? null,
      };
      checkContent(values);
      const id = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(notifyTemplate)
          .output({ id: notifyTemplate.templateId })
          .values({
            code: b.code,
            ...values,
            channels: JSON.stringify(values.channels),
            isEnabled: b.isEnabled ?? true,
            createdBy: actor.name.slice(0, 64),
            updatedBy: actor.name.slice(0, 64),
          });
        await writeAudit(tx, actor, 'notify.template.create', 'notify_template', b.code, null, { ...values, isEnabled: b.isEnabled ?? true });
        return row!.id;
      });
      return reply.code(201).send(out(await findTemplate(String(id))));
    },
  );

  app.patch<{ Params: { id: string }; Body: TemplateBody & { rowVer: string } }>(
    '/api/admin/notify/templates/:id',
    {
      schema: {
        params: REF_PARAMS,
        body: { type: 'object', required: ['rowVer'], additionalProperties: false, properties: { rowVer: ROW_VER, ...templateProps } },
      },
    },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const b = req.body;
      const cur = await findTemplate(req.params.id);
      const merged = {
        name: b.name ?? cur.name,
        channels: b.channels ? [...new Set(b.channels)] : parseChannels(cur.channels),
        emailSubject: b.emailSubject !== undefined ? b.emailSubject : cur.emailSubject,
        emailBody: b.emailBody !== undefined ? b.emailBody : cur.emailBody,
        inappBody: b.inappBody !== undefined ? b.inappBody : cur.inappBody,
        isEnabled: b.isEnabled ?? cur.isEnabled,
      };
      checkContent(merged);
      await app.db.transaction(async (tx) => {
        const rows = await tx
          .update(notifyTemplate)
          .set({ ...merged, channels: JSON.stringify(merged.channels), updatedBy: actor.name.slice(0, 64) })
          .output({ inserted: { id: notifyTemplate.templateId } })
          .where(and(eq(notifyTemplate.templateId, cur.templateId), eq(notifyTemplate.rowVer, verOf(b.rowVer))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        const { rowVer: _r, ...before } = out(cur);
        await writeAudit(tx, actor, 'notify.template.update', 'notify_template', cur.code, before, merged);
      });
      return out(await findTemplate(String(cur.templateId)));
    },
  );

  app.post<{ Params: { id: string }; Body: { data?: Record<string, unknown> } }>(
    '/api/admin/notify/templates/:id/preview',
    { schema: { params: REF_PARAMS, body: { type: 'object', additionalProperties: false, properties: { data: { type: 'object' } } } } },
    async (req) => {
      await authorize(req, READ);
      const t = await findTemplate(req.params.id);
      const data = req.body?.data ?? {};
      return {
        code: t.code,
        channels: parseChannels(t.channels),
        email: t.emailBody ? { subject: renderTemplate(t.emailSubject ?? t.name, data), html: renderTemplate(t.emailBody, data, true) } : null,
        inapp: t.inappBody
          ? { title: renderTemplate(t.emailSubject ?? t.name, data).slice(0, 200), body: renderTemplate(t.inappBody, data).slice(0, 2000) }
          : null,
      };
    },
  );

  app.get<{
    Querystring: { status?: string; channel?: string; templateCode?: string; recipient?: string; from?: string; to?: string; page?: number; pageSize?: number };
  }>(
    '/api/admin/notify/logs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: [...LOG_STATUSES] },
            channel: { type: 'string', enum: [...CHANNELS] },
            templateCode: { type: 'string', maxLength: 50 },
            recipient: { type: 'string', maxLength: 200 },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => {
      await authorize(req, READ);
      const q = req.query;
      const { page = 1, pageSize = 50 } = q;
      const conds: (SQL | undefined)[] = [];
      if (q.status) conds.push(eq(notifyLog.status, q.status));
      if (q.channel) conds.push(eq(notifyLog.channel, q.channel));
      if (q.templateCode) conds.push(eq(notifyLog.templateCode, q.templateCode));
      if (q.recipient?.trim()) conds.push(like(notifyLog.recipientAddress, `%${q.recipient.trim().replace(/[[%_]/g, (c) => `[${c}]`)}%`));
      if (q.from) conds.push(gte(notifyLog.queuedAt, new Date(q.from)));
      if (q.to) conds.push(lt(notifyLog.queuedAt, new Date(q.to)));
      const where = and(...conds);
      const [[total], items] = await Promise.all([
        app.db.select({ n: count() }).from(notifyLog).where(where),
        app.db
          .select()
          .from(notifyLog)
          .where(where)
          .orderBy(desc(notifyLog.queuedAt), desc(notifyLog.logId))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
      ]);
      return { total: total?.n ?? 0, page, pageSize, items };
    },
  );
};

export default notifyAdmin;
