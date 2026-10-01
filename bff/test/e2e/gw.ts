/**
 * E2E 測試工具:對**測試區**執行(README「測試」)。
 *
 *   HTTP      經 Nginx:E2E_BASE_URL(預設 https://giganexus-test.gigasolar.com.tw,公司憑證),以 Cookie jar 模擬瀏覽器
 *   CLI/Redis 經 `ssh <E2E_SSH_HOST>`(預設 host2)在測試區容器內執行(WSL root,AGENT.md 工作區 §5)
 *   資料庫    以 bff/.env 的 GW_DB_* 直連 giganexus_gw_test(與測試區共用)
 *
 * 測試帳號一律以假工號(Z99E2E 開頭)自行建立本機帳號,不使用真實員工帳密;角色 / API Key / 範本以 e2e 開頭,結束時由 cleanupE2E 刪除。
 */
import { spawn } from 'node:child_process';
import sql from 'mssql';

try {
  process.loadEnvFile('.env');
} catch {
  // CI 以環境變數提供
}

export const BASE = process.env.E2E_BASE_URL ?? 'https://giganexus-test.gigasolar.com.tw';
export const HOST = new URL(BASE).hostname;
export const GATEWAY_IP = process.env.E2E_GATEWAY_IP ?? '10.10.130.124';
const SSH_HOST = process.env.E2E_SSH_HOST ?? 'host2';
export const BFF = process.env.E2E_BFF_CONTAINER ?? 'giganexus-gw-bff-1-1';
const REDIS = process.env.E2E_REDIS_CONTAINER ?? 'giganexus-gw-redis-1';

/** 假工號前綴(LOS / BPM 不存在) */
export const EMP_PREFIX = 'Z99E2E';
export const PASSWORD = 'E2eTest2026';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  setCookies: string[];
}

/** 以 Cookie jar 模擬一個瀏覽器工作階段 */
export interface Cookie {
  value: string;
  attrs: string;
}

export class Session {
  readonly cookies = new Map<string, Cookie>();

  /** 依 Cookie 的 Path 決定是否送出(gn_rt 只送 /api/auth、gn_pwchg 只送 /api/auth/password) */
  cookieHeader(path: string): string {
    return [...this.cookies]
      .filter(([, c]) => path.startsWith(/Path=([^;]+)/i.exec(c.attrs)?.[1]?.trim() ?? '/'))
      .map(([k, c]) => `${k}=${c.value}`)
      .join('; ');
  }

  get csrf(): string | undefined {
    return this.cookies.get('gn_csrf')?.value;
  }

  async request(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {}): Promise<Res> {
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    const cookie = this.cookieHeader(path.split('?')[0]!);
    if (cookie) headers.cookie = cookie;
    if (opts.csrf !== false && !['GET', 'HEAD'].includes(method) && this.csrf) headers['x-csrf-token'] = this.csrf;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1);
      if (/Max-Age=0/i.test(sc) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, { value, attrs: attrs.join(';') });
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: parseJson(text), setCookies };
  }

  get = (path: string, headers?: Record<string, string>) => this.request('GET', path, { headers });
  post = (path: string, body?: unknown, opts: { headers?: Record<string, string>; csrf?: boolean } = {}) => this.request('POST', path, { ...opts, body });
}

/** 不帶 Cookie、以 API Key 呼叫 */
export function apiKeyCall(key: string) {
  const s = new Session();
  return (method: string, path: string, body?: unknown) => s.request(method, path, { body, headers: { 'x-api-key': key } });
}

export async function login(username: string, password = PASSWORD) {
  const s = new Session();
  const res = await s.post('/api/auth/login', { username, password });
  return { s, res };
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/* ---------- 測試區主機(ssh) ---------- */

const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** 在測試區主機(WSL root)執行 sh 腳本,回傳 stdout;非 0 結束時丟出含 stderr 的錯誤 */
export function remote(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', SSH_HOST, 'wsl -u root -e sh -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    p.on('error', reject);
    p.on('close', (code) => {
      out = out.replace(/\0/g, '');
      if (code === 0) resolve(out);
      else reject(new Error(`遠端指令失敗(${code}):${err.replace(/\0/g, '').trim() || out.trim()}`));
    });
    p.stdin.end(`set -e\n${script}\n`);
  });
}

