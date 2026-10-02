/**
 * 第二階段管理 API 與補強項目(2026-10-02):/metrics、/docs、角色 / 權限 / AD 群組(P2-3)、API Key 與 api_key 路由(P2-5)、
 * 路由試打(P2-1)、存取反查(P2-6)、匯入(P2-4)、通知範本 / 紀錄與稽核查詢(P2-7)、人員同步紀錄(W3-4.6b)、站內通知收件匣。
 * 假工號 Z99E2E 開頭、角色 / API Key / 上游 e2e- 開頭、權限 e2ez.、範本 E2E_、匯入檔名 e2e-,結束時刪除。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiKeyCall,
  BASE,
  bffInternal,
  cleanupE2E,
  cli,
  cliApply,
  closeAll,
  createApiKey,
  createLocalUser,
  EMP_PREFIX,
  login,
  query,
  Session,
  waitFor,
} from './gw.js';

const EMP = `${EMP_PREFIX}P1`;
const KEY_ROUTE = '/api/e2ez/p2-key';
const MOCK_ROUTE = '/api/e2ez/p2-mock';
let adminKey = '';
let admin: ReturnType<typeof apiKeyCall>;
let userId = 0;

/** multipart 上傳(以 API Key) */
async function upload(fileName: string, content: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([content]), fileName);
  const res = await fetch(`${BASE}/api/admin/imports`, { method: 'POST', headers: { 'x-api-key': adminKey }, body: form });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  await cleanupE2E();
  // 發佈會一併發佈所有草稿:有其他人的草稿時停止,不替別人發佈
  const [d] = await query("SELECT COUNT(*) AS n FROM gw.api_route WHERE status = 'draft' AND route_code NOT LIKE 'e2ez.%'");
  if (d.n > 0) throw new Error(`測試區有 ${d.n} 筆其他草稿,為避免一併發佈,請先處理`);
  await cliApply(
    [
      'permissions:',
      '  - { code: e2ez.p2.read, name: E2E P2 權限 }',
      '  - { code: e2ez.p2.other, name: E2E P2 其他權限 }',
      'notifyTemplates:',
      '  - code: E2E_P2_INAPP',
      '    name: E2E 站內通知',
      '    channels: [inapp]',
      '    emailSubject: E2E {{n}}',
      '    inappBody: 第 {{n}} 則',
      'routes:',
      '  - routeCode: e2ez.p2.key',
      '    name: E2E api_key 路由',
      '    systemCode: e2ez',
      '    method: GET',
      `    publicPath: ${KEY_ROUTE}`,
      '    routeType: mock',
      '    authMode: api_key',
      '    permissionCode: e2ez.p2.read',
      '    mockResponse: { system: true }',
      '  - routeCode: e2ez.p2.mock',
      '    name: E2E 試打路由',
      '    systemCode: e2ez',
      '    method: GET',
      `    publicPath: ${MOCK_ROUTE}`,
      '    routeType: mock',
      '    authMode: authenticated',
      '    mockResponse: { pong: true }',
    ].join('\n'),
  );
  await cli('publish', '--note', 'E2E P2 測試(測試結束後移除)');
  adminKey = await createApiKey('e2e-p2-admin', [
    'gw.admin.rbac.read',
    'gw.admin.rbac.write',
    'gw.admin.client.read',
    'gw.admin.client.write',
    'gw.admin.route.read',
    'gw.admin.route.write',
    'gw.admin.route.import',
    'gw.admin.user.read',
    'gw.admin.user.write',
    'gw.admin.user.sync',
    'gw.admin.notify.read',
    'gw.admin.notify.write',
    'gw.admin.audit.read',
    'notify.message.send',
    'e2ez.p2.read',
  ]);
  admin = apiKeyCall(adminKey);
  userId = await createLocalUser(EMP);
});

afterAll(async () => {
  await query("DELETE i FROM gw.api_import_item i JOIN gw.api_import_batch b ON b.batch_id = i.batch_id WHERE b.file_name LIKE 'e2e-%'");
  await query("DELETE FROM gw.api_import_batch WHERE file_name LIKE 'e2e-%'");
  await query("DELETE FROM gw.api_route WHERE route_code LIKE 'e2ez.%'");
  await cli('publish', '--note', 'E2E P2 測試移除');
  await cleanupE2E();
  await closeAll();
});

describe('可觀測性(W3-5.11)', () => {
  it('/metrics、/docs 不對外;內網(容器內)可讀,文件列出管理 API', async () => {
    expect((await new Session().get('/metrics')).status).toBe(404);
    expect((await new Session().get('/docs/json')).status).toBe(404);
    expect((await bffInternal('/metrics', {})).status).toBe(200);
    const docs = await bffInternal('/docs/json', {});
    expect(docs.status).toBe(200);
    expect(Object.keys(docs.json.paths)).toEqual(expect.arrayContaining(['/api/admin/api-clients', '/api/admin/imports', '/api/notify/messages']));
    expect(Object.keys(docs.json.paths)).not.toContain('/_auth/verify');
  });
});

