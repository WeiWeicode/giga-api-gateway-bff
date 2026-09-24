/**
 * E2E 測試工具:經 Nginx(https://localhost)呼叫,模擬瀏覽器的 Cookie 行為。
 * 需先以 deploy/dev/up.sh 啟動本機完整環境。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import sql from 'mssql';
import { Agent, fetch, type RequestInit } from 'undici';

const exec = promisify(execFile);
export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const BASE = process.env.E2E_BASE_URL ?? 'https://localhost';
export const CA = readFileSync(`${REPO}deploy/dev/secrets/pki/ca.crt`);
export const PKI = `${REPO}deploy/dev/secrets/pki`;
export const PASSWORD = 'Passw0rd!';

export const agent = new Agent({ connect: { ca: CA }, allowH2: true });

export interface Cookie {
  value: string;
  attrs: string;
}

/** 以 Cookie jar 模擬一個瀏覽器工作階段 */
export class Session {
  readonly cookies = new Map<string, Cookie>();

  cookieHeader(path = '/'): string {
    return [...this.cookies]
      .filter(([, c]) => {
        const p = /Path=([^;]+)/i.exec(c.attrs)?.[1] ?? '/';
        return path.startsWith(p);
      })
      .map(([k, c]) => `${k}=${c.value}`)
      .join('; ');
  }

  get csrf(): string | undefined {
    return this.cookies.get('gn_csrf')?.value;
  }

  /**
   * 送出請求。/api/auth/* 遇到 Nginx 登入限流(429 RATE_LIMITED)時稍候重試,避免測試連續登入互相干擾;
   * 驗證限流本身的測試以 noRetry 關閉。
   */
  async request(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; csrf?: boolean; noRetry?: boolean } = {},
  ): Promise<Awaited<ReturnType<Session['send']>>> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.send(method, path, opts);
      if (opts.noRetry || res.status !== 429 || res.json?.code !== 'RATE_LIMITED' || !path.startsWith('/api/auth/') || attempt >= 10) return res;
      await sleep(150);
    }
  }

  private async send(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; csrf?: boolean }) {
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    const cookie = this.cookieHeader(path.split('?')[0]);
    if (cookie) headers.cookie = cookie;
    if (opts.csrf !== false && !['GET', 'HEAD'].includes(method) && this.csrf) headers['x-csrf-token'] = this.csrf;
    const init: RequestInit = { method, headers, dispatcher: agent, redirect: 'manual' };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(BASE + path, init);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const [name, ...v] = pair!.split('=');
      const value = v.join('=');
      if (/Max-Age=0/i.test(sc) || value === '') this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), { value, attrs: attrs.join(';') });
    }
    const text = await res.text();
    const json: any = parseJson(text);
    return { status: res.status, headers: res.headers, text, json, setCookies: res.headers.getSetCookie() };
  }

  get = (path: string, headers?: Record<string, string>) => this.request('GET', path, { headers });
  post = (path: string, body?: unknown, opts: { headers?: Record<string, string>; csrf?: boolean; noRetry?: boolean } = {}) =>
    this.request('POST', path, { ...opts, body });
}

export async function login(username: string, password = PASSWORD, remember = false) {
  const s = new Session();
  const res = await s.post('/api/auth/login', { username, password, remember });
  return { s, res };
}

/** docker compose(本機完整環境) */
export async function compose(...args: string[]): Promise<string> {
  const { stdout } = await exec('docker', ['compose', '--env-file', 'dev.env', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml', ...args], {
    cwd: `${REPO}deploy`,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/** 在 bff-1 容器內執行管理 CLI,回傳 JSON 輸出 */
export async function cli(...args: string[]): Promise<any> {
  const out = await compose('exec', '-T', 'bff-1', 'node', 'dist/bff/src/cli/index.js', ...args, '--actor', 'e2e');
  return JSON.parse(out);
}

export async function bffReadyz(instance: 'bff-1' | 'bff-2'): Promise<any> {
  return JSON.parse(await compose('exec', '-T', instance, 'wget', '-qO-', 'http://127.0.0.1:3000/readyz'));
}

/** 直連模擬後端的測試控制端點(不經 Gateway) */
export async function mock(port: number, path: string, body?: unknown): Promise<any> {
  const res = await fetch(
    `http://127.0.0.1:${port}${path}`,
    body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return res.json();
}

let redisClient: Redis | null = null;
export function redis(): Redis {
  redisClient ??= new Redis('redis://127.0.0.1:16379', { maxRetriesPerRequest: 1 });
  return redisClient;
}

let pool: sql.ConnectionPool | null = null;
export async function db(): Promise<sql.ConnectionPool> {
  if (!pool) {
    pool = new sql.ConnectionPool({
      server: '127.0.0.1',
      port: 1433,
      database: 'giganexus_gw',
      user: 'gw_app',
      password: 'GwApp_Passw0rd!',
      options: { encrypt: false, trustServerCertificate: true },
    });
    await pool.connect();
  }
  return pool;
}

export async function query<T = any>(text: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const req = (await db()).request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  return (await req.query(text)).recordset as T[];
}

export async function closeAll(): Promise<void> {
  redisClient?.disconnect();
  redisClient = null;
  await pool?.close();
  pool = null;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 清除登入失敗計數(模擬 15 分鐘已過) */
export async function clearLoginFails(emp: string): Promise<void> {
  const keys = await redis().keys('gw:login:fail:*');
  const mine = keys.filter((k) => k.endsWith(`:${emp}`) || k.includes(':ip:'));
  if (mine.length) await redis().del(...mine);
}