/** 在測試區 bff 容器內執行管理 CLI,回傳 JSON 輸出 */
export async function cli(...args: string[]): Promise<any> {
  const out = await remote(`docker exec ${BFF} node dist/bff/src/cli/index.js ${args.map(q).join(' ')} --actor e2e`);
  return JSON.parse(out);
}

/** 以 CLI apply 套用 YAML(寫入 bff 容器的 /tmp 後執行) */
export async function cliApply(yaml: string): Promise<any> {
  const name = `/tmp/e2e-${Date.now()}.yaml`;
  await remote(`docker exec -i ${BFF} sh -c ${q(`cat > ${name}`)} <<'E2E_YAML'\n${yaml}\nE2E_YAML`);
  return cli('apply', '--file', name);
}

/** 測試區 Redis */
export async function redisCli(...args: string[]): Promise<string> {
  return (await remote(`docker exec ${REDIS} redis-cli ${args.map(q).join(' ')}`)).trim();
}

/** 刪除符合樣式的 Redis 鍵(限流計數等) */
export async function redisDelPattern(pattern: string): Promise<void> {
  await remote(`docker exec ${REDIS} sh -c ${q(`redis-cli --scan --pattern ${q(pattern)} | xargs -r redis-cli del >/dev/null`)}`);
}

/** 在 bff 容器內直接呼叫 BFF(不經 Nginx;Webhook 來源 IP 白名單在 Nginx) */
export async function bffInternal(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; json: any }> {
  const js = `fetch('http://127.0.0.1:3000${path}',${JSON.stringify({ method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })}).then(async r=>console.log(JSON.stringify({status:r.status,json:await r.json().catch(()=>null)})))`;
  return JSON.parse((await remote(`docker exec ${BFF} node -e ${q(js)}`)).trim());
}

/* ---------- 資料庫(giganexus_gw_test) ---------- */

let pool: sql.ConnectionPool | null = null;
export async function db(): Promise<sql.ConnectionPool> {
  if (!pool) {
    pool = new sql.ConnectionPool({
      server: process.env.GW_DB_HOST!,
      port: Number(process.env.GW_DB_PORT ?? 1433),
      database: process.env.GW_DB_NAME!,
      user: process.env.GW_DB_USER!,
      password: process.env.GW_DB_PASSWORD!,
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
  await pool?.close();
  pool = null;
}

/** 等待條件成立(每 500 ms 檢查) */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`等待逾時 ${timeoutMs} ms`);
    await sleep(500);
  }
}

/* ---------- 假帳號 ---------- */

/** 以自行註冊(LOS / BPM 查無 → 待審核)+ CLI local:approve + 啟用連結建立本機帳號 */
export async function createLocalUser(emp: string, name = `E2E ${emp}`, password = PASSWORD): Promise<number> {
  await redisDelPattern('gw:reg:*');
  const s = new Session();
  const r = await s.post('/api/auth/register', { employeeNo: emp, name });
  if (r.json?.code !== 'REGISTRATION_PENDING_APPROVAL') throw new Error(`註冊 ${emp} 失敗:${r.status} ${r.text}`);
  const { link } = await cli('local:approve', '--emp', emp);
  const token = new URL(link).searchParams.get('token')!;
  const v = await s.post('/api/auth/register/verify', { token, password });
  if (v.status !== 200) throw new Error(`啟用 ${emp} 失敗:${v.status} ${v.text}`);
  const [u] = await query<{ id: number }>('SELECT user_id AS id FROM gw.[user] WHERE employee_no = @emp', { emp });
  return u!.id;
}

/** 建立 API Key(明文只在 CLI 輸出出現一次) */
export async function createApiKey(code: string, perms: string[]): Promise<string> {
  const r = await cli('client:create', '--code', code, ...perms.flatMap((p) => ['--perm', p]));
  return r.key as string;
}

