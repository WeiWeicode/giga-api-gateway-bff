/** docs/Gherkin/router/release-publish.feature(W3-5.6、W3-5.7) */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bffReadyz, clearLoginFails, cli, closeAll, compose, login, query, redis, sleep, type Session } from './gw.js';

let s: Session;
beforeAll(async () => {
  await clearLoginFails('S112009');
  s = (await login('S112009')).s;
});
afterAll(closeAll);

async function waitForVersion(v: number, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [a, b] = await Promise.all([bffReadyz('bff-1'), bffReadyz('bff-2')]);
    if (a.routes.version >= v && b.routes.version >= v) return Date.now() - start;
    await sleep(100);
  }
  throw new Error(`版本 ${v} 未在 ${timeoutMs} ms 內生效`);
}

async function applyMock(path: string, title: string) {
  const yaml = `routes:\n  - routeCode: e2e.release.mock\n    name: 發佈測試\n    systemCode: e2e\n    method: GET\n    publicPath: ${path}\n    routeType: mock\n    authMode: authenticated\n    mockResponse: { title: '${title}' }\n`;
  await compose('exec', '-T', 'bff-1', 'sh', '-c', `cat > /tmp/e2e-route.yaml <<'EOF'\n${yaml}EOF`);
  return cli('apply', '--file', '/tmp/e2e-route.yaml');
}

describe('路由設定發佈與 Redis 同步', () => {
  it('編輯草稿不影響線上', async () => {
    await applyMock('/api/e2e/release', 'v1');
    const [r] = await query("SELECT status FROM gw.api_route WHERE route_code = 'e2e.release.mock'");
    expect(r.status).toBe('draft');
    expect((await s.get('/api/e2e/release')).status).toBe(404);
  });

  it('發佈後 5 秒內 2 個 BFF 實例皆生效,並記錄 config_release 與稽核', async () => {
    const pub = await cli('publish', '--note', 'e2e');
    expect(pub.redisSynced).toBe(true);
    expect(pub.diff.added).toContain('e2e.release.mock');
    const ms = await waitForVersion(pub.version, 5000);
    console.log(`發佈生效時間:${ms} ms`);
    expect(Number(await redis().get('gw:routes:version'))).toBe(pub.version);
    expect((await s.get('/api/e2e/release')).json).toEqual({ title: 'v1' });
    const [a] = await query("SELECT TOP 1 action, entity_id FROM gw.audit_log WHERE action = 'release.publish' ORDER BY audit_id DESC");
    expect(a.entity_id).toBe(String(pub.version));
  });

  it('亂序或重複的版本通知不會造成回退', async () => {
    const current = (await bffReadyz('bff-1')).routes.version;
    await redis().publish('gw:config:changed', '1');
    await sleep(500);
    expect((await bffReadyz('bff-1')).routes.version).toBe(current);
    expect((await bffReadyz('bff-2')).routes.version).toBe(current);
  });

  it('回滾:以歷史版本產生新版本,rolled_back_from 記錄來源', async () => {
    const before = (await bffReadyz('bff-1')).routes.version;
    await applyMock('/api/e2e/release', 'v2');
    const v2 = await cli('publish', '--note', 'e2e v2');
    await waitForVersion(v2.version, 5000);
    expect((await s.get('/api/e2e/release')).json).toEqual({ title: 'v2' });

    const rb = await cli('rollback', '--to', String(before));
    expect(rb.version).toBeGreaterThan(v2.version);
    await waitForVersion(rb.version, 5000);
    expect((await s.get('/api/e2e/release')).json).toEqual({ title: 'v1' });
    const [row] = await query('SELECT rolled_back_from FROM gw.config_release WHERE release_id = @v', { v: rb.version });
    expect(row.rolled_back_from).toBe(before);
  });

  it('Redis 更新遺失時由補償機制修正(版本比對 + gw:lock:sync)', async () => {
    const latest = (await bffReadyz('bff-1')).routes.version;
    await redis().del('gw:routes:version', 'gw:routes:snapshot');
    const start = Date.now();
    while (!(await redis().get('gw:routes:version')) && Date.now() - start < 25_000) await sleep(500);
    expect(Number(await redis().get('gw:routes:version'))).toBe(latest);
    expect(JSON.parse((await redis().get('gw:routes:snapshot'))!).version).toBe(latest);
  });

  it('認證 API 不受路由表影響(路由表中的 /api/auth/* 一律忽略)', async () => {
    const yaml = `routes:\n  - routeCode: e2e.hijack\n    name: 誤設\n    systemCode: auth\n    method: POST\n    publicPath: /api/auth/login\n    routeType: mock\n    authMode: public\n    mockResponse: { hijacked: true }\n`;
    await compose('exec', '-T', 'bff-1', 'sh', '-c', `cat > /tmp/e2e-hijack.yaml <<'EOF'\n${yaml}EOF`);
    await cli('apply', '--file', '/tmp/e2e-hijack.yaml');
    const pub = await cli('publish', '--note', 'e2e hijack');
    await waitForVersion(pub.version, 5000);
    const r = await login('S112009');
    expect(r.res.status).toBe(200);
    expect(r.res.json).not.toHaveProperty('hijacked');
    // 清除測試路由
    await query("UPDATE gw.api_route SET status = 'disabled' WHERE route_code IN ('e2e.hijack', 'e2e.release.mock')");
    const clean = await cli('publish', '--note', 'e2e cleanup');
    await waitForVersion(clean.version, 5000);
  });
});

describe('OpenAPI 匯入(W3-5.7 CLI)', () => {
  it('缺少 x-permission 的 operation 列為錯誤,不寫入任何路由', async () => {
    const spec = JSON.stringify({
      openapi: '3.0.3',
      'x-gateway': { upstream: 'go-mes', system: 'mes' },
      'x-permissions': [],
      paths: { '/v1/bad': { get: { operationId: 'mes.bad.get', summary: '缺權限' } } },
    });
    await compose('exec', '-T', 'bff-1', 'sh', '-c', `echo '${spec}' > /tmp/bad.json`);
    await expect(cli('import-openapi', '--file', '/tmp/bad.json', '--target', 'http://mock-mes:51210')).rejects.toThrow(/IMPORT_HAS_ERRORS/);
    expect(await query("SELECT * FROM gw.api_route WHERE route_code = 'mes.bad.get'")).toHaveLength(0);
  });

  it('上游 port 不在 51200–51300 時拒絕', async () => {
    await expect(cli('import-openapi', '--file', 'http://mock-mes:51210/openapi.json', '--target', 'http://mock-mes:8080')).rejects.toThrow(
      /UPSTREAM_PORT_OUT_OF_RANGE/,
    );
  });

  it('重新匯入相同規格:全部 unchanged', async () => {
    const r = await cli('import-openapi', '--file', 'http://mock-mes:51210/openapi.json', '--target', 'http://mock-mes:51210');
    expect(r).toMatchObject({ created: 0, updated: 0 });
    expect(r.unchanged).toBeGreaterThan(5);
  });
});
