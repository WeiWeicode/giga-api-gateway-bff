/** IT 管理介面 demo:資料庫檢視 API(唯讀,dev / test 限定) */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetch } from 'undici';
import { agent, clearLoginFails, closeAll, login } from './gw.js';

beforeAll(async () => {
  for (const e of ['S100001', 'S112009']) await clearLoginFails(e);
});
afterAll(closeAll);

describe('資料庫檢視 /api/admin/db', () => {
  it('IT 管理員可列出資料表與筆數', async () => {
    const { s } = await login('S100001');
    const res = await s.get('/api/admin/db/tables');
    expect(res.status).toBe(200);
    const names = res.json.items.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['user', 'api_route', 'audit_log', 'local_credential']));
  });

  it('分頁查詢,且不回傳密碼與 Token 雜湊欄位', async () => {
    const { s } = await login('S100001');
    const cred = await s.get('/api/admin/db/tables/local_credential?pageSize=5');
    expect(cred.status).toBe(200);
    expect(cred.json.columns).not.toContain('password_hash');
    expect(cred.json.columns).not.toContain('password_history');
    const token = await s.get('/api/admin/db/tables/local_account_token');
    expect(token.json.columns).not.toContain('token_hash');
    const routes = await s.get('/api/admin/db/tables/api_route?page=2&pageSize=3');
    expect(routes.json).toMatchObject({ page: 2, pageSize: 3 });
    expect(routes.json.items).toHaveLength(3);
    expect(routes.json.total).toBeGreaterThan(6);
  });

  it('沒有 gw.admin.*.read 權限者 403;不存在的資料表 404;pageSize 上限 100', async () => {
    const { s } = await login('S112009');
    expect((await s.get('/api/admin/db/tables')).json.code).toBe('PERMISSION_DENIED');
    expect((await s.get('/api/admin/db/tables/user')).status).toBe(403);
    const admin = (await login('S100001')).s;
    expect((await admin.get('/api/admin/db/tables/sysobjects')).status).toBe(404);
    expect((await admin.get('/api/admin/db/tables/user?pageSize=500')).json.code).toBe('VALIDATION_FAILED');
  });

  it('IT 管理介面 SPA 以 /it/ 子路徑提供', async () => {
    const res = await fetch('https://localhost/it/tables/user', { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('GigaNexus IT 管理');
  });
});
