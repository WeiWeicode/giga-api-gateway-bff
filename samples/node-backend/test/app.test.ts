/**
 * 樣本自我檢查:npm test
 *   - OpenAPI 符合 BACKEND-GUIDE.md §6.1(上架前自我檢查),且每個 operation 都有 description 與 x-gherkin
 *   - X-Internal-Token 驗證、資料層級權限與錯誤格式(§4.2、§5.3)
 *   - 部署區設定(dev / test / prod)
 *   - 開發專案:package.json gateway.project → 自動寫入 x-gateway.project(AGENT.md §0)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { autoRegister, withProject } from '@giganexus/backend-sdk';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/;

/** 模擬「複製後已命名」的 repo:只含 package.json 的暫存目錄 */
function repoDir(pkg: object): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-backend-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}
const named = repoDir({ gateway: { project: 'GigaSampleApp' } });

let app: FastifyInstance;
let jwks: http.Server;
let sign: (claims: Record<string, unknown>, aud?: string) => Promise<string>;

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256', use: 'sig' };
  jwks = http.createServer((_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`;
  sign = (claims, aud = 'node-sample') =>
    new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'test' }).setIssuer('giganexus-bff').setAudience(aud).setExpirationTime('60s').sign(privateKey);
  app = await buildApp(loadConfig({ GW_ENV: 'dev', SERVICE_CODE: 'node-sample', GW_JWKS_URL: jwksUrl, LOG_LEVEL: 'silent' }));
});

after(async () => {
  await app.close();
  jwks.close();
});

describe('OpenAPI(BACKEND-GUIDE.md §6.1)', () => {
  it('根層有 x-gateway 與 x-permissions;每個 operation 都有必填欄位、description 與 x-gherkin', async () => {
    const doc = (await app.inject('/openapi.json')).json();
    assert.deepEqual(doc['x-gateway'], { upstream: 'node-sample', system: 'sample', project: 'node-backend' });
    const declared = new Set(doc['x-permissions'].map((p: { code: string }) => p.code));
    const ops = Object.values(doc.paths as Record<string, Record<string, Record<string, unknown>>>).flatMap((p) => Object.values(p));
    assert.ok(ops.length > 0);
    for (const op of ops) {
      const id = String(op.operationId);
      assert.match(id, CODE, `operationId 格式:${id}`);
      assert.ok(op.summary, `${id} 缺少 summary`);
      assert.ok(typeof op.description === 'string' && op.description.length <= 1000, `${id} 缺少 description`);
      assert.ok(typeof op['x-gherkin'] === 'string' && /^場景[::]/m.test(op['x-gherkin']), `${id} 缺少 x-gherkin 場景`);
      const perm = op['x-permission'] as string;
      assert.ok(perm === 'public' || perm === 'authenticated' || declared.has(perm), `${id} 的 x-permission 未列在 x-permissions:${perm}`);
    }
    assert.equal(doc.paths['/healthz'], undefined, '健康檢查不應出現在 OpenAPI');
  });
});

describe('X-Internal-Token 與錯誤格式', () => {
  const get = async (url: string, token?: string) => app.inject({ url, headers: token ? { 'x-internal-token': token, 'x-request-id': 'req-1' } : {} });

  it('/healthz 不需 Token', async () => {
    assert.equal((await get('/healthz')).statusCode, 200);
  });

  it('缺少或 aud 不符的 Token 回 401', async () => {
    const res = await get('/v1/items');
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'SAMPLE_INTERNAL_TOKEN_INVALID');
    assert.equal((await get('/v1/items', await sign({ sub: '1', dept: 'S1800' }, 'go-mes'))).statusCode, 401);
  });

  it('依 Token 的 dept 過濾資料;其他部門回 403 DATA_ACCESS_DENIED', async () => {
    const token = await sign({ sub: '1', emp: 'S112009', dept: 'S1800' });
    const list = (await get('/v1/items', token)).json();
    assert.deepEqual(
      list.items.map((i: { dept: string }) => i.dept),
      ['S1800'],
    );
    const denied = await get('/v1/items/2', token);
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(denied.json(), { code: 'DATA_ACCESS_DENIED', message: '無權查看其他部門的資料', requestId: 'req-1' });
    assert.equal((await get('/v1/items/999', token)).json().code, 'SAMPLE_ITEM_NOT_FOUND');
  });

  it('驗證失敗回 400 VALIDATION_FAILED 並附 details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/items',
      headers: { 'x-internal-token': await sign({ sub: '1', emp: 'S112009', dept: 'S1800' }) },
      payload: { name: '' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'VALIDATION_FAILED');
    assert.ok(Array.isArray(res.json().details));
  });
});

describe('部署區設定', () => {
  const base = { SERVICE_CODE: 'node-sample', GW_BASE_URL: 'https://gw.example' };

  it('dev 不自動註冊', () => {
    assert.equal(loadConfig({ ...base, GW_ENV: 'dev' }).gateway.autoRegister, false);
  });

  it('test / prod 自動註冊,缺少必要設定時啟動失敗', () => {
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'test' }), /GW_API_KEY_FILE、SERVICE_ADVERTISE_URL/);
    const c = loadConfig({ ...base, GW_ENV: 'test', GW_API_KEY: 'k', SERVICE_ADVERTISE_URL: 'http://sample-host:51201' }, named);
    assert.equal(c.gateway.autoRegister, true);
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'test', GW_API_KEY: 'k', SERVICE_ADVERTISE_URL: 'http://sample-host:8080' }), /51200–51300/);
  });

  it('正式區不接受明文 GW_API_KEY', () => {
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'prod', GW_API_KEY: 'k', SERVICE_ADVERTISE_URL: 'http://h:51201' }), /GW_API_KEY_FILE/);
  });

  it('GW_ENV 只接受 dev / test / prod', () => {
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'product' }), /dev \/ test \/ prod/);
  });
});

describe('開發專案(AGENT.md §0)', () => {
  const base = { SERVICE_CODE: 'node-sample', GW_BASE_URL: 'https://gw.example' };
  const deploy = { ...base, GW_ENV: 'test', GW_API_KEY: 'k', SERVICE_ADVERTISE_URL: 'http://sample-host:51201' };

  it('由 package.json 的 gateway.project 讀取,並寫入 /openapi.json 的 x-gateway.project', async () => {
    assert.equal(loadConfig({ ...base, GW_ENV: 'dev' }).gateway.project, 'node-backend');
    assert.equal((await app.inject('/openapi.json')).json()['x-gateway'].project, 'node-backend');
  });

  it('package.json 沒有 gateway.project 或格式錯誤時啟動失敗', () => {
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'dev' }, repoDir({ name: 'x' })), /gateway.*project/);
    assert.throws(() => loadConfig({ ...base, GW_ENV: 'dev' }, repoDir({ gateway: { project: '../etc' } })), /gateway.*project/);
  });

  it('test / prod 仍是樣本預設值 node-backend 時啟動失敗', () => {
    assert.throws(() => loadConfig(deploy), /樣本預設值/);
    assert.equal(loadConfig(deploy, named).gateway.project, 'GigaSampleApp');
  });

  it('自動註冊時 SDK 寫入 x-gateway.project;OpenAPI 手寫不一致時拒絕', async () => {
    let body: { spec: Record<string, { project?: string }> } | undefined;
    const gw = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        body = JSON.parse(raw);
        res
          .setHeader('content-type', 'application/json')
          .end(JSON.stringify({ upstream: 'node-sample', created: 0, updated: 0, unchanged: 0, pendingPublish: false }));
      });
    });
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
      const env = loadConfig({ ...deploy, GW_BASE_URL: url }, named).gateway;
      await autoRegister({ env, spec: { 'x-gateway': { upstream: 'node-sample', system: 'sample' } }, retries: 0 });
      assert.equal(body?.spec['x-gateway']?.project, 'GigaSampleApp');
    } finally {
      gw.close();
    }
    assert.throws(() => withProject({ 'x-gateway': { project: 'Other' } }, 'GigaSampleApp'), /不一致/);
  });
});
