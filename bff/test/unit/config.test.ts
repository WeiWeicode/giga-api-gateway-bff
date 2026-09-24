import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, readSecret } from '../../src/config.js';

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
});
