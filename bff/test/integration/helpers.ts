import type sql from 'mssql';
import { loadConfig, readSecret, type AppConfig } from '../../src/config.js';
import { createGwDb, openPool, type GwDatabase } from '../../src/db/client.js';

export interface TestDb {
  config: AppConfig;
  pool: sql.ConnectionPool;
  db: GwDatabase;
  close(): Promise<void>;
}

/** 以 BFF 帳號(gw_app)連整合測試庫,執行期 SQL 皆經 2012 語法檢查(error)。 */
export async function openTestDb(poolMax = 10): Promise<TestDb> {
  const config = loadConfig();
  const pool = await openPool(config.gwDb, { appName: 'giganexus-gw-test', poolMax });
  return { config, pool, db: createGwDb(pool, 'error'), close: () => pool.close() };
}

let seq = 0;
/** 產生測試資料用的唯一代碼,避免測試之間互相影響。 */
export function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/** migration 專用帳號(DDL 權限)的連線池;BFF 帳號無權讀取 drizzle schema。 */
export async function openMigratePool(): Promise<sql.ConnectionPool> {
  const config = loadConfig();
  return openPool(
    {
      ...config.gwDb,
      user: process.env.GW_MIGRATE_USER ?? config.gwDb.user,
      password: readSecret(process.env, 'GW_MIGRATE_PASSWORD') ?? config.gwDb.password,
    },
    { appName: 'giganexus-gw-test-migrate', poolMax: 1 },
  );
}
