/**
 * POST /api/notify/send(PRD §8.5、W3-5.8):其他系統以 X-Api-Key,或登入者,需權限 notify.message.send。
 * 只入列,回 202;相同 idempotencyKey 24 小時內回 200 DUPLICATE_REQUEST。
 */
import type { FastifyPluginAsync } from 'fastify';
import { GwError } from '../../errors.js';
import { ApiKeyService } from '../auth/api-key.js';
import type { SendInput } from './send.js';

const PERMISSION = 'notify.message.send';
const strList = (max: number, maxLength: number) => ({ type: 'array', maxItems: max, items: { type: 'string', minLength: 1, maxLength } });

const notifyRoutes: FastifyPluginAsync = async (app) => {
  const apiKeys = new ApiKeyService(app.db, app.redis, app.log);

  app.post<{ Body: Omit<SendInput, 'requestedBy'> }>(
    '/api/notify/send',
    {
      schema: {
        body: {
          type: 'object',
          required: ['templateCode', 'to'],
          additionalProperties: false,
          properties: {
            templateCode: { type: 'string', minLength: 1, maxLength: 50 },
            channels: strList(5, 20),
            to: {
              type: 'object',
              additionalProperties: false,
              properties: { users: strList(1000, 20), adGroups: strList(20, 300), emails: strList(100, 200) },
            },
            data: { type: 'object' },
            priority: { type: 'string', enum: ['high', 'normal', 'low'] },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      let requestedBy: string;
      const key = req.headers['x-api-key'];
      if (typeof key === 'string' && key) {
        const c = await apiKeys.verify(key, req.ip);
        if (!c.permissions.has(PERMISSION)) throw new GwError('PERMISSION_DENIED');
        requestedBy = `client:${c.code}`;
      } else {
        const p = await req.requirePrincipal();
        if (!(await app.perms.has(p.userId, p.claims.pv, PERMISSION))) throw new GwError('PERMISSION_DENIED');
        requestedBy = p.claims.emp;
      }
      const r = await app.notifier.send({ ...req.body, requestedBy });
      if (r.duplicate) return reply.code(200).send({ code: 'DUPLICATE_REQUEST', message: '此通知已送出', requestId: req.id });
      req.log.info({ templateCode: req.body.templateCode, requestedBy, queued: r.queued, skipped: r.skipped }, '通知入列');
      return reply.code(202).send({ queued: r.queued, skipped: r.skipped, requestId: req.id });
    },
  );
};

export default notifyRoutes;