describe('角色、權限與 AD 群組(P2-3)', () => {
  it('新增角色與權限;修改需 rowVer;內建角色不可刪', async () => {
    expect((await admin('POST', '/api/admin/permissions', { code: 'e2ez.p2.menu', name: 'E2E 選單', kind: 'menu', parentCode: 'e2ez.p2.read' })).status).toBe(
      201,
    );
    expect((await admin('POST', '/api/admin/permissions', { code: 'e2ez.p2.loop', name: 'x', parentCode: 'e2ez.p2.loop' })).status).toBe(400);
    const created = await admin('POST', '/api/admin/roles', { code: 'e2e-p2-role', name: 'E2E P2 角色' });
    expect(created.status).toBe(201);
    expect((await admin('PATCH', '/api/admin/roles/e2e-p2-role', { rowVer: '0000000000000000', name: 'x' })).status).toBe(409);
    const patched = await admin('PATCH', '/api/admin/roles/e2e-p2-role', { rowVer: created.json.rowVer, description: 'E2E' });
    expect(patched.json.description).toBe('E2E');
    expect((await admin('PUT', '/api/admin/roles/e2e-p2-role/permissions', { permissions: ['e2ez.p2.read', 'e2ez.p2.menu'] })).status).toBe(200);
    const employee = (await admin('GET', '/api/admin/roles')).json.items.find((r: any) => r.code === 'employee');
    expect((await admin('DELETE', `/api/admin/roles/employee?rowVer=${employee.rowVer}`)).status).toBe(403);
  });

  it('AD 群組:需為 DN;gw-super-admin 不開放;取代後可查詢', async () => {
    expect((await admin('PUT', '/api/admin/roles/e2e-p2-role/ad-groups', { groups: ['not a dn'] })).status).toBe(400);
    expect((await admin('PUT', '/api/admin/roles/gw-super-admin/ad-groups', { groups: [] })).status).toBe(403);
    const dn = 'CN=GN-E2E-P2,OU=Groups,DC=gsmc,DC=com,DC=tw';
    expect((await admin('PUT', '/api/admin/roles/e2e-p2-role/ad-groups', { groups: [dn] })).json.groups).toEqual([dn]);
    expect((await admin('GET', '/api/admin/roles/e2e-p2-role/ad-groups')).json.items.map((g: any) => g.dn)).toEqual([dn]);
  });

  it('權限仍被路由使用時不可刪除', async () => {
    const p = (await admin('GET', '/api/admin/permissions?system=e2ez')).json.items.find((x: any) => x.code === 'e2ez.p2.read');
    const res = await admin('DELETE', `/api/admin/permissions/e2ez.p2.read?rowVer=${p.rowVer}`);
    expect(res.status).toBe(400);
    expect(res.json.details.map((d: any) => d.message)).toContain('e2ez.p2.key');
  });
});

describe('API Key 與 api_key 路由(P2-5)', () => {
  let clientKey = '';

  it('建立回傳一次明文;清單不含金鑰;不可授予自己沒有的權限', async () => {
    const res = await admin('POST', '/api/admin/api-clients', { code: 'e2e-p2-client', permissions: ['e2ez.p2.read'], allowedIps: '' });
    expect(res.status).toBe(201);
    expect(res.json.key).toMatch(/^[A-Za-z0-9_-]{40}$/);
    clientKey = res.json.key;
    const list = await admin('GET', '/api/admin/api-clients');
    expect(JSON.stringify(list.json)).not.toContain(clientKey);
    expect((await admin('POST', '/api/admin/api-clients', { code: 'e2e-p2-bad', permissions: ['gw.admin.local.write'] })).status).toBe(403);
  });

  it('api_key 路由:無金鑰 401、權限不符 403、正確 200', async () => {
    expect((await new Session().get(KEY_ROUTE)).status).toBe(401);
    const other = await admin('POST', '/api/admin/api-clients', { code: 'e2e-p2-other', permissions: [] });
    expect((await new Session().get(KEY_ROUTE, { 'x-api-key': other.json.key })).status).toBe(403);
    const ok = await new Session().get(KEY_ROUTE, { 'x-api-key': clientKey });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ system: true });
  });

  it('換發後舊金鑰立即失效;停用後新金鑰也失效', async () => {
    const cur = (await admin('GET', '/api/admin/api-clients/e2e-p2-client')).json;
    const rotated = await admin('POST', '/api/admin/api-clients/e2e-p2-client/rotate', { rowVer: cur.rowVer });
    expect(rotated.status).toBe(200);
    expect((await new Session().get(KEY_ROUTE, { 'x-api-key': clientKey })).status).toBe(401);
    expect((await new Session().get(KEY_ROUTE, { 'x-api-key': rotated.json.key })).status).toBe(200);
    expect((await admin('PATCH', '/api/admin/api-clients/e2e-p2-client', { rowVer: rotated.json.rowVer, isEnabled: false })).status).toBe(200);
    expect((await new Session().get(KEY_ROUTE, { 'x-api-key': rotated.json.key })).status).toBe(401);
  });
});

