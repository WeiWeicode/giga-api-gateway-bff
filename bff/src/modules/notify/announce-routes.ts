/**
 * 公告 API(NOTIFY-PLAN §6.2):
 *
 *   發布端(notify.announce.publish;對象超出本部門需 notify.announce.publish.all)
 *     GET   /api/notify/compose-options              發布畫面選項(管道、等級、職級門檻、公司、部門、預設值)
 *     POST  /api/notify/announcements/preview        對象預估人數(不寫入)
 *     POST  /api/notify/announcements                發布 / 排程 / 存草稿
 *     PATCH /api/notify/announcements/:id            修改草稿或排程中的公告(publish: true 發布草稿)
 *     GET   /api/notify/announcements                發布紀錄(本人;.all 看全部),含已讀數與 Email 寄送進度
 *     GET   /api/notify/announcements/:id/receipts   已讀 / 未讀名單(format=csv 匯出)
 *     POST  /api/notify/announcements/:id/revoke     撤回
 *     POST  /api/notify/announcements/:id/remind     對未讀者重寄 Email(同一公告 10 分鐘一次)
 *     POST  /api/notify/assets                       上傳內文圖片(multipart:file)
 *   收件端(登入即可,資料以登入者與對象過濾)
 *     GET   /api/notify/feed?app=itapp|portal         收件匣:有效公告 + 個人通知,新到舊,含未讀數
 *     GET   /api/notify/archive                       公告查詢:我在對象內的已發布公告(含已到期,不限年份)
 *     GET   /api/notify/announcements/:id             明細(發布人、.all 或對象內的人)
 *     POST  /api/notify/announcements/:id/read | ack  已讀 / 確認已閱讀
 *     GET   /api/notify/assets/:id                    內文圖片
 *
 * 寫入與 gw.audit_log 同一交易;分送(廣播、Email)由 worker 處理(workers/announce.worker.ts)。
 */
import multipart from '@fastify/multipart';
import { and, asc, count, desc, eq, inArray, isNull, like, or, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import {
  company,
  department,
  notifyAnnouncement,
  notifyAnnouncementAsset,
  notifyLog,
  notifyMessage,
  rowVerFromHex,
  rowVerToHex,
} from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { fanoutPublishJobId } from '../../plugins/queues.js';
import { writeAudit } from '../admin/audit-log.js';
import { JOB_TIERS } from '../rbac/job-tiers.js';
import { openCompanyIds } from '../rbac/login-companies.js';
import { loadUserFacts } from '../rbac/permission.js';
import {
  ANNOUNCE_CHANNELS,
  AVAILABLE_CHANNELS,
  CHANNEL_NAMES,
  LEVELS,
  inboxAppOf,
  markRead,
  parseChannelList,
  readCounts,
  receiptsFor,
  receiptsOf,
  type AnnounceChannel,
  type IndexEntry,
} from './announce.js';
import { describeAudience, normalizeAudience, parseAudience, withinOwnDepts, type Audience, type AudienceFacts } from './audience.js';
import { ASSET_PATH, MAX_BODY_CHARS, assetIdsIn, htmlToPlainText, sanitizeAnnouncementHtml, sniffImage, summaryOf } from './html.js';

const PUBLISH = 'notify.announce.publish';
const PUBLISH_ALL = 'notify.announce.publish.all';

const LEVEL_NAMES: Record<string, string> = { info: '一般', important: '重要', urgent: '緊急' };
const IDEM_TTL_SEC = 24 * 60 * 60;
const REMIND_LOCK_SEC = 10 * 60;
const MAX_UPLOAD = 5 * 1024 * 1024;
const ROW_VER = { type: 'string', pattern: '^[0-9a-fA-F]{16}$' };
const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const PAGING = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
};

const audienceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    all: { type: 'boolean' },
    companies: { type: 'array', maxItems: 50, items: { type: 'integer', minimum: 1 } },
    depts: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['code'],
        additionalProperties: false,
        properties: { code: { type: 'string', minLength: 1, maxLength: 30 }, sub: { type: 'boolean' } },
      },
    },
    jobTier: { type: 'string', maxLength: 20 },
    adGroups: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 300 } },
    users: { type: 'array', maxItems: 2000, items: { type: 'string', minLength: 1, maxLength: 20 } },
  },
};

const contentProps = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  bodyHtml: { type: 'string', maxLength: 2_000_000 },
  linkUrl: { type: ['string', 'null'], maxLength: 500 },
  level: { type: 'string', enum: [...LEVELS] },
  audience: audienceSchema,
  channels: { type: 'array', maxItems: 4, items: { type: 'string', enum: [...ANNOUNCE_CHANNELS] } },
  requireAck: { type: 'boolean' },
  publishAt: { type: ['string', 'null'], format: 'date-time' },
  expireAt: { type: ['string', 'null'], format: 'date-time' },
  publisherTitle: { type: ['string', 'null'], maxLength: 100 },
};

interface ContentBody {
  title?: string;
  bodyHtml?: string;
  linkUrl?: string | null;
  level?: string;
  audience?: Audience;
  channels?: string[];
  requireAck?: boolean;
  publishAt?: string | null;
  expireAt?: string | null;
  publisherTitle?: string | null;
}

type Row = typeof notifyAnnouncement.$inferSelect;

/** 對外格式:JSON 欄位解開、rowVer 轉 hex */
function out(r: Row) {
  const { rowVer, audience, channels, idempotencyKey: _k, ...rest } = r;
  return { ...rest, audience: parseAudience(audience), channels: parseChannelList(channels), rowVer: rowVerToHex(rowVer) };
}

