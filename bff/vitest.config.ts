import { defineConfig } from 'vitest/config';
import NameSequencer from './test/e2e/sequencer.js';

export default defineConfig({
  test: {
    // E2E 依檔名順序執行;sequencer 只能設定在根層
    sequence: { sequencer: NameSequencer },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // 需要 SQL Server:公司開發機以 .env 指向 2012 測試庫(.env.example 的 GW_TEST_DB_NAME,會清空重建)
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/integration/global-setup.ts'],
          setupFiles: ['test/integration/setup-env.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
      {
        // 對測試區的端到端測試(IMPL-PLAN §6「端到端」):經 https://giganexus-test.gigasolar.com.tw,CLI / Redis 經 ssh host2(README「測試」)
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