describe('路由試打(P2-1)與存取反查(P2-6)', () => {
  const routeId = async (code: string) =>
    (await admin('GET', `/api/admin/routes?q=${code}`)).json.items.find((r: any) => r.routeCode === code).routeId as number;

  it('API Key 不可試打;登入者以自己的身分試打 mock 路由', async () => {
    const id = await routeId('e2ez.p2.mock');
    expect((await admin('POST', `/api/admin/routes/${id}/test`, {})).status).toBe(403);
    await cliApply('roles:\n  - code: e2e-p2-tester\n    name: E2E 試打\n    permissions: [gw.admin.route.write]\n');
    const u = (await admin('GET', `/api/admin/users/${EMP}`)).json;
    expect((await admin('PATCH', `/api/admin/users/${EMP}`, { rowVer: u.rowVer, roles: [{ code: 'e2e-p2-tester' }] })).status).toBe(200);
    const { s } = await login(EMP);
    const res = await s.post(`/api/admin/routes/${id}/test`, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ routeCode: 'e2ez.p2.mock', wouldBeAllowed: true, response: { status: 200, body: { pong: true } } });
    expect((await s.post(`/api/admin/routes/${await routeId('e2ez.p2.key')}/test`, { path: '/api/e2ez/other' })).status).toBe(400);
  });

  it('誰能存取:api_key 路由列出 API Key;有效權限含角色來源', async () => {
    const who = await admin('GET', `/api/admin/routes/${await routeId('e2ez.p2.key')}/who-can-access`);
    expect(who.json.access.apiClients.map((c: any) => c.code)).toContain('e2e-p2-admin');
    const byPerm = await admin('GET', '/api/admin/permissions/e2ez.p2.read/who-can-access');
    expect(byPerm.json.roles.find((r: any) => r.code === 'e2e-p2-role').adGroups).toEqual(['CN=GN-E2E-P2,OU=Groups,DC=gsmc,DC=com,DC=tw']);
    const eff = await admin('GET', `/api/admin/users/${EMP}/effective-permissions`);
    expect(eff.json.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'employee', sources: ['default'] }),
        expect.objectContaining({ code: 'e2e-p2-tester', sources: ['user'] }),
      ]),
    );
    expect(eff.json.permissions.find((p: any) => p.code === 'gw.admin.route.write').grantedBy).toEqual(['e2e-p2-tester']);
  });
});

