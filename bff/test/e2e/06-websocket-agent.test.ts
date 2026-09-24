/** WebSocket(nginx-entry.feature 後段,W3-2.6)與 Agent 專用通道(gateway/agent-mtls.feature,W3-3) */
import { readFileSync } from 'node:fs';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CA, clearLoginFails, closeAll, login, PKI, REPO } from './gw.js';

beforeAll(async () => {
  for (const e of ['S112009', 'S100001']) await clearLoginFails(e);
});
afterAll(closeAll);

function openWs(
  path: string,
  cookie?: string,
): Promise<{ status: 'open'; first: unknown; ws: WebSocket } | { status: 'rejected'; code: number } | { status: 'closed'; code: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://localhost${path}`, { ca: CA, headers: cookie ? { cookie } : {} });
    ws.once('unexpected-response', (_req, res) => resolve({ status: 'rejected', code: res.statusCode ?? 0 }));
    ws.once('message', (data) => resolve({ status: 'open', first: JSON.parse(data.toString()), ws }));
    ws.once('close', (code) => resolve({ status: 'closed', code }));
    ws.once('error', () => undefined);
  });
}

describe('WebSocket', () => {
  it('/ws/notify:已登入者連線升級成功並收到 hello', async () => {
    const { s } = await login('S112009');
    const r = await openWs('/ws/notify', s.cookieHeader('/ws/notify'));
    expect(r.status).toBe('open');
    if (r.status === 'open') {
      expect(r.first).toMatchObject({ type: 'hello', emp: 'S112009' });
      r.ws.close();
    }
  });

  it('/ws/notify:未登入者被關閉(4401)', async () => {
    const r = await openWs('/ws/notify');
    expect(r).toMatchObject({ status: 'closed', code: 4401 });
  });

  it('/ws/endpoint/*:auth_request 驗證通過後直連 Endpoint Server,並帶內部 Token', async () => {
    const { s } = await login('S100001'); // GN-IT-Admins → it-endpoint(endpoint.remote.operate)
    const r = await openWs('/ws/endpoint/PC-001', s.cookieHeader('/ws/endpoint/PC-001'));
    expect(r.status).toBe('open');
    if (r.status === 'open') {
      // Endpoint Server 以 JWKS 驗證 X-Internal-Token(aud = endpoint-api)後回 hello
      expect(r.first).toMatchObject({ type: 'hello', pc: 'PC-001', emp: 'S100001', authUser: 'S100001' });
      r.ws.close();
    }
  });

  it('/ws/endpoint/*:沒有端點遠端操作權限 → 403', async () => {
    const { s } = await login('S112009');
    expect(await openWs('/ws/endpoint/PC-001', s.cookieHeader('/ws/endpoint/PC-001'))).toMatchObject({ status: 'rejected', code: 403 });
  });

  it('/ws/endpoint/*:未登入 → 401', async () => {
    expect(await openWs('/ws/endpoint/PC-001')).toMatchObject({ status: 'rejected', code: 401 });
  });
});

/* ---------------- Agent :9443 mTLS + gRPC ---------------- */

const def = protoLoader.loadSync(fileURLToPath(new URL('tools/mock-upstream/agent.proto', `file://${REPO}`)), { keepCase: true });
const AgentService = (grpc.loadPackageDefinition(def) as any).giganexus.agent.v1.AgentService;

function heartbeat(cert?: string): Promise<{ ok: true; reply: any } | { ok: false; code: number; details: string }> {
  const creds = cert ? grpc.credentials.createSsl(CA, readFileSync(`${PKI}/${cert}.key`), readFileSync(`${PKI}/${cert}.crt`)) : grpc.credentials.createSsl(CA);
  const client = new AgentService('localhost:9443', creds);
  return new Promise((resolve) => {
    client.Heartbeat({ pc: cert ?? 'none' }, { deadline: Date.now() + 5000 }, (err: grpc.ServiceError | null, reply: unknown) => {
      client.close();
      resolve(err ? { ok: false, code: err.code, details: err.details } : { ok: true, reply });
    });
  });
}

describe('Agent 專用通道 :9443(mTLS + gRPC)', () => {
  it('有效憑證可經 gRPC 呼叫,上游收到正確 DN / 指紋 / 驗證結果', async () => {
    const r = await heartbeat('agent-valid');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reply.client_cert_dn).toBe('O=GigaNexus Dev,CN=PC-001');
      expect(r.reply.client_verify).toBe('SUCCESS');
      expect(r.reply.client_cert_fp).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it.each(['agent-expired', 'agent-revoked', 'agent-rogue', undefined])('無效憑證(%s)被拒,不會到達 Endpoint Server', async (cert) => {
    const r = await heartbeat(cert);
    expect(r.ok).toBe(false);
  });

  it('無憑證時 TLS 可握手但 Nginx 立即拒絕(記錄:Nginx ssl_verify_client 在 HTTP 層回 400,而非 TLS 層中斷)', async () => {
    const result = await new Promise<string>((resolve) => {
      const sock = connect({ host: '127.0.0.1', port: 9443, servername: 'localhost', ca: CA, ALPNProtocols: ['http/1.1'] }, () => {
        sock.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
      });
      let data = '';
      sock.on('data', (d) => (data += d.toString()));
      sock.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
      sock.on('error', (e) => resolve(`TLS error: ${e.message}`));
    });
    expect(result).toMatch(/400|TLS error/);
  });

  it('瀏覽器存取 :443 不會被要求出示憑證', async () => {
    const requested = await new Promise<boolean>((resolve) => {
      const sock = connect({ host: '127.0.0.1', port: 443, servername: 'localhost', ca: CA }, () => {
        // 伺服器若要求用戶端憑證,getPeerCertificate 以外可由 authorizationError / 伺服器 CertificateRequest 判斷;這裡確認不需憑證即可完成請求
        sock.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.on('data', (d) => (data += d.toString()));
      sock.on('end', () => resolve(!data.startsWith('HTTP/1.1 200')));
      sock.on('error', () => resolve(true));
    });
    expect(requested).toBe(false);
  });
});
