import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'db/migrations/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // 測試檔以 any 表示任意 JSON 回應
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // k6 腳本(test/k6,W3-5.12)由 k6 執行,使用 k6 的全域變數
    files: ['test/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __ITER: 'readonly', __VU: 'readonly', console: 'readonly' } },
  },
);
