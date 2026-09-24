/**
 * 套用 db/migrations(Drizzle migrator)。部署時以一次性容器執行:`docker compose run --rm migrate`
 * (DEPLOYMENT.md §3.2);失敗即以非 0 結束,中止部署。
 *
 * 使用 migration 專用帳號(GW_MIGRATE_USER / GW_MIGRATE_PASSWORD[_FILE]);未設定時沿用 GW_DB_USER。
 * 可用 GW_DB_NAME 覆寫目標資料庫(例:整合測試庫)。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-mssql/migrator';
import { loadConfig, readSecret } from '../config.js';
import { createGwDb, openPool } from './client.js';

export const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

export async function runMigrations(opts: { database?: string; migrationsFolder?: string } = {}): Promise<void> {
  const config = loadConfig();
  const user = process.env.GW_MIGRATE_USER ?? config.gwDb.user;
  const password = readSecret(process.env, 'GW_MIGRATE_PASSWORD') ?? config.gwDb.password;
  const pool = await openPool(
    { ...config.gwDb, user, password, database: opts.database ?? config.gwDb.database },
    { appName: 'giganexus-gw-migrate', poolMax: 1, requestTimeoutMs: 300_000 },
  );
  try {
    const db = createGwDb(pool);
    await migrate(db, { migrationsFolder: opts.migrationsFolder ?? process.env.MIGRATIONS_FOLDER ?? MIGRATIONS_FOLDER });
  } finally {
    await pool.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('migration 完成');
    })
    .catch((err: unknown) => {
      console.error('migration 失敗', err);
      process.exit(1);
    });
}
