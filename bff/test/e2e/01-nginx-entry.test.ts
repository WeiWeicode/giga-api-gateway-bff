/** docs/Gherkin/gateway/nginx-entry.feature(W3-2):測試區 Nginx 入口 */
import { connect } from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeAll, GATEWAY_IP, HOST, Session } from './gw.js';

afterAll(closeAll);

function tlsHandshake(opts: { version?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'; port?: number; servername?: string; host?: string }) {
  return new Promise<{ ok: boolean; protocol?: string | null; error?: string }>((resolve) => {
    const s = connect(
      {
        host: opts.host ?? HOST,
        port: opts.port ?? 443,
        ...(opts.port === 9443 ? {} : { servername: opts.servername ?? HOST }),
        minVersion: opts.version,
        maxVersion: opts.version,
        ciphers: 'DEFAULT@SECLEVEL=0',
        rejectUnauthorized: opts.port !== 9443,
      },
      () => {
        resolve({ ok: true, protocol: s.getProtocol() });
        s.end();
      },
    );
    s.setTimeout(10_000, () => s.destroy(new Error('timeout')));
    s.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

describe('Nginx :443 入口', () => {
  it('HTTP 一律 301 轉址到 HTTPS', async () => {
    const res = await fetch(`http://${HOST}/it/`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`https://${HOST}/it/`);
  });

  it.each([
    ['TLSv1', false],
    ['TLSv1.1', false],
    ['TLSv1.2', true],
    ['TLSv1.3', true],
  ] as const)('只接受 TLS 1.2 以上:%s → %s', async (v, ok) => {
    const r = await tlsHandshake({ version: v });
    expect(r.ok).toBe(ok);
    if (ok) expect(r.protocol).toBe(v);
  });

  it('公司憑證(*.gigasolar.com.tw)可通過驗證', async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
  });

  it('入口網的登入頁(/login)由員工入口網 SPA 提供,HTML 不快取', async () => {
    const res = await fetch(`${BASE}/login`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>GigaNexus 員工入口網</title>');
  });

  it('SPA 深層頁面重新整理時回傳該應用的 index.html;帶 hash 的靜態資源長期快取', async () => {
    const res = await fetch(`${BASE}/it/gateway/services/routes`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const asset = /src="(\/it\/assets\/[^"]+\.js)"/.exec(await res.text())?.[1];
    expect(asset).toBeDefined();
    const a = await fetch(BASE + asset);
    expect(a.status).toBe(200);
    expect(a.headers.get('cache-control')).toBe('max-age=31536000, immutable');
  });

  it('回應不洩漏伺服器資訊,並帶安全標頭與 X-Request-Id', async () => {
    const res = await new Session().get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers.get('server')).toBe('nginx');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{32}$/);
    expect(res.json).toMatchObject({ code: 'UNAUTHENTICATED', requestId: res.headers.get('x-request-id') });
  });

  it('不存在的 API 回統一 JSON 404', async () => {
    const res = await new Session().get('/api/e2e-nope/things');
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
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
});

describe('Nginx :9443 Agent 通道', () => {
  it('沒有裝置憑證的連線不會到達 Endpoint Server', async () => {
    // ssl_verify_client on:握手後在 HTTP 層回 400(ENDPOINT-AGENT-GUIDE §10 G2)
    const r = await tlsHandshake({ host: GATEWAY_IP, port: 9443 });
    if (!r.ok) return; // TLS 層直接拒絕也符合
    const res = await new Promise<string>((resolve) => {
      const s = connect({ host: GATEWAY_IP, port: 9443, rejectUnauthorized: false }, () => s.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let buf = '';
      s.on('data', (d) => (buf += d.toString()));
      s.on('close', () => resolve(buf));
      s.on('error', () => resolve(buf));
      s.setTimeout(10_000, () => s.destroy());
    });
    expect(res).toMatch(/^HTTP\/1\.1 400/);
  });
});
