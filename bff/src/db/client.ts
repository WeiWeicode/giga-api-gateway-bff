/**
 * 連線池(TECH-STACK.md §4):每個資料庫一個長期連線池,不在每次請求建立連線(REFERENCES.md §1.4)。
 *   - giganexus_gw:讀寫,每個 BFF 實例 max 10
 *   - LOS / BPM / PortalSolar:唯讀,每實例 max 3(登入補查、舊帳號遷移);worker 另設
 */
import sql from 'mssql';
import { drizzle, type NodeMsSqlDatabase } from 'drizzle-orm/node-mssql';
import type { Logger as DrizzleLogger } from 'drizzle-orm/logger';
import type { SqlSourceConfig } from '../config.js';
import * as schema from './schema/index.js';
import { findSql2012Violations, Sql2012CompatError } from './sql2012-guard.js';

export type GwDatabase = NodeMsSqlDatabase<typeof schema>;

export interface PoolOptions {
  appName: string;
  poolMax: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** 以 GeneralBackend 已驗證的 tedious 參數為基準(REFERENCES.md §1.1)。 */
export function toMssqlConfig(src: SqlSourceConfig, opts: PoolOptions): sql.config {
  return {
    server: src.host,
    port: src.port,
    database: src.database,
    user: src.user,
    password: src.password,
    connectionTimeout: opts.connectTimeoutMs ?? 15_000,
    requestTimeout: opts.requestTimeoutMs ?? 30_000,
    pool: { min: 0, max: opts.poolMax, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: src.encrypt,
      trustServerCertificate: src.trustServerCertificate,
      appName: opts.appName,
      useUTC: true,
      enableArithAbort: true,
    },
  };
}

export async function openPool(src: SqlSourceConfig, opts: PoolOptions): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool(toMssqlConfig(src, opts));
  await pool.connect();
  return pool;
}

export type Sql2012GuardMode = 'off' | 'warn' | 'error';

/**
 * 開發 / 測試用 logger:檢查 Drizzle 產生的每一句 SQL 是否含 2012 不支援的語法。
 * mode=error 時直接丟出例外,讓整合測試失敗。
 */
export class Sql2012GuardLogger implements DrizzleLogger {
  constructor(
    private readonly mode: Exclude<Sql2012GuardMode, 'off'>,
    private readonly warn: (msg: string, sql: string) => void = (msg, q) => console.warn(msg, q),
  ) {}

  logQuery(query: string): void {
    const violations = findSql2012Violations(query);
    if (violations.length === 0) return;
    const err = new Sql2012CompatError(violations, query);
    if (this.mode === 'error') throw err;
    this.warn(err.message, query);
  }
}

export function createGwDb(pool: sql.ConnectionPool, guard: Sql2012GuardMode = 'off'): GwDatabase {
  return drizzle({
    client: pool,
    schema,
    ...(guard === 'off' ? {} : { logger: new Sql2012GuardLogger(guard) }),
  });
}