describe('匯入(P2-4)', () => {
  const header = 'route_code,name,system_code,method,public_path,route_type,auth_mode,permission_code,permission_name,mock_response';

  it('範本下載(xlsx / csv)', async () => {
    const res = await fetch(`${BASE}/api/admin/imports/template?format=csv`, { headers: { 'x-api-key': adminKey } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('route_code,name,system_code');
    const xlsx = await fetch(`${BASE}/api/admin/imports/template`, { headers: { 'x-api-key': adminKey } });
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml');
  });

  it('CSV:預覽不寫路由;權限不存在時需一併建立;提交後為草稿', async () => {
    const csv = `${header}\ne2ez.p2.imported,E2E 匯入,e2ez,GET,/api/e2ez/p2-imported,mock,permission,e2ez.p2.newperm,E2E 新權限,"{""a"":1}"\n`;
    const bad = await upload('e2e-p2.csv', csv);
    expect(bad.status).toBe(201);
    expect(bad.json).toMatchObject({ status: 'failed', canCommit: false });
    expect((await admin('POST', `/api/admin/imports/${bad.json.batchId}/commit`, {})).status).toBe(400);

    const ok = await upload('e2e-p2.csv', csv, { createPermissions: 'true' });
    expect(ok.json).toMatchObject({ status: 'preview', canCommit: true, summary: { create: 1, error: 0 } });
    expect(await query("SELECT 1 FROM gw.api_route WHERE route_code = 'e2ez.p2.imported'")).toHaveLength(0);
    const commit = await admin('POST', `/api/admin/imports/${ok.json.batchId}/commit`, {});
    expect(commit.json).toMatchObject({ status: 'committed', created: 1, createdPermissions: 1 });
    expect((await query("SELECT status FROM gw.api_route WHERE route_code = 'e2ez.p2.imported'"))[0]?.status).toBe('draft');
    expect((await admin('POST', `/api/admin/imports/${ok.json.batchId}/commit`, {})).status).toBe(400);
    await query("DELETE FROM gw.api_route WHERE route_code = 'e2ez.p2.imported'");
  });

  it('OpenAPI:需 target;port 不在區間列為錯誤', async () => {
    const spec = JSON.stringify({
      openapi: '3.0.3',
      'x-gateway': { upstream: 'e2e-p2-up', system: 'e2ez' },
      'x-permissions': [{ code: 'e2ez.p2.read', name: 'E2E P2 權限' }],
      paths: { '/v1/p2': { get: { operationId: 'e2ez.p2.openapi', summary: 'E2E OpenAPI', 'x-permission': 'e2ez.p2.read' } } },
    });
    expect((await upload('e2e-p2.json', spec)).status).toBe(400);
    const bad = await upload('e2e-p2.json', spec, { target: 'http://127.0.0.1:8080' });
    expect(bad.json.status).toBe('failed');
    const ok = await upload('e2e-p2.json', spec, { target: 'http://127.0.0.1:51299' });
    expect(ok.json).toMatchObject({ status: 'preview', summary: { create: 1 } });
    expect((await admin('POST', `/api/admin/imports/${ok.json.batchId}/commit`, {})).json).toMatchObject({
      status: 'committed',
      created: 1,
      upstream: 'e2e-p2-up',
    });
  });
});

describe('通知範本、發送紀錄與站內收件匣(P2-7、PRD §8.5)', () => {
  it('範本:新增、需 rowVer 修改、預覽', async () => {
    const created = await admin('POST', '/api/admin/notify/templates', {
      code: 'E2E_P2_MAIL',
      name: 'E2E 信',
      channels: ['email'],
      emailSubject: 'Hi {{name}}',
      emailBody: '<b>{{name}}</b>',
    });
    expect(created.status).toBe(201);
    expect((await admin('POST', '/api/admin/notify/templates', { code: 'E2E_P2_BAD', name: 'x', channels: ['email'] })).status).toBe(400);
    expect((await admin('PATCH', '/api/admin/notify/templates/E2E_P2_MAIL', { rowVer: created.json.rowVer, name: 'E2E 信 2' })).json.name).toBe('E2E 信 2');
    const pv = await admin('POST', '/api/admin/notify/templates/E2E_P2_MAIL/preview', { data: { name: '<x>' } });
    expect(pv.json.email).toEqual({ subject: 'Hi <x>', html: '<b>&lt;x&gt;</b>' });
  });

  it('站內通知:發送後收件匣有未讀,可標記已讀;發送紀錄可查', async () => {
    expect((await admin('POST', '/api/notify/send', { templateCode: 'E2E_P2_INAPP', to: { users: [EMP] }, data: { n: 1 } })).status).toBe(202);
    const { s } = await login(EMP);
    const inbox = await waitFor(async () => {
      const r = await s.get('/api/notify/messages?unread=true');
      return r.json.total > 0 ? r.json : null;
    });
    expect(inbox.items[0]).toMatchObject({ title: 'E2E 1', body: '第 1 則', isRead: false });
    const read = await s.post(`/api/notify/messages/${inbox.items[0].messageId}/read`);
    expect(read.json).toMatchObject({ isRead: true, unread: 0 });
    // 別人的通知與不存在一視同仁
    const other = await login(EMP);
    expect((await other.s.post('/api/notify/messages/999999999/read')).status).toBe(400);
    const logs = await admin('GET', '/api/admin/notify/logs?templateCode=E2E_P2_INAPP');
    expect(logs.json.items[0]).toMatchObject({ channel: 'inapp', recipientUserId: userId });
  });
});

describe('稽核查詢與人員同步紀錄(P2-7、P2-3)', () => {
  it('稽核紀錄可依對象與動作前綴查詢;登入事件可依帳號查詢', async () => {
    const audit = await admin('GET', '/api/admin/audit-logs?entityType=api_client&entityId=e2e-p2-client&action=client.');
    expect(audit.json.items.map((i: any) => i.action)).toEqual(expect.arrayContaining(['client.create', 'client.rotate', 'client.disable']));
    expect(audit.json.items[0].actorName).toBe('client:e2e-p2-admin');
    const auth = await admin('GET', `/api/admin/auth-logs?username=${EMP}&event=login_success`);
    expect(auth.json.total).toBeGreaterThan(0);
  });

  it('人員同步:手動觸發回 202(已有排隊或執行中時回傳該筆);紀錄可查', async () => {
    const res = await admin('POST', '/api/admin/employee-sync/runs');
    expect(res.status).toBe(202);
    expect(['queued', 'running', 'success', 'partial', 'aborted', 'failed']).toContain(res.json.status);
    const runs = await admin('GET', '/api/admin/employee-sync/runs?pageSize=5');
    expect(runs.json.items.map((r: any) => r.runId)).toContain(res.json.runId);
  });
});
