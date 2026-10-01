/**
 * Webhook 接收 POST /webhook/{source}(PRD §8.6、W3-5.10)。
 *
 *   來源 IP 白名單(Nginx,PRD §7.5)→ 驗簽 → 時間戳 ±5 分鐘 → 去重(Redis gw:idem:webhook:{source}:{key},24h)
 *   → 記錄 gw.webhook_log → 入列(BullMQ webhook)→ 立即回 200;處理在 worker(src/workers/webhook.worker.ts)。
 *
 * 簽章格式見 signature.ts 與 BACKEND-GUIDE.md §7.6。本階段只支援 dispatch_type = queue。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { webhookEndpoint, webhookLog } from '../../db/schema/index.js';
import { GwError } from '../../errors.js';
import { DEFAULT_SIGNATURE_HEADER, IDEMPOTENCY_HEADER, TIMESTAMP_HEADER, timestampValid, verifySignature } from './signature.js';

const BODY_LIMIT = 1024 * 1024;
const IDEM_TTL_SEC = 24 * 60 * 60;
const SOURCE_PATTERN = /^[a-z0-9_-]{1,30}$/;
const KEY_PATTERN = /^[\x21-\x7e]{1,100}$/;
const SECRET_REF_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

const webhookRoutes: FastifyPluginAsync<{ config: AppConfig }> = async (app, { config }) => {
  // 驗簽需要原始 body:本封裝範圍內所有 content-type 都以 Buffer 接收,不解析 JSON
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));

  async function readSecretFile(ref: string): Promise<string> {
    if (!SECRET_REF_PATTERN.test(ref)) throw new Error(`secret_ref 格式錯誤:${ref}`);
    return (await readFile(join(config.webhookSecretsDir, ref), 'utf8')).replace(/\r?\n$/, '');
  }

  app.post<{ Params: { source: string } }>('/webhook/:source', async (req, reply) => {
    const source = req.params.source;
    const [ep] = SOURCE_PATTERN.test(source)
      ? await app.db
          .select()
          .from(webhookEndpoint)
          .where(and(eq(webhookEndpoint.sourceCode, source), eq(webhookEndpoint.isEnabled, true)))
      : [];
    if (!ep) throw new GwError('WEBHOOK_SOURCE_NOT_FOUND');

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const payload = body.toString('utf8');
    const idemKey = header(req, IDEMPOTENCY_HEADER);
    const log = (verified: boolean, statusCode: number, errorMessage: string | null) =>
      app.db
        .insert(webhookLog)
        .output({ id: webhookLog.logId })
        .values({
          endpointId: ep.endpointId,
          requestId: req.id,
          idempotencyKey: idemKey && KEY_PATTERN.test(idemKey) ? idemKey : null,
          remoteIp: req.ip,
          verified,
          statusCode,
          payload,
          errorMessage,
        });
    const reject = async (code: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_TIMESTAMP_INVALID' | 'VALIDATION_FAILED', status: number, msg: string) => {
      await log(false, status, msg);
      req.log.warn({ source, code, remoteIp: req.ip }, 'Webhook 拒絕');
      throw new GwError(code, code === 'VALIDATION_FAILED' ? msg : undefined);
    };

    if (ep.verifyMethod === 'hmac_sha256') {
      let secret: string;
      try {
        secret = await readSecretFile(ep.secretRef ?? '');
      } catch (err) {
        // 設定錯誤:回 500 讓來源稍後重送;不可略過驗簽
        req.log.error({ source, err: (err as Error).message }, 'Webhook 密鑰讀取失敗');
        await log(false, 500, '密鑰讀取失敗');
        throw new GwError('INTERNAL_ERROR');
      }
      const ts = header(req, TIMESTAMP_HEADER) ?? '';
      const sigHeader = (ep.signatureHeader ?? DEFAULT_SIGNATURE_HEADER).toLowerCase();
      if (!verifySignature(secret, ts, body, header(req, sigHeader))) await reject('WEBHOOK_SIGNATURE_INVALID', 401, '簽章不符');
      if (!timestampValid(ts)) await reject('WEBHOOK_TIMESTAMP_INVALID', 401, `時間戳超出範圍:${ts}`);
    } else if (ep.verifyMethod !== 'none') {
      req.log.error({ source, verifyMethod: ep.verifyMethod }, 'Webhook 驗簽方式不支援');
      await log(false, 500, `不支援的驗簽方式:${ep.verifyMethod}`);
      throw new GwError('INTERNAL_ERROR');
    }

    if (!idemKey || !KEY_PATTERN.test(idemKey)) await reject('VALIDATION_FAILED', 400, '缺少或格式錯誤的 Idempotency-Key(1–100 個可見 ASCII 字元)');
    const key = idemKey!;
    if (ep.dispatchType !== 'queue' || !ep.dispatchTarget) {
      req.log.error({ source, dispatchType: ep.dispatchType }, 'Webhook 分派方式不支援');
      await log(true, 500, `不支援的分派方式:${ep.dispatchType}`);
      throw new GwError('INTERNAL_ERROR');
    }

    // 去重:先佔用鍵,後續失敗時釋放,讓來源重送
    const idemRedisKey = `gw:idem:webhook:${source}:${key}`;
    let first: string | null;
    try {
      first = await app.redis.set(idemRedisKey, req.id, 'EX', IDEM_TTL_SEC, 'NX');
    } catch (err) {
      // Redis 不可用時無法去重也無法入列:回 500 由來源重送,不可直接處理
      req.log.error({ source, err: (err as Error).message }, 'Webhook 去重失敗(Redis)');
      await log(true, 500, 'Redis 不可用');
      throw new GwError('INTERNAL_ERROR');
    }
    if (first === null) {
      await log(true, 200, 'DUPLICATE_REQUEST');
      return reply.code(200).send({ code: 'DUPLICATE_REQUEST', message: '此事件已處理', requestId: req.id });
    }
    let logId: number | undefined;
    try {
      [{ id: logId }] = (await log(true, 200, null)) as [{ id: number }];
      await app.queues.webhook.add(
        source,
        { logId, source, target: ep.dispatchTarget, idempotencyKey: key, payload },
        { jobId: `wh-${logId}`, attempts: 5, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: { age: IDEM_TTL_SEC }, removeOnFail: false },
      );
      return { received: true, logId, requestId: req.id };
    } catch (err) {
      req.log.error({ source, err: (err as Error).message }, 'Webhook 入列失敗');
      await app.redis.del(idemRedisKey).catch(() => undefined);
      if (logId !== undefined)
        await app.db
          .update(webhookLog)
          .set({ statusCode: 500, errorMessage: '入列失敗' })
          .where(eq(webhookLog.logId, logId))
          .catch(() => undefined);
      throw new GwError('INTERNAL_ERROR');
    }
  });
};

export default webhookRoutes;
