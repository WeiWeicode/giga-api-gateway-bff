/**
 * nginx-log-agent 自我檢查:node --test nginx/log-agent/
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Aggregator, isInternalIp, normalizePath, Tailer } from './agent.mjs';

const line = (o) =>
  JSON.stringify({ time: '2026-10-06T08:15:10+08:00', request_id: 'r', remote_addr: '10.10.112.50', host: 'h', method: 'GET', uri: '/api/it/x', status: 200, bytes: 100, request_time: 0.012, ...o });

describe('彙總', () => {
  it('同一分鐘合併:狀態碼、401/403/429、IP 與路徑排行、p95', () => {
    const agg = new Aggregator();
    for (let i = 0; i < 18; i++) agg.line(line({ request_time: 0.01 + i * 0.001 }));
    agg.line(line({ status: 429, remote_addr: '10.10.112.99' }));
    agg.line(line({ status: 502, uri: '/api/admin/users/123?x=1', request_time: 1.5 }));
    agg.line('not json');
    agg.line('');
    const [m] = agg.drain(Date.parse('2026-10-06T00:20:00Z'));
    assert.equal(m.ts, '2026-10-06T00:15:00.000Z');
    assert.equal(m.total, 20);
    assert.deepEqual(m.status, { '2xx': 18, '4xx': 1, '5xx': 1 });
    assert.deepEqual(m.codes, { 429: 1, 502: 1 });
    assert.equal(m.uniqueIps, 2);
    assert.deepEqual(m.topIps[0], { ip: '10.10.112.50', count: 19, errors: 1, denied: 0 });
    assert.deepEqual(m.topIps[1], { ip: '10.10.112.99', count: 1, errors: 0, denied: 1 });
    assert.deepEqual(m.topPaths.find((p) => p.path === '/api/admin/users/:id'), { path: '/api/admin/users/:id', count: 1, errors: 1 });
    assert.equal(m.p95Ms, 1500);
    assert.equal(m.realIp, true);
    assert.equal(agg.skipped, 1);
  });

  it('尚未結束(含 10 秒緩衝)的分鐘不送', () => {
    const agg = new Aggregator();
    agg.line(line({ time: '2026-10-06T00:15:59Z' }));
    assert.equal(agg.drain(Date.parse('2026-10-06T00:16:05Z')).length, 0);
    assert.equal(agg.drain(Date.parse('2026-10-06T00:16:11Z')).length, 1);
  });

  it('多數來自 Docker 網段 → realIp = false(沒走 PROXY protocol)', () => {
    const agg = new Aggregator();
    agg.line(line({ remote_addr: '172.18.0.1' }));
    agg.line(line({ remote_addr: '172.18.0.1' }));
    agg.line(line({ remote_addr: '10.1.1.1' }));
    assert.equal(agg.drain(Date.parse('2026-10-06T01:00:00Z'))[0].realIp, false);
    assert.equal(isInternalIp('172.31.255.1'), true);
    assert.equal(isInternalIp('10.10.112.50'), false);
  });

  it('路徑正規化:去 query、數字 / UUID / ObjectId 換 :id', () => {
    assert.equal(normalizePath('/api/admin/roles/12/permissions?x=1'), '/api/admin/roles/:id/permissions');
    assert.equal(normalizePath('/api/observe/logs/6512ab34cd56ef7890123456'), '/api/observe/logs/:id');
    assert.equal(normalizePath('/x/0b6c2a2e-1d2f-4c3b-9a8e-123456789abc'), '/x/:id');
  });
});

describe('增量讀檔', () => {
  it('只讀新增的完整行;檔案被截斷後從頭讀;超過上限時截斷', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'nla-')), 'access.json');
    writeFileSync(file, `${line()}\n${line()}\n{"partial":`);
    const t = new Tailer(file, 10 * 1024 * 1024);
    assert.equal(t.read().length, 2);
    appendFileSync(file, '1}\n');
    assert.deepEqual(t.read(), ['{"partial":1}']);
    writeFileSync(file, `${line()}\n`);
    assert.equal(t.read().length, 1);
    const small = new Tailer(file, 10);
    small.read();
    assert.equal(statSync(file).size, 0);
  });
});
