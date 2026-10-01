/**
 * 管理 API 的授權(PRD §8.7):API Key(系統帳號)或登入者(GigaItApp 以使用者本人登入呼叫)。
 * 回傳寫入稽核用的操作人:API Key 為 `client:{代碼}`,使用者為工號;並帶上來源 IP 與 requestId。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GwError } from '../../errors.js';
import { ApiKeyService } from '../auth/api-key.js';
import type { AuditActor } from './audit-log.js';

export interface Actor extends AuditActor {
  name: string;
  userId: number | null;
  /** 操作人的全部權限(防止授予自己沒有的權限時使用) */
  permissions: () => Promise<Set<string>>;
}

export function createAuthorizer(app: FastifyInstance) {
  const apiKeys = new ApiKeyService(app.db, app.redis, app.log);
  return async function authorize(req: FastifyRequest, perm: string): Promise<Actor> {
    const key = req.headers['x-api-key'];
    if (typeof key === 'string' && key) {
      const c = await apiKeys.verify(key, req.ip);
      if (!c.permissions.has(perm)) throw new GwError('PERMISSION_DENIED');
      return { name: `client:${c.code}`, userId: null, ip: req.ip, requestId: req.id, permissions: async () => c.permissions };
    }
    const p = await req.requirePrincipal();
    if (!(await app.perms.has(p.userId, p.claims.pv, perm))) throw new GwError('PERMISSION_DENIED');
    return {
      name: p.claims.emp,
      userId: p.userId,
      ip: req.ip,
      requestId: req.id,
      permissions: async () => new Set(await app.perms.list(p.userId, p.claims.pv)),
    };
  };
}
