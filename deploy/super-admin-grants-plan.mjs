// gw-super-admin 權限合併計畫(唯讀;deploy/apply-super-admin-grants.sh 以 migrate 映像執行,檔案掛在 /gw/)
//   讀 /gw/super-admin-grants.yaml 與資料庫中 gw-super-admin 目前的權限,輸出「目前 ∪ 新增」的 CLI apply 檔到 stdout,摘要寫到 stderr。
//   只讀資料庫(SELECT),不寫入;寫入由 CLI apply 完成(稽核、權限版本與既有流程相同)。
//   結束碼:0 = 有要新增的權限;3 = 已全部具備,不需套用;其他 = 錯誤(不可套用)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire('/app/package.json');
const { parse, stringify } = require('yaml');
const { loadConfig } = await import('/app/dist/bff/src/config.js');
const { openPool } = await import('/app/dist/bff/src/db/client.js');

const fail = (msg) => {
  console.error(`錯誤:${msg}`);
  process.exit(1);
};

const cfg = parse(readFileSync('/gw/super-admin-grants.yaml', 'utf8'));
// 本流程只處理超級管理員,其他角色用各應用的 gateway-rbac.yaml
if (cfg?.role !== 'gw-super-admin') fail('role 必須是 gw-super-admin');
const grants = [...new Set((cfg.grants ?? []).flatMap((g) => g.permissions ?? []))];
if (!grants.length) fail('grants 沒有任何權限');
const bad = grants.filter((c) => typeof c !== 'string' || !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(c));
if (bad.length) fail(`權限代碼格式錯誤:${bad.join(', ')}`);

const pool = await openPool(loadConfig().gwDb, { appName: 'giganexus-grant-plan', poolMax: 1 });
try {
  const r = await pool.request().input('code', cfg.role).query('SELECT role_id, name FROM gw.role WHERE code = @code');
  if (!r.recordset.length) fail(`找不到角色 ${cfg.role}`);
  const { role_id: roleId, name } = r.recordset[0];
  const cur = await pool
    .request()
    .input('id', roleId)
    .query('SELECT p.code FROM gw.role_permission rp JOIN gw.permission p ON p.permission_id = rp.permission_id WHERE rp.role_id = @id');
  const current = cur.recordset.map((x) => x.code);
  // 讀到 0 筆視為異常(超級管理員至少有 gw.admin.*),不產生會清空權限的檔案
  if (!current.length) fail(`${cfg.role} 目前沒有任何權限,疑似讀取錯誤,中止`);

  const req = pool.request();
  grants.forEach((c, i) => req.input(`p${i}`, c));
  const ex = await req.query(`SELECT code, kind FROM gw.permission WHERE code IN (${grants.map((_, i) => `@p${i}`).join(', ')})`);
  const exists = new Set(ex.recordset.map((x) => x.code));
  const missing = grants.filter((c) => !exists.has(c));
  if (missing.length) fail(`權限尚未登記(先套用該應用的 gateway-rbac.yaml):${missing.join(', ')}`);
  // 選單目錄(group)只分組、不可授予(同管理 API 的 isGrantableKind)
  const groups = ex.recordset.filter((x) => x.kind === 'group').map((x) => x.code);
  if (groups.length) fail(`選單目錄不可授予:${groups.join(', ')}`);

  const have = new Set(current);
  // 套用後驗證(EXPECT = 套用的檔):套用的每個權限都必須還在,少了就列出來(結束碼 4)
  if (process.env.EXPECT) {
    const want = parse(readFileSync(process.env.EXPECT, 'utf8')).roles[0].permissions;
    const lost = want.filter((c) => !have.has(c));
    if (lost.length) {
      console.error(`錯誤:套用後少了 ${lost.length} 個權限:${lost.join(', ')}`);
      process.exit(4);
    }
    console.error(`驗證:${cfg.role} 目前 ${current.length} 個權限,套用的 ${want.length} 個都在`);
  }
  const added = grants.filter((c) => !have.has(c));
  const merged = [...new Set([...current, ...grants])].sort();
  // 保險:合併結果必須包含目前全部權限
  if (current.some((c) => !merged.includes(c))) fail('合併結果少了既有權限,中止');

  console.error(`${cfg.role}:目前 ${current.length} 個權限,本檔 ${grants.length} 個,新增 ${added.length} 個,合併後 ${merged.length} 個`);
  for (const c of added) console.error(`  + ${c}`);
  if (!added.length) {
    console.error('已全部具備,不需套用');
    process.exit(3);
  }
  process.stdout.write(
    `# 由 super-admin-grants-plan.mjs 產生:${cfg.role} 目前的權限 ∪ super-admin-grants.yaml(只新增)\n` +
      stringify({ roles: [{ code: cfg.role, name, permissions: merged }] }),
  );
} finally {
  await pool.close();
}