/** 刪除 E2E 建立的所有資料(假工號、E2E 公司、e2e 角色 / API Key / 權限 / 範本 / 上游 / 限流政策) */
export async function cleanupE2E(): Promise<void> {
  await query(`
    DECLARE @u TABLE (id INT);
    INSERT INTO @u SELECT user_id FROM gw.[user] WHERE employee_no LIKE '${EMP_PREFIX}%';
    DELETE FROM gw.local_account_token WHERE user_id IN (SELECT id FROM @u);
    DELETE FROM gw.local_credential WHERE user_id IN (SELECT id FROM @u);
    DELETE FROM gw.user_company WHERE user_id IN (SELECT id FROM @u);
    DELETE FROM gw.user_role WHERE user_id IN (SELECT id FROM @u);
    DELETE FROM gw.notify_message WHERE user_id IN (SELECT id FROM @u);
    DELETE FROM gw.[user] WHERE user_id IN (SELECT id FROM @u);

    DECLARE @c TABLE (id INT);
    INSERT INTO @c SELECT company_id FROM gw.company WHERE comp_name LIKE 'E2E%';
    DELETE FROM gw.company_ad_domain WHERE company_id IN (SELECT id FROM @c);
    DELETE FROM gw.role_company WHERE company_id IN (SELECT id FROM @c);
    DELETE FROM gw.user_company WHERE company_id IN (SELECT id FROM @c);
    DELETE FROM gw.company WHERE company_id IN (SELECT id FROM @c);

    DECLARE @r TABLE (id INT);
    INSERT INTO @r SELECT role_id FROM gw.role WHERE code LIKE 'e2e-%';
    DELETE FROM gw.role_rule WHERE role_id IN (SELECT id FROM @r);
    DELETE FROM gw.role_permission WHERE role_id IN (SELECT id FROM @r);
    DELETE FROM gw.role_ad_group WHERE role_id IN (SELECT id FROM @r);
    DELETE FROM gw.role_company WHERE role_id IN (SELECT id FROM @r);
    DELETE FROM gw.user_role WHERE role_id IN (SELECT id FROM @r);
    DELETE FROM gw.role WHERE role_id IN (SELECT id FROM @r);

    DELETE FROM gw.api_client_permission WHERE client_id IN (SELECT client_id FROM gw.api_client WHERE code LIKE 'e2e-%');
    DELETE FROM gw.api_client WHERE code LIKE 'e2e-%';

    DECLARE @up TABLE (id INT);
    INSERT INTO @up SELECT upstream_id FROM gw.upstream WHERE code LIKE 'e2e-%';
    DELETE s FROM gw.aggregate_step s JOIN gw.api_route r ON r.route_id = s.route_id WHERE r.upstream_id IN (SELECT id FROM @up) OR r.route_code LIKE 'e2ez.%';
    DELETE FROM gw.aggregate_step WHERE upstream_id IN (SELECT id FROM @up);
    DELETE FROM gw.api_route WHERE upstream_id IN (SELECT id FROM @up) OR route_code LIKE 'e2ez.%';
    DELETE FROM gw.rate_limit_policy WHERE code LIKE 'e2e-%';
    DELETE i FROM gw.api_import_item i JOIN gw.api_import_batch b ON b.batch_id = i.batch_id WHERE b.upstream_id IN (SELECT id FROM @up) OR b.file_name LIKE 'registration:e2e-%';
    DELETE FROM gw.api_import_batch WHERE upstream_id IN (SELECT id FROM @up) OR file_name LIKE 'registration:e2e-%';
    DELETE FROM gw.upstream_target WHERE upstream_id IN (SELECT id FROM @up);
    DELETE FROM gw.upstream WHERE upstream_id IN (SELECT id FROM @up);

    DELETE rp FROM gw.role_permission rp JOIN gw.permission p ON p.permission_id = rp.permission_id WHERE p.code LIKE 'e2e%.%';
    DELETE ap FROM gw.api_client_permission ap JOIN gw.permission p ON p.permission_id = ap.permission_id WHERE p.code LIKE 'e2e%.%';
    DELETE FROM gw.permission WHERE code LIKE 'e2e%.%';
    DELETE FROM gw.notify_log WHERE template_code LIKE 'E2E_%';
    DELETE l FROM gw.webhook_log l JOIN gw.webhook_endpoint e ON e.endpoint_id = l.endpoint_id WHERE e.source_code LIKE 'e2e%';
    DELETE FROM gw.webhook_endpoint WHERE source_code LIKE 'e2e%';
    DELETE FROM gw.notify_template WHERE code LIKE 'E2E_%';
  `);
  await redisDelPattern('gw:reg:*');
}
