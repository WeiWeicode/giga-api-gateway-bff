/**
 * 清空整合測試庫(GW_TEST_DB_NAME,預設 giganexus_gw_test)的 schema gw 與 migration 紀錄,再重新套用 migration。
 * 只允許對名稱含 `_test` 的資料庫執行,避免誤刪。
 */
import { loadConfig, readSecret } from '../src/config.js';
import { openPool } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

export async function resetTestDatabase(): Promise<string> {
  const config = loadConfig();
  const database = process.env.GW_TEST_DB_NAME ?? 'giganexus_gw_test';
  if (!database.includes('_test')) throw new Error(`拒絕重設非測試庫:${database}`);

  const pool = await openPool(
    {
      ...config.gwDb,
      database,
      user: process.env.GW_MIGRATE_USER ?? config.gwDb.user,
      password: readSecret(process.env, 'GW_MIGRATE_PASSWORD') ?? config.gwDb.password,
    },
    { appName: 'giganexus-gw-reset-test', poolMax: 1 },
  );
  try {
    // 先刪 FK,再刪 gw 下所有資料表;最後刪 migration 紀錄(2012 語法,不用 DROP ... IF EXISTS)
    await pool.request().batch(`
      DECLARE @stmt NVARCHAR(MAX) = N'';
      SELECT @stmt = @stmt + N'ALTER TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name)
                   + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(10)
      FROM sys.foreign_keys fk
      JOIN sys.tables t ON t.object_id = fk.parent_object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = N'gw';
      EXEC sp_executesql @stmt;

      SET @stmt = N'';
      SELECT @stmt = @stmt + N'DROP TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N';' + CHAR(10)
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name IN (N'gw', N'drizzle');
      EXEC sp_executesql @stmt;
    `);
  } finally {
    await pool.close();
  }
  await runMigrations({ database });
  return database;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  resetTestDatabase()
    .then((db) => console.log(`已重建 ${db}`))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
