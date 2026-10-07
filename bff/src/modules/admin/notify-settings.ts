/**
 * 通知設定 API(NOTIFY-PLAN §6.9、GigaItApp 通知中心「設定」Tab):
 *
 *   GET /api/admin/notify/settings                         目前設定、預設值、Email 寄送速率(唯讀)    gw.admin.notify.read
 *   PUT /api/admin/notify/settings                         修改(只送要改的鍵;null = 恢復預設)       notify.settings.write(超級管理員)
 *   GET /api/admin/notify/settings/retention-preview?years= 設定保留年數後會被刪除的公告數            gw.admin.notify.read
 *
 * 寫入與 gw.audit_log 同一交易;BFF 各實例的設定快取 60 秒後生效。
 */
import { and, count, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../../config.js';
import { notifyAnnouncement, notifySetting } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { DEFAULT_SETTINGS, SETTING_RULES, isSettingKey, retentionCutoff, validateSetting, type NotifySettings } from '../notify/settings.js';
import { writeAudit } from './audit-log.js';
import { createAuthorizer } from './authorize.js';

const READ = 'gw.admin.notify.read';
const WRITE = 'notify.settings.write';

const notifySettingsAdmin: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  const authorize = createAuthorizer(app);

  const current = async () => {
    app.notifySettings.invalidate();
    return app.notifySettings.get();
  };

  app.get('/api/admin/notify/settings', async (req) => {
    await authorize(req, READ);
    return { settings: await current(), defaults: DEFAULT_SETTINGS, readonly: { mailRatePerSec: config.mail.ratePerSec } };
  });

  app.put<{ Body: { changes: Record<string, unknown> } }>(
    '/api/admin/notify/settings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['changes'],
          additionalProperties: false,
          properties: { changes: { type: 'object', minProperties: 1, maxProperties: Object.keys(SETTING_RULES).length } },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, WRITE);
      const errors: { field: string; message: string }[] = [];
      const changes = Object.entries(req.body.changes);
      for (const [k, v] of changes) {
        if (!isSettingKey(k)) errors.push({ field: k, message: '未知的設定' });
        else if (v !== null || !SETTING_RULES[k].nullable) {
          // null:可為空的設定 = 設為空值(例 保留期限 = 永久);其餘的 null = 恢復預設
          const msg = v === null ? null : validateSetting(k, v);
          if (msg) errors.push({ field: k, message: msg });
        }
      }
      if (errors.length) throw new GwError('VALIDATION_FAILED', undefined, errors);
      const before = await current();
      await app.db.transaction(async (tx) => {
        const keys = changes.map(([k]) => k);
        const existing = new Set(
          (await tx.select({ k: notifySetting.settingKey }).from(notifySetting).where(inArray(notifySetting.settingKey, keys))).map((r) => r.k),
        );
        for (const [k, v] of changes) {
          const key = k as keyof NotifySettings;
          // 不可為空的設定送 null:刪除該鍵,回到預設值
          if (v === null && !SETTING_RULES[key].nullable) {
            await tx.delete(notifySetting).where(eq(notifySetting.settingKey, key));
            continue;
          }
          const value = JSON.stringify(v);
          if (existing.has(key)) await tx.update(notifySetting).set({ settingValue: value, updatedBy: actor.name }).where(eq(notifySetting.settingKey, key));
          else await tx.insert(notifySetting).values({ settingKey: key, settingValue: value, createdBy: actor.name, updatedBy: actor.name });
        }
        await writeAudit(
          tx,
          actor,
          'notify.settings.update',
          'notify_setting',
          keys.join(',').slice(0, 100),
          Object.fromEntries(keys.map((k) => [k, before[k as keyof NotifySettings]])),
          req.body.changes,
        );
      });
      return { settings: await current() };
    },
  );

  app.get<{ Querystring: { years: number } }>(
    '/api/admin/notify/settings/retention-preview',
    { schema: { querystring: { type: 'object', required: ['years'], properties: { years: { type: 'integer', minimum: 1, maximum: 100 } } } } },
    async (req) => {
      await authorize(req, READ);
      const cutoff = retentionCutoff(req.query.years);
      const [row] = await app.db
        .select({ n: count() })
        .from(notifyAnnouncement)
        .where(and(inArray(notifyAnnouncement.status, ['published', 'revoked']), lt(notifyAnnouncement.publishAt, cutoff)));
      return { years: req.query.years, cutoff, announcements: row?.n ?? 0 };
    },
  );
};

export default notifySettingsAdmin;
