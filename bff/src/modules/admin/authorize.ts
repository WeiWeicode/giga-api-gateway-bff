/**
 * 管理 API 的授權(PRD §8.7):API Key(系統帳號)或登入者(GigaItApp 以使用者本人登入呼叫)。
 * 回傳寫入稽核用的操作人:API Key 為 `client:{代碼}`,使用者為工號。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GwError } from '../../errors.js';
import { ApiKeyService } from '../auth/api-key.js';

export interface Actor {
  name: string;
  userId: number | null;
}

export function createAuthorizer(app: FastifyInstance) {
  const apiKeys = new ApiKeyService(app.db, app.redis, app.log);
  return async function authorize(req: FastifyRequest, perm: string): Promise<Actor> {
    const key = req.headers['x-api-key'];
    if (typeof key === 'string' && key) {
      const c = await apiKeys.verify(key, req.ip);
      if (!c.permissions.has(perm)) throw new GwError('PERMISSION_DENIED');
      return { name: `client:${c.code}`, userId: null };
    }
    const p = await req.requirePrincipal();
    if (!(await app.perms.has(p.userId, p.claims.pv, perm))) throw new GwError('PERMISSION_DENIED');
    return { name: p.claims.emp, userId: p.userId };
  };
}
