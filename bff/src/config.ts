/**
 * 設定載入。
 *
 * - 非機密設定:環境變數(deploy/docker-compose*.yml)。
 * - 機密:Docker secret 檔案,以 `<NAME>_FILE` 指定路徑;本機開發可直接設 `<NAME>`(.env)。
 *   測試區 / 正式區不使用 .env(DEPLOYMENT.md §5)。
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

type Env = Record<string, string | undefined>;

/** 讀取 `<name>`;未設定時讀取 `<name>_FILE` 指向的檔案內容(去除結尾換行)。 */
export function readSecret(env: Env, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined && direct !== '') return direct;
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  return undefined;
}

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const sqlSource = (defaults: { encrypt: boolean }) =>
  z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().default(1433),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1),
    encrypt: bool.default(defaults.encrypt),
    trustServerCertificate: bool.default(false),
  });

export type SqlSourceConfig = z.infer<ReturnType<typeof sqlSource>>;

function sqlSourceFromEnv(env: Env, prefix: string) {
  return {
    host: env[`${prefix}_HOST`],
    port: env[`${prefix}_PORT`],
    database: env[`${prefix}_NAME`],
    user: env[`${prefix}_USER`],
    password: readSecret(env, `${prefix}_PASSWORD`),
    encrypt: env[`${prefix}_ENCRYPT`],
    trustServerCertificate: env[`${prefix}_TRUST_SERVER_CERT`],
  };
}

/** AD 網域設定(PRD §8.2.1,Q11):非機密部分放 JSON 檔(LDAP_DOMAINS_FILE),服務帳號密碼以 LDAP_<CODE>_BIND_PASSWORD[_FILE] 提供 */
const ldapDomainSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  netbios: z.string().min(1),
  upnSuffix: z.string().min(1),
  url: z.string().min(1),
  baseDN: z.string().min(1),
  bindDN: z.string().min(1),
  bindPassword: z.string().min(1),
  userAttribute: z.string().default('sAMAccountName'),
  timeoutMs: z.number().int().default(5000),
});
export type LdapDomainConfig = z.infer<typeof ldapDomainSchema>;

