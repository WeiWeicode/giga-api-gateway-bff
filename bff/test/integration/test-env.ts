/**
 * 整合測試環境變數:讀 .env(若存在),並把目標資料庫切到整合測試庫、開啟 2012 語法檢查(error)。
 * CI 以環境變數直接提供,不需要 .env。
 */
export function applyTestEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // CI 無 .env
  }
  process.env.NODE_ENV = 'test';
  process.env.GW_DB_NAME = process.env.GW_TEST_DB_NAME ?? 'giganexus_gw_test';
  process.env.SQL2012_GUARD = 'error';
  process.env.LOG_LEVEL ??= 'warn';
}
