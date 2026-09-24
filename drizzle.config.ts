// drizzle-kit 設定(TECH-STACK.md §2)。只用於 `drizzle-kit generate`(離線比對 schema 快照,不連資料庫);
// 由 bff/ 執行:`npm run db:generate`。套用 migration 一律用 `npm run db:migrate`(Drizzle migrator),
// 禁止 drizzle-kit push(DATABASE.md §7.4)。外部資料庫(BPM / LOS / PortalSolar)的唯讀 schema 不在此設定內。
// 不 import drizzle-kit:此檔位於 repo 根目錄,套件安裝在 bff/node_modules。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default {
  dialect: 'mssql',
  schema: path.join(root, 'bff/src/db/schema/index.ts'),
  out: path.join(root, 'db/migrations'),
  schemaFilter: ['gw'],
  breakpoints: true,
};