function loadLdapDomains(env: Env): unknown[] {
  const file = env.LDAP_DOMAINS_FILE;
  if (!file) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
  return raw.map((d) => ({ ...d, bindPassword: readSecret(env, `LDAP_${String(d.code).toUpperCase()}_BIND_PASSWORD`) }));
}

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  port: z.coerce.number().int().default(3000),
  /** giganexus_gw(SQL Server 2012):內網不加密(TECH-STACK.md §4) */
  gwDb: sqlSource({ encrypt: false }).extend({
    poolMax: z.coerce.number().int().default(10),
  }),
  /** LOS / PortalSolar(SQL Server 2012,唯讀):不加密;BPM(SQL Server 2019,唯讀):加密 */
  losDb: sqlSource({ encrypt: false }).optional(),
  bpmDb: sqlSource({ encrypt: true }).optional(),
  portalDb: sqlSource({ encrypt: false }).optional(),
  redisUrl: z.string().min(1),
  /** 執行期 SQL 的 2012 語法檢查;正式區關閉 */
  sql2012Guard: z.enum(['off', 'warn', 'error']).default('off'),
  /** 部署區:mock 路由僅 dev / test 可用(PRD §8.4.1);上游 target 依 environment 篩選(dev 視同 test) */
  gwEnv: z.enum(['dev', 'test', 'prod']).default('dev'),
  instanceId: z.string().min(1),
  /** JWT ES256 私鑰目錄:<kid>.pem;檔名排序最後者為簽章用,其餘僅供驗證(輪替,PRD §8.2.2) */
  jwtKeysDir: z.string().min(1),
  jwtActiveKid: z.string().optional(),
  /** 本機 http://localhost 開發時可關閉 Secure(瀏覽器視 localhost 為安全來源,仍建議保持 true) */
  cookieSecure: bool.default(true),
  /** 「記住我」僅限公司內網來源 IP(PRD Q4) */
  internalNetworks: z.string().default('10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'),
  /** 只接受這些來源(Nginx 所在的 Docker 網段)送來的 X-Forwarded-For;其他來源直接以連線位址為 req.ip */
  trustedProxies: z
    .string()
    .default('127.0.0.1/8,::1/128,172.16.0.0/12,192.168.0.0/16')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ldapDomains: z.array(ldapDomainSchema).default([]),
  /** 路由快照本地檔(Redis 與 SQL Server 皆不可用時的最後退路,PRD §8.4.2) */
  routeSnapshotFile: z.string().default('var/routes-snapshot.json'),
  /** 路由版本比對補償週期(DATABASE.md §7.3) */
  syncIntervalMs: z.coerce.number().int().default(60_000),
  /** /ws/endpoint/* 需要的權限(PRD §7.4) */
  endpointWsPermission: z.string().default('endpoint.remote.operate'),
  /** Webhook 密鑰目錄:檔名 = gw.webhook_endpoint.secret_ref(PRD §8.6) */
  webhookSecretsDir: z.string().default('/run/secrets/gw/webhook'),
  /** 入口網對外網址:註冊驗證、重設密碼連結(PRD §8.2.5) */
  publicBaseUrl: z.string().url().default('https://localhost'),
  /** SMTP(PRD §8.5,worker 使用);未設定 host 時 Email 通道發送失敗並記錄 */
  mail: z.object({
    host: z.string().optional(),
    port: z.coerce.number().int().default(25),
    secure: bool.default(false),
    user: z.string().optional(),
    password: z.string().optional(),
    from: z.string().default('GigaNexus <giganexus-noreply@gigasolar.com.tw>'),
    /** 測試區 / 開發:所有 Email 改寄到此信箱(DEPLOYMENT.md §5.1),主旨註明原收件人 */
    redirectTo: z.string().optional(),
    /** 每秒寄送上限(SMTP 伺服器限制) */
    ratePerSec: z.coerce.number().int().positive().default(10),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

function optionalSource(env: Env, prefix: string) {
  return env[`${prefix}_HOST`] ? sqlSourceFromEnv(env, prefix) : undefined;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const result = configSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
    gwDb: { ...sqlSourceFromEnv(env, 'GW_DB'), poolMax: env.GW_DB_POOL_MAX },
    losDb: optionalSource(env, 'LOS_DB'),
    bpmDb: optionalSource(env, 'BPM_DB'),
    portalDb: optionalSource(env, 'PORTAL_DB'),
    redisUrl: readSecret(env, 'REDIS_URL'),
    sql2012Guard: env.SQL2012_GUARD,
    gwEnv: env.GW_ENV,
    instanceId: env.BFF_INSTANCE_ID ?? env.HOSTNAME ?? 'bff',
    jwtKeysDir: env.JWT_KEYS_DIR,
    jwtActiveKid: env.JWT_ACTIVE_KID,
    cookieSecure: env.COOKIE_SECURE,
    internalNetworks: env.INTERNAL_NETWORKS,
    trustedProxies: env.TRUSTED_PROXIES,
    ldapDomains: loadLdapDomains(env),
    routeSnapshotFile: env.ROUTE_SNAPSHOT_FILE,
    syncIntervalMs: env.SYNC_INTERVAL_MS,
    endpointWsPermission: env.ENDPOINT_WS_PERMISSION,
    webhookSecretsDir: env.WEBHOOK_SECRETS_DIR,
    publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
    mail: {
      host: env.MAIL_HOST || undefined,
      port: env.MAIL_PORT,
      secure: env.MAIL_SECURE,
      user: env.MAIL_USER || undefined,
      password: readSecret(env, 'MAIL_PASSWORD'),
      from: env.MAIL_FROM || undefined,
      redirectTo: env.MAIL_REDIRECT_TO || undefined,
      ratePerSec: env.MAIL_RATE_PER_SEC,
    },
  });
  if (result.success && result.data.gwEnv !== 'prod' && result.data.mail.host && !result.data.mail.redirectTo) {
    // 測試區與開發不可寄給真實員工(DEPLOYMENT.md §5.1)
    throw new Error('設定錯誤:\n  - mail.redirectTo: GW_ENV 不是 prod 時,設定 MAIL_HOST 必須同時設定 MAIL_REDIRECT_TO');
  }
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`設定錯誤:\n${issues}`);
  }
  return result.data;
}
