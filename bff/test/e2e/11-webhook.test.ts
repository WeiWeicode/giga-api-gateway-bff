/**
 * docs/Gherkin/webhook/webhook.feature(W3-5.10):經 Nginx 從模擬 BPM 主機(172.30.0.50,白名單內)送出。
 * 前置:本機環境的 bff 容器有 /run/secrets/gw/webhook/bpm(deploy/dev/up.sh 產生)且有 worker 容器。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cli, closeAll, compose, query, sleep } from './gw.js';

let secret = '';

/** 在模擬 BPM 主機內送出 Webhook,回傳 { status, body } */
async function send(opts: { offsetSec?: number; badSig?: boolean; key?: string; source?: string } = {}) {
  const body = JSON.stringify({ eventType: 'approval.completed', formNo: 'LV-E2E-001', applicant: 'S112009' });
  const ts = String(Math.floor(Date.now() / 1000) + (opts.offsetSec ?? 0));
  const sig =
    'sha256=' +
    createHmac('sha256', opts.badSig ? 'wrong-secret' : secret)
      .update(`${ts}.${body}`)
      .digest('hex');
  const headers = { 'content-type': 'application/json', 'x-gw-timestamp': ts, 'x-gw-signature': sig, 'idempotency-key': opts.key ?? randomUUID() };
  const script = `fetch('https://nginx/webhook/${opts.source ?? 'bpm'}',{method:'POST',headers:${JSON.stringify(headers)},body:${JSON.stringify(body)}})
    .then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))`;
  const out = await compose('exec', '-T', '-e', 'NODE_TLS_REJECT_UNAUTHORIZED=0', 'mock-bpm', 'node', '-e', script);
  return JSON.parse(out.trim()) as { status: number; body: any };
}

beforeAll(async () => {
  secret = (await compose('exec', '-T', 'bff-1', 'cat', '/run/secrets/gw/webhook/bpm')).replace(/\r?\n$/, '');
  const yaml = 'webhooks:\n  - source: bpm\n    verifyMethod: hmac_sha256\n    secretRef: bpm\n    dispatchType: queue\n    dispatchTarget: bpm\n';
  await compose('exec', '-T', 'bff-1', 'sh', '-c', `cat > /tmp/e2e-webhook.yaml <<'EOF'\n${yaml}EOF`);
  await cli('apply', '--file', '/tmp/e2e-webhook.yaml');
});
afterAll(closeAll);

describe('BPM Webhook 接收', () => {
  it('合法請求立即回 200,記錄 verified = 1 並排入佇列由 worker 處理', async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true });
    const logId = res.body.logId as number;
    let row: any;
    for (let i = 0; i < 50; i++) {
      [row] = await query('SELECT verified, status_code, processed_at FROM gw.webhook_log WHERE log_id = @id', { id: logId });
      if (row?.processed_at) break;
      await sleep(100);
    }
    expect(row).toMatchObject({ verified: true, status_code: 200 });
    expect(row.processed_at).not.toBeNull();
  });

  it('簽章錯誤 → 401 WEBHOOK_SIGNATURE_INVALID,記錄 verified = 0', async () => {
    const key = `e2e-badsig-${randomUUID()}`;
    const res = await send({ badSig: true, key });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    const [row] = await query('SELECT verified, processed_at FROM gw.webhook_log WHERE idempotency_key = @key', { key });
    expect(row).toMatchObject({ verified: false, processed_at: null });
  });

  it.each([
    ['4 分鐘前', -240, 200],
    ['6 分鐘前', -360, 401],
    ['6 分鐘後', 360, 401],
  ])('時間戳 %s → %i', async (_name, offsetSec, status) => {
    const res = await send({ offsetSec });
    expect(res.status).toBe(status);
    if (status === 401) expect(res.body.code).toBe('WEBHOOK_TIMESTAMP_INVALID');
  });

  it('相同 Idempotency-Key 在 24 小時內只處理一次', async () => {
    const key = `bpm-evt-${randomUUID()}`;
    expect((await send({ key })).status).toBe(200);
    const again = await send({ key });
    expect(again.status).toBe(200);
    expect(again.body.code).toBe('DUPLICATE_REQUEST');
    // 只有第一筆入列;重送只留紀錄(error_message = DUPLICATE_REQUEST)
    const rows = await query<{ error_message: string | null }>('SELECT error_message FROM gw.webhook_log WHERE idempotency_key = @key ORDER BY log_id', {
      key,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.error_message).toBe('DUPLICATE_REQUEST');
    expect(rows[0]!.error_message).not.toBe('DUPLICATE_REQUEST');
  });

  it('未設定的來源 → 404 WEBHOOK_SOURCE_NOT_FOUND', async () => {
    const res = await send({ source: 'line' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WEBHOOK_SOURCE_NOT_FOUND');
  });
});