const linkOk = (v: string) => v.startsWith('https://') || /^\/(?!\/)/.test(v);

function verOf(hex: string): Buffer {
  try {
    return rowVerFromHex(hex);
  } catch {
    throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'rowVer', message: '格式錯誤' }]);
  }
}

/** CSV 欄位跳脫(含公式注入防護:= + - @ 開頭加單引號) */
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const likeEscape = (s: string) => s.replace(/[[%_]/g, (c) => `[${c}]`);

const announceRoutes: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD, files: 1, fields: 5 } });
  const db = app.db;
  const dir = app.announcements;

  /** 發布權限:notify.announce.publish 或 .all */
  const publisher = async (req: FastifyRequest) => {
    const p = await req.requirePrincipal();
    const [canAll, can] = await Promise.all([app.perms.has(p.userId, p.claims.pv, PUBLISH_ALL), app.perms.has(p.userId, p.claims.pv, PUBLISH)]);
    if (!canAll && !can) throw new GwError('PERMISSION_DENIED');
    return { p, canAll, actor: { name: p.claims.emp, userId: p.userId, ip: req.ip, requestId: req.id } };
  };

  /** 登入者的對象比對事實 */
  const factsOf = async (userId: number, employeeNo: string): Promise<AudienceFacts & { ownDepts: string[] }> => {
    const { facts } = await loadUserFacts(db, userId);
    return {
      employeeNo,
      adGroups: facts.adGroups,
      memberships: facts.memberships,
      jobLevel: facts.jobLevel,
      ownDepts: facts.memberships.map((m) => m.deptCode).filter((d): d is string => !!d),
    };
  };

  const findRow = async (id: number) => {
    const [r] = await db.select().from(notifyAnnouncement).where(eq(notifyAnnouncement.announcementId, id));
    if (!r) throw new GwError('VALIDATION_FAILED', '公告不存在', [{ field: 'id', message: String(id) }]);
    return r;
  };

  /** 發布人本人或 .all 才能管理 */
  const assertOwner = (r: Row, emp: string, canAll: boolean) => {
    if (!canAll && r.createdBy !== emp) throw new GwError('PERMISSION_DENIED');
  };

  /**
   * 驗證與整理內容。publishing = true 時(發布 / 排程)檢查完整;草稿只檢查格式。
   * 對象範圍:沒有 .all 只能發給本部門(含下層)。
   */
  const prepare = async (
    b: Required<Pick<ContentBody, 'title' | 'bodyHtml' | 'level'>> & ContentBody,
    ctx: { emp: string; canAll: boolean; ownDepts: string[]; publishing: boolean; announcementId?: number },
  ) => {
    const errors: { field: string; message: string }[] = [];
    const title = b.title.trim();
    if (!title) errors.push({ field: 'title', message: '必填' });
    const bodyHtml = sanitizeAnnouncementHtml(b.bodyHtml ?? '');
    if (bodyHtml.length > MAX_BODY_CHARS) throw new GwError('PAYLOAD_TOO_LARGE', `內文超過 ${MAX_BODY_CHARS / 1000} K 字元`);
    const bodyText = htmlToPlainText(bodyHtml);
    const assetIds = assetIdsIn(bodyHtml);
    if (ctx.publishing && !bodyText && !assetIds.length) errors.push({ field: 'bodyHtml', message: '內文不可空白' });
    const linkUrl = b.linkUrl?.trim() || null;
    if (linkUrl && !linkOk(linkUrl)) errors.push({ field: 'linkUrl', message: '只接受 https:// 或站內路徑(/ 開頭)' });
    if (!(LEVELS as readonly string[]).includes(b.level)) errors.push({ field: 'level', message: `只能是 ${LEVELS.join(' / ')}` });

    const channels = [...new Set(b.channels ?? [])] as AnnounceChannel[];
    if (ctx.publishing && !channels.length) errors.push({ field: 'channels', message: '至少選擇一個管道' });
    const unavailable = channels.filter((c) => !AVAILABLE_CHANNELS.includes(c));
    if (ctx.publishing && unavailable.length)
      throw new GwError('CHANNEL_NOT_SUPPORTED', `尚未開放:${unavailable.map((c) => CHANNEL_NAMES[c]).join('、')}`, { channels: unavailable });

    const { audience, errors: audErrors } = normalizeAudience(b.audience ?? {});
    if (ctx.publishing || b.audience) errors.push(...audErrors);

    const now = new Date();
    const publishAt = b.publishAt ? new Date(b.publishAt) : null;
    const expireAt = b.expireAt ? new Date(b.expireAt) : null;
    if (expireAt && expireAt <= (publishAt && publishAt > now ? publishAt : now)) errors.push({ field: 'expireAt', message: '需晚於發布時間' });
    if (errors.length) throw new GwError('VALIDATION_FAILED', undefined, errors);

    if (!audErrors.length && !ctx.canAll && !withinOwnDepts(audience, ctx.ownDepts, await dir.deptTree()))
      throw new GwError('AUDIENCE_NOT_ALLOWED', '沒有全公司發布權限時,對象只能是本部門(含下層)');

    // 內文圖片:必須存在、尚未綁定其他公告、由本人上傳(.all 不限)
    if (assetIds.length) {
      const rows = await db
        .select({ id: notifyAnnouncementAsset.assetId, announcementId: notifyAnnouncementAsset.announcementId, createdBy: notifyAnnouncementAsset.createdBy })
        .from(notifyAnnouncementAsset)
        .where(inArray(notifyAnnouncementAsset.assetId, assetIds));
      const ok = new Set(
        rows.filter((r) => (r.announcementId === null || r.announcementId === ctx.announcementId) && (ctx.canAll || r.createdBy === ctx.emp)).map((r) => r.id),
      );
      const bad = assetIds.filter((id) => !ok.has(id));
      if (bad.length)
        throw new GwError(
          'VALIDATION_FAILED',
          '內文圖片不存在或無權使用',
          bad.map((id) => ({ field: 'bodyHtml', message: `${ASSET_PATH}${id}` })),
        );
    }

    return {
      title,
      bodyHtml,
      bodyText,
      linkUrl,
      level: b.level,
      audience,
      channels,
      requireAck: b.requireAck ?? false,
      publishAt,
      expireAt,
      publisherTitle: b.publisherTitle?.trim() || null,
      assetIds,
    };
  };

  /** 發布前檢查人數(對象沒有人、Email 超過上限) */
  const countTargets = async (audience: Audience, channels: string[]) => {
    const people = await dir.expand(audience);
    const withEmail = people.filter((p) => p.email).length;
    if (!people.length) throw new GwError('VALIDATION_FAILED', '對象沒有任何在職人員', [{ field: 'audience', message: '0 人' }]);
    if (channels.includes('email')) {
      const max = (await app.notifySettings.get()).maxEmailRecipients;
      if (withEmail > max)
        throw new GwError('VALIDATION_FAILED', `Email 收件人 ${withEmail} 人,超過單次上限 ${max} 人`, [{ field: 'channels', message: 'email' }]);
    }
    return { targetCount: people.length, withEmail };
  };

  /** 入列發布工作;排程時間未到為延遲工作(jobId 固定,撤回 / 改期時移除) */
  const enqueuePublish = async (id: number, publishAt: Date, requestedBy: string) => {
    const jobId = fanoutPublishJobId(id);
    await (await app.queues.notifyFanout.getJob(jobId))?.remove().catch(() => undefined);
    await app.queues.notifyFanout.add(
      'publish',
      { kind: 'publish', announcementId: id, requestedBy },
      {
        jobId,
        delay: Math.max(0, publishAt.getTime() - Date.now()),
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  };

  /* ---------------- 發布端 ---------------- */

  app.get('/api/notify/compose-options', async (req) => {
    const { p, canAll } = await publisher(req);
    // 分階段開放(LOGIN_COMPANIES):公司與部門只列開放的公司,與 GigaItApp「人員與部門」一致
    const open = await openCompanyIds(db, config.loginCompanies);
    const [facts, settings, allCompanies, depts] = await Promise.all([
      factsOf(p.userId, p.claims.emp),
      app.notifySettings.get(),
      db
        .select({ id: company.companyId, name: company.compName })
        .from(company)
        .where(and(eq(company.isEnabled, true), open ? inArray(company.companyId, open) : undefined))
        .orderBy(asc(company.companyId)),
      db
        .select({ code: department.deptCode, name: department.name, parentCode: department.parentDeptCode, companyId: department.companyId })
        .from(department)
        .where(and(eq(department.isEnabled, true), open ? inArray(department.companyId, open) : undefined))
        .orderBy(asc(department.deptCode)),
    ]);
    // 只列有部門的公司(LOS 名稱如「碩禾」在部門以 BPM 名稱「碩禾電子材料」出現)
    const companies = allCompanies.filter((c) => depts.some((d) => d.companyId === c.id));
    return {
      channels: ANNOUNCE_CHANNELS.map((c) => ({
        code: c,
        name: CHANNEL_NAMES[c],
        available: AVAILABLE_CHANNELS.includes(c),
        note: c === 'agent' ? '端點 Agent 接收上線後開放(甘特圖 W10-5);托盤顯示依 RustIt 托盤程式' : null,
      })),
      levels: LEVELS.map((code) => ({ code, name: LEVEL_NAMES[code] })),
      jobTiers: JOB_TIERS.map(({ code, name }) => ({ code, name })),
      companies,
      depts,
      canPublishAll: canAll,
      ownDepts: facts.ownDepts,
      defaults: { expireDays: settings.defaultExpireDays, level: 'info', channels: ['portal', 'itapp'] },
      maxImageBytes: settings.maxImageBytes,
      maxEmailRecipients: settings.maxEmailRecipients,
      mailRatePerSec: config.mail.ratePerSec,
    };
  });

  app.post<{ Body: { audience: Audience; channels?: string[] } }>(
    '/api/notify/announcements/preview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['audience'],
          additionalProperties: false,
          properties: { audience: audienceSchema, channels: contentProps.channels },
        },
      },
    },
    async (req) => {
      const { p, canAll } = await publisher(req);
      const { audience, errors } = normalizeAudience(req.body.audience);
      if (errors.length) throw new GwError('VALIDATION_FAILED', undefined, errors);
      const facts = await factsOf(p.userId, p.claims.emp);
      const people = await dir.expand(audience);
      const withEmail = people.filter((x) => x.email).length;
      const settings = await app.notifySettings.get();
      return {
        allowed: canAll || withinOwnDepts(audience, facts.ownDepts, await dir.deptTree()),
        targetCount: people.length,
        withEmail,
        withoutEmail: people.length - withEmail,
        emailOverLimit: (req.body.channels ?? []).includes('email') && withEmail > settings.maxEmailRecipients,
        estimatedEmailMinutes: Math.ceil(withEmail / config.mail.ratePerSec / 60),
        description: describeAudience(audience, { tiers: new Map(JOB_TIERS.map((t) => [t.code, t.name])) }),
        sample: people.slice(0, 20).map((x) => ({ employeeNo: x.employeeNo, displayName: x.displayName, department: x.department })),
      };
    },
  );

  app.post<{ Body: ContentBody & { title: string; bodyHtml: string; level: string; audience: Audience; draft?: boolean; idempotencyKey?: string } }>(
    '/api/notify/announcements',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title', 'bodyHtml', 'level', 'audience'],
          additionalProperties: false,
          properties: { ...contentProps, draft: { type: 'boolean' }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      const { p, canAll, actor } = await publisher(req);
      const b = req.body;
      const publishing = !b.draft;
      // 先檢查重送(重按「發布」時第一則已綁定圖片,不能先驗證內容);之後任何失敗都釋放此鍵
      const idemKey = b.idempotencyKey ? `gw:idem:announce:${p.claims.emp}:${b.idempotencyKey}` : null;
      if (idemKey && (await app.redis.set(idemKey, '0', 'EX', IDEM_TTL_SEC, 'NX')) === null)
        return reply.code(200).send({ code: 'DUPLICATE_REQUEST', message: '此公告已送出', requestId: req.id });

      let id: number;
      let c: Awaited<ReturnType<typeof prepare>>;
      let targetCount: number | null;
      let publishAt: Date | null;
      let status: string;
      try {
        const facts = await factsOf(p.userId, p.claims.emp);
        c = await prepare(b, { emp: p.claims.emp, canAll, ownDepts: facts.ownDepts, publishing });
        targetCount = publishing ? (await countTargets(c.audience, c.channels)).targetCount : null;
        const now = new Date();
        publishAt = publishing ? (c.publishAt && c.publishAt > now ? c.publishAt : now) : c.publishAt;
        status = !publishing ? 'draft' : publishAt! > now ? 'scheduled' : 'published';
        id = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(notifyAnnouncement)
            .output({ id: notifyAnnouncement.announcementId })
            .values({
              title: c.title,
              bodyHtml: c.bodyHtml,
              bodyText: c.bodyText,
              linkUrl: c.linkUrl,
              level: c.level,
              audience: JSON.stringify(c.audience),
              channels: JSON.stringify(c.channels),
              requireAck: c.requireAck,
              publishAt,
              expireAt: c.expireAt,
              status,
              publishedBy: publishing ? p.claims.emp : null,
              publisherTitle: c.publisherTitle,
              targetCount,
              idempotencyKey: b.idempotencyKey ?? null,
              createdBy: p.claims.emp,
              updatedBy: p.claims.emp,
            });
          if (c.assetIds.length)
            await tx
              .update(notifyAnnouncementAsset)
              .set({ announcementId: row!.id })
              .where(and(inArray(notifyAnnouncementAsset.assetId, c.assetIds), isNull(notifyAnnouncementAsset.announcementId)));
          await writeAudit(tx, actor, publishing ? 'notify.announcement.publish' : 'notify.announcement.draft', 'notify_announcement', String(row!.id), null, {
            title: c.title,
            level: c.level,
            audience: c.audience,
            channels: c.channels,
            status,
            publishAt,
            expireAt: c.expireAt,
            targetCount,
          });
          return row!.id;
        });
      } catch (err) {
        if (idemKey) await app.redis.del(idemKey).catch(() => undefined);
        throw err;
      }
      if (publishing) {
        try {
          await enqueuePublish(id, publishAt!, p.claims.emp);
        } catch (err) {
          // 入列失敗:改回草稿,讓發布人重試(不留下「已發布但沒有分送」的公告)
          req.log.error({ err: (err as Error).message, announcementId: id }, '公告入列失敗,改回草稿');
          await db.update(notifyAnnouncement).set({ status: 'draft', updatedBy: 'system:announce' }).where(eq(notifyAnnouncement.announcementId, id));
          throw new GwError('INTERNAL_ERROR', '公告已存為草稿,但分送入列失敗,請稍後再按發布');
        }
        dir.invalidateIndex();
      }
      req.log.info({ announcementId: id, status, targetCount, channels: c.channels }, '公告建立');
      return reply.code(201).send({ announcementId: id, status, targetCount, requestId: req.id });
    },
  );

  app.patch<{ Params: { id: number }; Body: ContentBody & { rowVer: string; publish?: boolean } }>(
    '/api/notify/announcements/:id',
    {
      schema: {
        params: ID_PARAMS,
        body: {
          type: 'object',
          required: ['rowVer'],
          additionalProperties: false,
          properties: { ...contentProps, rowVer: ROW_VER, publish: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const { p, canAll, actor } = await publisher(req);
      const cur = await findRow(req.params.id);
      assertOwner(cur, p.claims.emp, canAll);
      if (cur.status !== 'draft' && cur.status !== 'scheduled') throw new GwError('VALIDATION_FAILED', '已發布或撤回的公告不可修改(請撤回後重新發布)');
      const b = req.body;
      // 排程中的公告修改後仍為排程(publish: false 改回草稿)
      const publishing = b.publish ?? cur.status === 'scheduled';
      const facts = await factsOf(p.userId, p.claims.emp);
      const merged = {
        title: b.title ?? cur.title,
        bodyHtml: b.bodyHtml ?? cur.bodyHtml,
        linkUrl: b.linkUrl === undefined ? cur.linkUrl : b.linkUrl,
        level: b.level ?? cur.level,
        audience: b.audience ?? parseAudience(cur.audience),
        channels: b.channels ?? parseChannelList(cur.channels),
        requireAck: b.requireAck ?? cur.requireAck,
        publishAt: b.publishAt === undefined ? cur.publishAt?.toISOString() : b.publishAt,
        expireAt: b.expireAt === undefined ? cur.expireAt?.toISOString() : b.expireAt,
        publisherTitle: b.publisherTitle === undefined ? cur.publisherTitle : b.publisherTitle,
      };
      const c = await prepare(merged, { emp: p.claims.emp, canAll, ownDepts: facts.ownDepts, publishing, announcementId: cur.announcementId });
      const { targetCount } = publishing ? await countTargets(c.audience, c.channels) : { targetCount: null };
      const now = new Date();
      const publishAt = publishing ? (c.publishAt && c.publishAt > now ? c.publishAt : now) : c.publishAt;
      const status = !publishing ? 'draft' : publishAt! > now ? 'scheduled' : 'published';

      await db.transaction(async (tx) => {
        const rows = await tx
          .update(notifyAnnouncement)
          .set({
            title: c.title,
            bodyHtml: c.bodyHtml,
            bodyText: c.bodyText,
            linkUrl: c.linkUrl,
            level: c.level,
            audience: JSON.stringify(c.audience),
            channels: JSON.stringify(c.channels),
            requireAck: c.requireAck,
            publishAt,
            expireAt: c.expireAt,
            status,
            publishedBy: publishing ? p.claims.emp : null,
            publisherTitle: c.publisherTitle,
            targetCount,
            updatedBy: p.claims.emp,
          })
          .output({ inserted: { id: notifyAnnouncement.announcementId } })
          .where(and(eq(notifyAnnouncement.announcementId, cur.announcementId), eq(notifyAnnouncement.rowVer, verOf(b.rowVer))));
        if (!rows.length) throw new GwError('VERSION_CONFLICT');
        if (c.assetIds.length)
          await tx
            .update(notifyAnnouncementAsset)
            .set({ announcementId: cur.announcementId })
            .where(and(inArray(notifyAnnouncementAsset.assetId, c.assetIds), isNull(notifyAnnouncementAsset.announcementId)));
        const { rowVer: _r, ...before } = out(cur);
        await writeAudit(
          tx,
          actor,
          publishing ? 'notify.announcement.publish' : 'notify.announcement.update',
          'notify_announcement',
          String(cur.announcementId),
          before,
          {
            title: c.title,
            level: c.level,
            audience: c.audience,
            channels: c.channels,
            status,
            publishAt,
            expireAt: c.expireAt,
            targetCount,
          },
        );
      });
      if (publishing) await enqueuePublish(cur.announcementId, publishAt!, p.claims.emp);
      else await (await app.queues.notifyFanout.getJob(fanoutPublishJobId(cur.announcementId)))?.remove().catch(() => undefined);
      dir.invalidateIndex();
      return out(await findRow(cur.announcementId));
    },
  );

  app.get<{ Querystring: { status?: string; q?: string; mine?: boolean; page?: number; pageSize?: number } }>(
    '/api/notify/announcements',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['draft', 'scheduled', 'published', 'revoked'] },
            q: { type: 'string', maxLength: 100 },
            mine: { type: 'boolean' },
            ...PAGING,
          },
        },
      },
    },
    async (req) => {
      const { p, canAll } = await publisher(req);
      const { status, q, mine, page = 1, pageSize = 20 } = req.query;
      const conds: SQL[] = [];
      if (!canAll || mine) conds.push(eq(notifyAnnouncement.createdBy, p.claims.emp));
      if (status) conds.push(eq(notifyAnnouncement.status, status));
      if (q?.trim()) conds.push(like(notifyAnnouncement.title, `%${likeEscape(q.trim())}%`));
      const where = conds.length ? and(...conds) : undefined;
      const [[total], rows] = await Promise.all([
        db.select({ n: count() }).from(notifyAnnouncement).where(where),
        db
          .select({
            announcementId: notifyAnnouncement.announcementId,
            title: notifyAnnouncement.title,
            level: notifyAnnouncement.level,
            status: notifyAnnouncement.status,
            audience: notifyAnnouncement.audience,
            channels: notifyAnnouncement.channels,
            requireAck: notifyAnnouncement.requireAck,
            publishAt: notifyAnnouncement.publishAt,
            expireAt: notifyAnnouncement.expireAt,
            publisherTitle: notifyAnnouncement.publisherTitle,
            targetCount: notifyAnnouncement.targetCount,
            createdBy: notifyAnnouncement.createdBy,
            createdAt: notifyAnnouncement.createdAt,
            revokedAt: notifyAnnouncement.revokedAt,
          })
          .from(notifyAnnouncement)
          .where(where)
          .orderBy(desc(notifyAnnouncement.createdAt), desc(notifyAnnouncement.announcementId))
          .offset((page - 1) * pageSize)
          .fetch(pageSize),
      ]);
      const ids = rows.map((r) => r.announcementId);
      const [reads, mail] = await Promise.all([
        readCounts(db, ids),
        ids.length
          ? db
              .select({ id: notifyLog.announcementId, status: notifyLog.status, n: count() })
              .from(notifyLog)
              .where(inArray(notifyLog.announcementId, ids))
              .groupBy(notifyLog.announcementId, notifyLog.status)
          : Promise.resolve([]),
      ]);
      const mailOf = new Map<number, Record<string, number>>();
      for (const m of mail) if (m.id !== null) mailOf.set(m.id, { ...mailOf.get(m.id), [m.status]: Number(m.n) });
      return {
        total: total?.n ?? 0,
        page,
        pageSize,
        items: rows.map((r) => {
          const audience = parseAudience(r.audience);
          return {
            ...r,
            audience,
            audienceText: describeAudience(audience, { tiers: new Map(JOB_TIERS.map((t) => [t.code, t.name])) }),
            channels: parseChannelList(r.channels),
            readCount: reads.get(r.announcementId)?.read ?? 0,
            ackCount: reads.get(r.announcementId)?.ack ?? 0,
            email: mailOf.get(r.announcementId) ?? null,
          };
        }),
      };
    },
  );

  app.get<{
    Params: { id: number };
    Querystring: { state?: 'read' | 'unread' | 'all'; q?: string; format?: 'json' | 'csv'; page?: number; pageSize?: number };
  }>(
    '/api/notify/announcements/:id/receipts',
    {
      schema: {
        params: ID_PARAMS,
        querystring: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: ['read', 'unread', 'all'], default: 'all' },
            q: { type: 'string', maxLength: 50 },
            format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
            page: PAGING.page,
            pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req, reply) => {
      const { p, canAll } = await publisher(req);
      const cur = await findRow(req.params.id);
      assertOwner(cur, p.claims.emp, canAll);
      const { state = 'all', q, format = 'json', page = 1, pageSize = 50 } = req.query;
      const [people, receipts] = await Promise.all([dir.expand(parseAudience(cur.audience)), receiptsFor(db, cur.announcementId)]);
      const rc = new Map(receipts.map((r) => [r.userId, r]));
      let rows = people.map((x) => {
        const r = rc.get(x.userId);
        return {
          employeeNo: x.employeeNo,
          displayName: x.displayName,
          department: x.department,
          email: x.email,
          readAt: r?.readAt ?? null,
          ackAt: r?.ackAt ?? null,
          seenVia: r?.seenVia ?? null,
        };
      });
      const readCount = rows.filter((r) => r.readAt).length;
      const ackCount = rows.filter((r) => r.ackAt).length;
      if (state === 'read') rows = rows.filter((r) => r.readAt);
      if (state === 'unread') rows = rows.filter((r) => !r.readAt);
      const kw = q?.trim().toLowerCase();
      if (kw) rows = rows.filter((r) => [r.employeeNo, r.displayName, r.department ?? ''].some((v) => v.toLowerCase().includes(kw)));
      rows.sort((a, b) => (a.department ?? '').localeCompare(b.department ?? '') || a.employeeNo.localeCompare(b.employeeNo));
      if (format === 'csv') {
        const head = ['工號', '姓名', '部門', 'Email', '已讀時間', '確認時間', '管道'];
        const body = rows.map((r) => [r.employeeNo, r.displayName, r.department, r.email, r.readAt, r.ackAt, r.seenVia].map(csvCell).join(','));
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="announcement-${cur.announcementId}-${state}.csv"`)
          .send([String.fromCharCode(0xfeff) + head.join(','), ...body, ''].join('\r\n'));
      }
      return {
        targetCount: people.length,
        snapshotCount: cur.targetCount,
        readCount,
        ackCount,
        total: rows.length,
        page,
        pageSize,
        items: rows.slice((page - 1) * pageSize, page * pageSize),
      };
    },
  );

  app.post<{ Params: { id: number } }>('/api/notify/announcements/:id/revoke', { schema: { params: ID_PARAMS } }, async (req) => {
    const { p, canAll, actor } = await publisher(req);
    const cur = await findRow(req.params.id);
    assertOwner(cur, p.claims.emp, canAll);
    if (cur.status !== 'published' && cur.status !== 'scheduled') throw new GwError('VALIDATION_FAILED', '只有已發布或排程中的公告可以撤回');
    await db.transaction(async (tx) => {
      await tx
        .update(notifyAnnouncement)
        .set({ status: 'revoked', revokedAt: new Date(), revokedBy: p.claims.emp, updatedBy: p.claims.emp })
        .where(eq(notifyAnnouncement.announcementId, cur.announcementId));
      await writeAudit(
        tx,
        actor,
        'notify.announcement.revoke',
        'notify_announcement',
        String(cur.announcementId),
        { status: cur.status },
        { status: 'revoked' },
      );
    });
    await (await app.queues.notifyFanout.getJob(fanoutPublishJobId(cur.announcementId)))?.remove().catch(() => undefined);
    if (cur.status === 'published')
      await app.queues.notifyFanout.add(
        'revoke',
        { kind: 'revoke', announcementId: cur.announcementId, requestedBy: p.claims.emp },
        { attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100 },
      );
    dir.invalidateIndex();
    return { announcementId: cur.announcementId, status: 'revoked' };
  });

  app.post<{ Params: { id: number } }>('/api/notify/announcements/:id/remind', { schema: { params: ID_PARAMS } }, async (req, reply) => {
    const { p, canAll, actor } = await publisher(req);
    const cur = await findRow(req.params.id);
    assertOwner(cur, p.claims.emp, canAll);
    if (cur.status !== 'published') throw new GwError('VALIDATION_FAILED', '只有已發布的公告可以提醒');
    if (!parseChannelList(cur.channels).includes('email')) throw new GwError('VALIDATION_FAILED', '此公告沒有 Email 管道,無法重寄');
    if ((await app.redis.set(`gw:announce:remind:${cur.announcementId}`, p.claims.emp, 'EX', REMIND_LOCK_SEC, 'NX')) === null)
      throw new GwError('RATE_LIMITED', '同一則公告 10 分鐘內只能提醒一次');
    await app.queues.notifyFanout.add(
      'remind',
      { kind: 'remind', announcementId: cur.announcementId, requestedBy: p.claims.emp },
      { attempts: 3, removeOnComplete: 100 },
    );
    await db.transaction((tx) => writeAudit(tx, actor, 'notify.announcement.remind', 'notify_announcement', String(cur.announcementId), null, null));
    return reply.code(202).send({ queued: true, requestId: req.id });
  });

  app.post('/api/notify/assets', async (req, reply) => {
    const { p } = await publisher(req);
    if (!req.isMultipart()) throw new GwError('VALIDATION_FAILED', '需以 multipart/form-data 上傳(欄位 file)');
    let file: { name: string; buf: Buffer } | null = null;
    try {
      for await (const part of req.parts()) if (part.type === 'file' && part.fieldname === 'file') file = { name: part.filename, buf: await part.toBuffer() };
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new GwError('PAYLOAD_TOO_LARGE', `圖片超過 ${MAX_UPLOAD / 1024 / 1024} MB`);
      throw err;
    }
    if (!file) throw new GwError('VALIDATION_FAILED', undefined, [{ field: 'file', message: '必填' }]);
    const max = (await app.notifySettings.get()).maxImageBytes;
    if (file.buf.length > max) throw new GwError('PAYLOAD_TOO_LARGE', `圖片超過 ${(max / 1024 / 1024).toFixed(1)} MB`);
    const contentType = sniffImage(file.buf);
    if (!contentType) throw new GwError('VALIDATION_FAILED', '只接受 PNG、JPEG、GIF、WebP 圖片', [{ field: 'file', message: file.name }]);
    const [row] = await db
      .insert(notifyAnnouncementAsset)
      .output({ id: notifyAnnouncementAsset.assetId })
      .values({ contentType, fileName: file.name.slice(0, 200), sizeBytes: file.buf.length, data: file.buf, createdBy: p.claims.emp });
    return reply.code(201).send({ assetId: row!.id, url: `${ASSET_PATH}${row!.id}`, contentType, sizeBytes: file.buf.length });
  });

  /* ---------------- 收件端 ---------------- */

  app.get<{ Params: { id: number } }>('/api/notify/assets/:id', { schema: { params: ID_PARAMS } }, async (req, reply) => {
    const p = await req.requirePrincipal();
    const [a] = await db
      .select({
        contentType: notifyAnnouncementAsset.contentType,
        data: notifyAnnouncementAsset.data,
        announcementId: notifyAnnouncementAsset.announcementId,
        createdBy: notifyAnnouncementAsset.createdBy,
      })
      .from(notifyAnnouncementAsset)
      .where(eq(notifyAnnouncementAsset.assetId, req.params.id));
    // 尚未綁定公告的圖片(草稿)只有上傳者看得到
    if (!a || (a.announcementId === null && a.createdBy !== p.claims.emp))
      throw new GwError('VALIDATION_FAILED', '圖片不存在', [{ field: 'id', message: String(req.params.id) }]);
    return reply
      .type(a.contentType)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .send(a.data);
  });

  /** 收件匣項目(公告) */
  const annItem = (e: IndexEntry, rc: Map<number, { readAt: Date | null; ackAt: Date | null }>, now: Date) => ({
    kind: 'announcement' as const,
    id: e.id,
    title: e.title,
    summary: summaryOf(e.summary),
    level: e.level,
    requireAck: e.requireAck,
    publisherTitle: e.publisherTitle,
    linkUrl: e.linkUrl,
    at: e.publishAt,
    expireAt: e.expireAt,
    isExpired: !!e.expireAt && e.expireAt <= now,
    isRead: !!rc.get(e.id)?.readAt,
    ackAt: rc.get(e.id)?.ackAt ?? null,
  });

  app.get<{ Querystring: { app?: string; unread?: boolean; page?: number; pageSize?: number } }>(
    '/api/notify/feed',
    { schema: { querystring: { type: 'object', properties: { app: { type: 'string', enum: ['portal', 'itapp'] }, unread: { type: 'boolean' }, ...PAGING } } } },
    async (req) => {
      const p = await req.requirePrincipal();
      const { unread, page = 1, pageSize = 20 } = req.query;
      const now = new Date();
      const facts = await factsOf(p.userId, p.claims.emp);
      const [anns, rc] = await Promise.all([dir.visibleTo(facts, { app: inboxAppOf(req.query.app), includeExpired: false, now }), receiptsOf(db, p.userId)]);
      let annItems = anns.map((e) => annItem(e, rc, now));
      const annUnread = annItems.filter((i) => !i.isRead).length;
      if (unread) annItems = annItems.filter((i) => !i.isRead);
      const msgWhere = and(eq(notifyMessage.userId, p.userId), unread ? eq(notifyMessage.isRead, false) : undefined);
      const [[msgTotal], [msgUnread], msgs] = await Promise.all([
        db.select({ n: count() }).from(notifyMessage).where(msgWhere),
        db
          .select({ n: count() })
          .from(notifyMessage)
          .where(and(eq(notifyMessage.userId, p.userId), eq(notifyMessage.isRead, false))),
        db
          .select({
            id: notifyMessage.messageId,
            title: notifyMessage.title,
            body: notifyMessage.body,
            linkUrl: notifyMessage.linkUrl,
            isRead: notifyMessage.isRead,
            at: notifyMessage.createdAt,
          })
          .top(page * pageSize)
          .from(notifyMessage)
          .where(msgWhere)
          .orderBy(desc(notifyMessage.createdAt), desc(notifyMessage.messageId)),
      ]);
      const msgItems = msgs.map((m) => ({ kind: 'message' as const, ...m, summary: summaryOf(m.body ?? ''), level: 'info' }));
      const merged = [...annItems, ...msgItems].sort((a, b) => b.at.getTime() - a.at.getTime());
      return {
        total: annItems.length + (msgTotal?.n ?? 0),
        unread: annUnread + (msgUnread?.n ?? 0),
        page,
        pageSize,
        items: merged.slice((page - 1) * pageSize, page * pageSize),
      };
    },
  );

  app.get<{ Querystring: { q?: string; from?: string; to?: string; level?: string; page?: number; pageSize?: number } }>(
    '/api/notify/archive',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 100 },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            level: { type: 'string', enum: [...LEVELS] },
            ...PAGING,
          },
        },
      },
    },
    async (req) => {
      const p = await req.requirePrincipal();
      const { q, from, to, level, page = 1, pageSize = 20 } = req.query;
      const now = new Date();
      const settings = await app.notifySettings.get();
      const includeExpired = settings.archiveShowsExpired || (await app.perms.has(p.userId, p.claims.pv, PUBLISH_ALL));
      const facts = await factsOf(p.userId, p.claims.emp);
      let list = await dir.visibleTo(facts, { includeExpired, now });
      if (level) list = list.filter((e) => e.level === level);
      if (from) list = list.filter((e) => e.publishAt >= new Date(from));
      if (to) list = list.filter((e) => e.publishAt < new Date(to));
      const kw = q?.trim();
      if (kw && list.length) {
        const pattern = `%${likeEscape(kw)}%`;
        const hit = new Set(
          (
            await db
              .select({ id: notifyAnnouncement.announcementId })
              .from(notifyAnnouncement)
              .where(and(eq(notifyAnnouncement.status, 'published'), or(like(notifyAnnouncement.title, pattern), like(notifyAnnouncement.bodyText, pattern))))
          ).map((r) => r.id),
        );
        list = list.filter((e) => hit.has(e.id));
      }
      const rc = await receiptsOf(db, p.userId);
      return { total: list.length, page, pageSize, items: list.slice((page - 1) * pageSize, page * pageSize).map((e) => annItem(e, rc, now)) };
    },
  );

  /** 收件人可見:已發布、在對象內、(到期後依設定) */
  const assertVisible = async (r: Row, p: { userId: number; claims: { emp: string; pv: number } }) => {
    const owner = r.createdBy === p.claims.emp || (await app.perms.has(p.userId, p.claims.pv, PUBLISH_ALL));
    if (owner) return { owner: true };
    const settings = await app.notifySettings.get();
    const expired = !!r.expireAt && r.expireAt <= new Date();
    const visible =
      r.status === 'published' &&
      !!r.publishAt &&
      r.publishAt <= new Date() &&
      (!expired || settings.archiveShowsExpired) &&
      (await dir.matches(parseAudience(r.audience), await factsOf(p.userId, p.claims.emp)));
    if (!visible) throw new GwError('VALIDATION_FAILED', '公告不存在', [{ field: 'id', message: String(r.announcementId) }]);
    return { owner: false };
  };

  app.get<{ Params: { id: number } }>('/api/notify/announcements/:id', { schema: { params: ID_PARAMS } }, async (req) => {
    const p = await req.requirePrincipal();
    const r = await findRow(req.params.id);
    const { owner } = await assertVisible(r, p);
    const mine = (await receiptsOf(db, p.userId)).get(r.announcementId) ?? null;
    if (owner)
      return {
        ...out(r),
        myReceipt: mine,
        audienceText: describeAudience(parseAudience(r.audience), { tiers: new Map(JOB_TIERS.map((t) => [t.code, t.name])) }),
      };
    // 收件人只看內容,不看對象與管理欄位
    return {
      announcementId: r.announcementId,
      title: r.title,
      bodyHtml: r.bodyHtml,
      linkUrl: r.linkUrl,
      level: r.level,
      requireAck: r.requireAck,
      publisherTitle: r.publisherTitle,
      publishAt: r.publishAt,
      expireAt: r.expireAt,
      myReceipt: mine,
    };
  });

  const readBody = { type: 'object', additionalProperties: false, properties: { via: { type: 'string', enum: ['portal', 'itapp', 'agent', 'email'] } } };

  app.post<{ Params: { id: number }; Body: { via?: string } }>(
    '/api/notify/announcements/:id/read',
    { schema: { params: ID_PARAMS, body: readBody } },
    async (req) => {
      const p = await req.requirePrincipal();
      const r = await findRow(req.params.id);
      await assertVisible(r, p);
      return { announcementId: r.announcementId, ...(await markRead(db, r.announcementId, p.userId, req.body?.via ?? 'portal', false)) };
    },
  );

  app.post<{ Params: { id: number }; Body: { via?: string } }>(
    '/api/notify/announcements/:id/ack',
    { schema: { params: ID_PARAMS, body: readBody } },
    async (req) => {
      const p = await req.requirePrincipal();
      const r = await findRow(req.params.id);
      await assertVisible(r, p);
      return { announcementId: r.announcementId, ...(await markRead(db, r.announcementId, p.userId, req.body?.via ?? 'portal', true)) };
    },
  );
};

export default announceRoutes;
