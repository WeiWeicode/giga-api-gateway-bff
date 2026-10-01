/** docs/Gherkin/gateway/nginx-entry.feature(W3-2) */
import { connect } from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { fetch } from 'undici';
import { agent, CA, closeAll, compose, login, Session } from './gw.js';

afterAll(closeAll);

function tlsHandshake(opts: {
  minVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  maxVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  port?: number;
}) {
  return new Promise<{ ok: boolean; protocol?: string | null; error?: string }>((resolve) => {
    const s = connect(
      {
        host: '127.0.0.1',
        port: opts.port ?? 443,
        servername: 'localhost',
        ca: CA,
        minVersion: opts.minVersion,
        maxVersion: opts.maxVersion,
        ciphers: 'DEFAULT@SECLEVEL=0',
      },
      () => {
        resolve({ ok: true, protocol: s.getProtocol() });
        s.end();
      },
    );
    s.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

describe('Nginx :443 入口', () => {
  it('HTTP 一律 301 轉址到 HTTPS', async () => {
    const res = await fetch('http://localhost/mes/', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://localhost/mes/');
  });

  it.each([
    ['TLSv1', false],
    ['TLSv1.1', false],
    ['TLSv1.2', true],
    ['TLSv1.3', true],
  ] as const)('只接受 TLS 1.2 以上:%s → %s', async (v, ok) => {
    const r = await tlsHandshake({ minVersion: v, maxVersion: v });
    expect(r.ok).toBe(ok);
    if (ok) expect(r.protocol).toBe(v);
  });

  it('伺服器憑證 SAN 含 IP,以 IP 存取可通過驗證', async () => {
    const res = await fetch('https://127.0.0.1/healthz', { dispatcher: agent });
    expect(res.status).toBe(200);
  });

  it('SPA 深層頁面重新整理時回傳該系統的 index.html,且不快取', async () => {
    const res = await fetch('https://localhost/mes/work-orders/123', { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const html = await res.text();
    expect(html).toContain('<title>GigaNexus MES 看板</title>');
    expect(html).toMatch(/src="\/mes\/assets\/index-[\w-]+\.js"/);
  });

  it('帶 hash 的靜態資源長期快取', async () => {
    const html = await (await fetch('https://localhost/mes/', { dispatcher: agent })).text();
    const asset = /src="(\/mes\/assets\/[^"]+\.js)"/.exec(html)![1]!;
    const res = await fetch(`https://localhost${asset}`, { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('max-age=31536000, immutable');
  });

  it('入口網的前端頁面(/login)由入口網 SPA 提供', async () => {
    const res = await fetch('https://localhost/login', { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('GigaNexus 入口網');
  });

  it('清除使用者偽造的內部身分標頭;BFF 與上游收到 X-Request-Id', async () => {
    const { s } = await login('S112009');
    const res = await s.get('/api/mes/debug/echo', { 'X-User-Id': 'admin', 'X-Internal-Token': 'forged.jwt', 'X-User-Roles': 'gw-super-admin' });
    expect(res.status).toBe(200);
    const h = res.json.headers as Record<string, string>;
    expect(h['x-user-id']).toBeUndefined();
    expect(h['x-user-roles']).toBeUndefined();
    expect(h['x-internal-token']).toBeDefined();
    expect(h['x-internal-token']).not.toBe('forged.jwt');
    expect(h['x-request-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.get('x-request-id')).toBe(h['x-request-id']);
  });

  it('回應不洩漏伺服器資訊,並帶安全標頭', async () => {
    const { s } = await login('S112009');
    const res = await s.get('/api/mes/debug/echo');
    expect(res.headers.get('server')).toBe('nginx');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('/_auth/verify 僅供 auth_request 內部使用,對外回統一 JSON 404', async () => {
    const res = await new Session().get('/_auth/verify');
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  });

  it('Webhook:非允許來源 IP 在 Nginx 即被拒(403 IP_NOT_ALLOWED)', async () => {
    const res = await new Session().post('/webhook/bpm', { event: 'approved' }, { csrf: false });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: 'IP_NOT_ALLOWED' });
  });

  it('Webhook:允許的來源(模擬 BPM 主機 172.30.0.50)可通過 Nginx 到達 BFF', async () => {
    const out = await compose(
      'exec',
      '-T',
      '-e',
      'NODE_TLS_REJECT_UNAUTHORIZED=0',
      'mock-bpm',
      'node',
      '-e',
      `fetch('https://nginx/webhook/bpm',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(async r=>console.log(r.status, await r.text())).catch(e=>console.log('ERR',e.cause?.code??e.message))`,
    );
    // 通過白名單後由 BFF 的 Webhook 模組回應:未簽章 → 401;尚未以 CLI 設定 bpm 端點 → 404(驗簽細節見 11-webhook)
    expect(out).not.toContain('IP_NOT_ALLOWED');
    expect(out).toMatch(/^(401 \{"code":"WEBHOOK_SIGNATURE_INVALID"|404 \{"code":"WEBHOOK_SOURCE_NOT_FOUND")/);
  });
});
