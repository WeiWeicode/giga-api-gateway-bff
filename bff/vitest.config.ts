import { defineConfig } from 'vitest/config';
import NameSequencer from './test/e2e/sequencer.js';

export default defineConfig({
  test: {
    // 依檔名順序執行(E2E 會中斷服務的韌性測試放在最後);sequencer 只能設定在根層
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
        // 需要 SQL Server 與 Redis:本機以 `npm run dev:env:up` 啟動(deploy/docker-compose.dev.yml)
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
        // 經 Nginx 的端到端測試(IMPL-PLAN §6「端到端」):需先以 deploy/dev/up.sh 啟動本機完整環境
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
