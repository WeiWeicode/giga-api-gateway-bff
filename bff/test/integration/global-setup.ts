import { applyTestEnv } from './test-env.js';
import { resetTestDatabase } from '../../scripts/reset-test-db.js';
import { runSeed } from '../../src/db/seed.js';
import { loadConfig } from '../../src/config.js';
import { createGwDb, openPool } from '../../src/db/client.js';

/** 每次整合測試開始前:清空測試庫 → 套用 migration → 匯入 seed。 */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();
  await resetTestDatabase();
  const config = loadConfig();
  const pool = await openPool(config.gwDb, { appName: 'giganexus-gw-test-setup', poolMax: 1 });
  try {
    await runSeed(createGwDb(pool, 'error'));
  } finally {
    await pool.close();
  }
}
