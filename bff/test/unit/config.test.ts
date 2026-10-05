import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig, readSecret } from '../../src/config.js';
import { companyOpen } from '../../src/modules/rbac/login-companies.js';

const base = {
  GW_DB_HOST: 'sql2012',
  GW_DB_NAME: 'giganexus_gw',
  GW_DB_USER: 'gw_app',
  GW_DB_PASSWORD: 'x',
  REDIS_URL: 'redis://redis:6379',
  JWT_KEYS_DIR: '/run/secrets/jwt',
};

describe('loadConfig', () => {
  it('giganexus_gw / LOS 預設不加密,BPM 預設加密', () => {
    const c = loadConfig({
      ...base,
      LOS_DB_HOST: 'sql2012',
      LOS_DB_NAME: 'LOS',
      LOS_DB_USER: 'r',
      LOS_DB_PASSWORD: 'p',
      BPM_DB_HOST: 'sql2019',
      BPM_DB_NAME: 'BPM',
      BPM_DB_USER: 'r',
      BPM_DB_PASSWORD: 'p',
    });
    expect(c.gwDb).toMatchObject({ encrypt: false, trustServerCertificate: false, port: 1433, poolMax: 10 });
    expect(c.losDb?.encrypt).toBe(false);
    expect(c.bpmDb?.encrypt).toBe(true);
    expect(c.portalDb).toBeUndefined();
    expect(c.sql2012Guard).toBe('off');
  });

  it('缺少必要設定時列出所有錯誤', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://x' })).toThrow(/gwDb\.host[\s\S]*gwDb\.password/);
  });

  it('機密可由 _FILE(Docker secret)讀取', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gw-secret-'));
    const file = path.join(dir, 'pw');
    writeFileSync(file, 's3cret\n');
    expect(readSecret({ GW_DB_PASSWORD_FILE: file }, 'GW_DB_PASSWORD')).toBe('s3cret');
    const { GW_DB_PASSWORD: _omit, ...rest } = base;
    expect(loadConfig({ ...rest, GW_DB_PASSWORD_FILE: file }).gwDb.password).toBe('s3cret');
  });

  it('只信任 TRUSTED_PROXIES 網段送來的 X-Forwarded-For', async () => {
    expect(loadConfig(base).trustedProxies).toEqual(['127.0.0.1/8', '::1/128', '172.16.0.0/12', '192.168.0.0/16']);
    const app = Fastify({ trustProxy: loadConfig({ ...base, TRUSTED_PROXIES: ' 172.30.0.0/24 , ::1/128 ' }).trustedProxies });
    app.get('/ip', async (req) => req.ip);
    const ip = (remoteAddress: string) => app.inject({ url: '/ip', remoteAddress, headers: { 'x-forwarded-for': '10.1.2.3' } }).then((r) => r.body);
    expect(await ip('172.30.0.5')).toBe('10.1.2.3');
    expect(await ip('::ffff:172.30.0.5')).toBe('10.1.2.3');
    // 直連 BFF(不經 Nginx)偽造的 X-Forwarded-For 不採用
    expect(await ip('10.9.9.9')).toBe('10.9.9.9');
  });

  it('LOGIN_COMPANIES:未設定不限公司;設定後只開放清單內的公司', () => {
    expect(loadConfig(base).loginCompanies).toEqual([]);
    const allowed = loadConfig({ ...base, LOGIN_COMPANIES: ' 碩禾 ,碩禾電子材料,, 禾迅 ' }).loginCompanies;
    expect(allowed).toEqual(['碩禾', '碩禾電子材料', '禾迅']);
    expect(companyOpen([], [])).toBe(true);
    expect(companyOpen(allowed, ['芯和', '禾迅'])).toBe(true);
    expect(companyOpen(allowed, ['國碩'])).toBe(false);
    // 沒有所屬公司資料的人員不開放
    expect(companyOpen(allowed, [])).toBe(false);
  });
});
