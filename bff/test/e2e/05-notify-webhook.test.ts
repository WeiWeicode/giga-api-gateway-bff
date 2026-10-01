/**
 * docs/Gherkin/notify/notification.feature(W3-5.8、W3-5.9)、webhook/webhook.feature(W3-5.10)
 * 通知只用站內通道(不寄 Email);Webhook 的來源 IP 白名單在 Nginx(01 已驗證拒絕),簽章以下在 bff 容器內以臨時來源 e2etest 直接呼叫 BFF 驗證。
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiKeyCall,
  BASE,
  bffInternal,
  cleanupE2E,
  cliApply,
  closeAll,
  createApiKey,
  createLocalUser,
  EMP_PREFIX,
  login,
  query,
  remote,
  waitFor,
} from './gw.js';

const EMP = `${EMP_PREFIX}D1`;
let userId = 0;
let notifier: ReturnType<typeof apiKeyCall>;

beforeAll(async () => {
  await cleanupE2E();
  userId = await createLocalUser(EMP);
  notifier = apiKeyCall(await createApiKey('e2e-notify', ['notify.message.send']));
  await cliApply(
    'notifyTemplates:\n  - code: E2E_NOTIFY\n    name: E2E 通知\n    channels: [inapp]\n    emailSubject: "E2E 通知 {{formNo}}"\n    inappBody: "E2E 站內通知:{{formNo}}"\n',
  );
});
afterAll(async () => {
  await cleanupE2E();
  await closeAll();
});

describe('通知', () => {
  it('入列 202;查無工號記為 skipped;worker 寫入站內通知並經 /ws/notify 即時推播', async () => {
    const { s } = await login(EMP);
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/notify`, { headers: { cookie: s.cookieHeader('/ws/notify') } });
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    await waitFor(async () => messages.some((m) => m.type === 'hello'));

    const formNo = `E2E-${Date.now()}`;
    const res = await notifier('POST', '/api/notify/send', { templateCode: 'E2E_NOTIFY', to: { users: [EMP, `${EMP_PREFIX}NONE`] }, data: { formNo } });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ queued: 1, skipped: 1 });

    const pushed = await waitFor(async () => messages.find((m) => m.type === 'notification'));
    expect(pushed).toMatchObject({ title: `E2E 通知 ${formNo}`, body: `E2E 站內通知:${formNo}` });
    ws.close();
    const [msg] = await query('SELECT title, is_read FROM gw.notify_message WHERE user_id = @id', { id: userId });
    expect(msg).toMatchObject({ title: `E2E 通知 ${formNo}`, is_read: false });
    const logs = await query<{ status: string }>(
      "SELECT status FROM gw.notify_log WHERE template_code = 'E2E_NOTIFY' AND idempotency_key IS NULL AND requested_by = 'client:e2e-notify' ORDER BY log_id",
    );
    expect(logs.map((l) => l.status).sort()).toEqual(['sent', 'skipped']);
  });

  it('相同 idempotencyKey 24 小時內只送一次', async () => {
    const body = { templateCode: 'E2E_NOTIFY', to: { users: [EMP] }, data: { formNo: 'IDEM' }, idempotencyKey: `e2e-${randomUUID()}` };
    expect((await notifier('POST', '/api/notify/send', body)).status).toBe(202);
    const again = await notifier('POST', '/api/notify/send', body);
    expect(again.status).toBe(200);
    expect(again.json.code).toBe('DUPLICATE_REQUEST');
  });

  it('LINE 通道 → 400 CHANNEL_NOT_SUPPORTED;範本不存在 → 400', async () => {
    expect((await notifier('POST', '/api/notify/send', { templateCode: 'E2E_NOTIFY', channels: ['line'], to: { users: [EMP] } })).json.code).toBe(
      'CHANNEL_NOT_SUPPORTED',
    );
    expect((await notifier('POST', '/api/notify/send', { templateCode: 'E2E_NONE', to: { users: [EMP] } })).status).toBe(400);
  });

  it('沒有 notify.message.send 的 API Key → 403', async () => {
    const other = apiKeyCall(await createApiKey('e2e-noperm', ['gw.admin.route.read']));
    const res = await other('POST', '/api/notify/send', { templateCode: 'E2E_NOTIFY', to: { users: [EMP] } });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('PERMISSION_DENIED');
  });
});

describe('Webhook(bff 容器內呼叫)', () => {
  // 目前沒有外部來源(BPM 不送 Webhook):測試時建立臨時來源 e2etest 與其密鑰,結束後刪除
  const SOURCE = 'e2etest';
  const secretFile = `${process.env.E2E_SECRETS_DIR ?? '/srv/giganexus/deploy/secrets'}/webhook/${SOURCE}`;
  const secret = randomBytes(32).toString('hex');
  beforeAll(async () => {
    await remote(
      [
        `mkdir -p "$(dirname ${secretFile})"`,
        `printf '%s' '${secret}' > ${secretFile}`,
        `chown -R 1000:1000 "$(dirname ${secretFile})"`,
        `chmod 400 ${secretFile}`,
      ].join('\n'),
    );
    await cliApply(
      `webhooks:\n  - source: ${SOURCE}\n    verifyMethod: hmac_sha256\n    secretRef: ${SOURCE}\n    dispatchType: queue\n    dispatchTarget: ${SOURCE}\n`,
    );
  });
  afterAll(async () => {
    await remote(`rm -f ${secretFile}\nrmdir "$(dirname ${secretFile})" 2>/dev/null || true`);
  });

  const send = (opts: { offsetSec?: number; badSig?: boolean; key?: string; source?: string } = {}) => {
    const body = JSON.stringify({ eventType: 'e2e.test', formNo: 'E2E-WH' });
    const ts = String(Math.floor(Date.now() / 1000) + (opts.offsetSec ?? 0));
    const sig =
      'sha256=' +
      createHmac('sha256', opts.badSig ? 'wrong-secret' : secret)
        .update(`${ts}.${body}`)
        .digest('hex');
    return bffInternal(`/webhook/${opts.source ?? SOURCE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gw-timestamp': ts, 'x-gw-signature': sig, 'idempotency-key': opts.key ?? `e2e-${randomUUID()}` },
      body,
    });
  };

  it('合法請求 200,記錄 verified = 1,worker 處理後 processed_at 有值', async () => {
    const res = await send();
    expect(res.status).toBe(200);
    const row = await waitFor(async () => {
      const [r] = await query('SELECT verified, status_code, processed_at FROM gw.webhook_log WHERE log_id = @id', { id: res.json.logId });
      return r?.processed_at && r;
    });
    expect(row).toMatchObject({ verified: true, status_code: 200 });
  });

  it('簽章錯誤 → 401;時間戳超出 ±5 分鐘 → 401', async () => {
    expect((await send({ badSig: true })).json.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect((await send({ offsetSec: -240 })).status).toBe(200);
    expect((await send({ offsetSec: -360 })).json.code).toBe('WEBHOOK_TIMESTAMP_INVALID');
    expect((await send({ offsetSec: 360 })).json.code).toBe('WEBHOOK_TIMESTAMP_INVALID');
  });

  it('相同 Idempotency-Key 只處理一次;未設定的來源 404', async () => {
    const key = `e2e-${randomUUID()}`;
    expect((await send({ key })).status).toBe(200);
    expect((await send({ key })).json.code).toBe('DUPLICATE_REQUEST');
    expect((await send({ source: 'line' })).json.code).toBe('WEBHOOK_SOURCE_NOT_FOUND');
  });
});
