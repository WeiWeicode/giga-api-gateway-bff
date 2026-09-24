/**
 * 靜態檢查 db/migrations/**\/migration.sql 是否含 SQL Server 2012 不支援的語法(DATABASE.md §0、§7.4)。
 * CI check 階段執行;有違規即以非 0 結束。
 *
 *   npm run db:check-2012            (預設檢查 ../db/migrations)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { findSql2012Violations } from '../src/db/sql2012-guard.js';

function collect(target: string): string[] {
  const st = statSync(target);
  if (st.isFile()) return target.endsWith('.sql') ? [target] : [];
  return readdirSync(target).flatMap((name) => collect(path.join(target, name)));
}

const targets = process.argv.slice(2);
const files = (targets.length ? targets : ['../db/migrations']).flatMap(collect).sort();

let failed = 0;
for (const file of files) {
  const violations = findSql2012Violations(readFileSync(file, 'utf8'));
  for (const v of violations) {
    failed++;
    console.error(`${file}:${v.line}  [${v.rule}] ${v.match}  — ${v.since} 起才支援;${v.hint}`);
  }
}

if (failed) {
  console.error(`\n共 ${failed} 處不相容 SQL Server 2012。`);
  process.exit(1);
}
console.log(`已檢查 ${files.length} 個檔案,未發現 SQL Server 2012 不支援的語法。`);
