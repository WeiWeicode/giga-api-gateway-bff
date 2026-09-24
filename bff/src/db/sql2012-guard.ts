/**
 * 檢查 SQL 是否使用 SQL Server 2012(11.0 RTM,Standard 版)不支援的語法。
 *
 * 本機與 CI 的容器最早只有 SQL Server 2017+,即使資料庫設為相容層級 110,
 * 多數新語法(CREATE OR ALTER、STRING_AGG、JSON 函式…)仍可執行,無法靠容器發現問題。
 * 因此以靜態規則補強(DATABASE.md §0):
 *   - migration 檔:`npm run db:check-2012`(CI check 階段)
 *   - 執行期 SQL:開發 / 測試環境由 Drizzle logger 呼叫(SQL2012_GUARD)
 */

export interface Sql2012Rule {
  id: string;
  pattern: RegExp;
  since: string;
  hint: string;
}

export interface Sql2012Violation {
  rule: string;
  since: string;
  hint: string;
  match: string;
  line: number;
}

export const SQL2012_RULES: readonly Sql2012Rule[] = [
  { id: 'create-or-alter', pattern: /\bCREATE\s+OR\s+ALTER\b/i, since: '2016 SP1', hint: '改用 IF OBJECT_ID(...) IS NOT NULL DROP ...;再 CREATE' },
  { id: 'drop-if-exists', pattern: /\bDROP\s+\w+\s+IF\s+EXISTS\b/i, since: '2016', hint: 'IF OBJECT_ID(...) IS NOT NULL DROP ...' },
  { id: 'alter-drop-if-exists', pattern: /\bDROP\s+(?:COLUMN|CONSTRAINT)\s+IF\s+EXISTS\b/i, since: '2016', hint: '先以 sys.columns / sys.objects 判斷再 DROP' },
  {
    id: 'json-functions',
    pattern: /\b(?:JSON_VALUE|JSON_QUERY|JSON_MODIFY|OPENJSON|ISJSON|JSON_OBJECT|JSON_ARRAY|JSON_PATH_EXISTS)\s*\(/i,
    since: '2016',
    hint: 'JSON 在應用層解析;需要查詢的值拆成獨立欄位',
  },
  { id: 'for-json', pattern: /\bFOR\s+JSON\b/i, since: '2016', hint: '在應用層組 JSON' },
  { id: 'string-agg', pattern: /\bSTRING_AGG\s*\(/i, since: '2017', hint: 'FOR XML PATH 或在應用層組字串' },
  { id: 'string-split', pattern: /\bSTRING_SPLIT\s*\(/i, since: '2016', hint: '在應用層拆字串,或以 XML 技巧拆分' },
  { id: 'trim', pattern: /(?<![\w.])TRIM\s*\(/i, since: '2017', hint: 'LTRIM(RTRIM(x))' },
  { id: 'concat-ws', pattern: /\bCONCAT_WS\s*\(/i, since: '2017', hint: 'CONCAT 或 +' },
  { id: 'translate', pattern: /\bTRANSLATE\s*\(/i, since: '2017', hint: '巢狀 REPLACE' },
  { id: 'string-escape', pattern: /\bSTRING_ESCAPE\s*\(/i, since: '2016', hint: '在應用層跳脫' },
  { id: 'datediff-big', pattern: /\bDATEDIFF_BIG\s*\(/i, since: '2016', hint: 'DATEDIFF 搭配較大的單位' },
  { id: 'at-time-zone', pattern: /\bAT\s+TIME\s+ZONE\b/i, since: '2016', hint: '一律以 UTC 儲存,時區在應用層轉換' },
  { id: 'compress', pattern: /\b(?:COMPRESS|DECOMPRESS)\s*\(/i, since: '2016', hint: '在應用層壓縮' },
  { id: 'session-context', pattern: /\bSESSION_CONTEXT\s*\(|\bsp_set_session_context\b/i, since: '2016', hint: 'CONTEXT_INFO' },
  { id: 'greatest-least', pattern: /\b(?:GREATEST|LEAST)\s*\(/i, since: '2022', hint: 'CASE WHEN' },
  { id: 'datetrunc', pattern: /\bDATETRUNC\s*\(/i, since: '2022', hint: 'DATEADD / DATEDIFF 組合' },
  { id: 'generate-series', pattern: /\bGENERATE_SERIES\s*\(/i, since: '2022', hint: '數字表或遞迴 CTE' },
  { id: 'is-distinct-from', pattern: /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/i, since: '2022', hint: '明確處理 NULL 的比較' },
  { id: 'approx-count', pattern: /\bAPPROX_COUNT_DISTINCT\s*\(/i, since: '2019', hint: 'COUNT(DISTINCT ...)' },
  {
    id: 'temporal',
    pattern: /\bSYSTEM_VERSIONING\b|\bGENERATED\s+ALWAYS\s+AS\s+ROW\b|\bPERIOD\s+FOR\s+SYSTEM_TIME\b/i,
    since: '2016',
    hint: '以 gw.config_release 快照 + gw.audit_log 保存歷史',
  },
  { id: 'memory-optimized', pattern: /\bMEMORY_OPTIMIZED\b/i, since: '2014', hint: '一般資料表' },
  { id: 'row-level-security', pattern: /\bCREATE\s+SECURITY\s+POLICY\b/i, since: '2016', hint: '以 DB 帳號與 schema 權限控管' },
  { id: 'masked', pattern: /\bMASKED\s+WITH\b/i, since: '2016', hint: '敏感值只存雜湊或參照' },
  { id: 'always-encrypted', pattern: /\bENCRYPTED\s+WITH\b/i, since: '2016', hint: '密鑰只存參照(secret_ref)' },
  { id: 'data-compression', pattern: /\bDATA_COMPRESSION\b/i, since: 'Standard 版 2016 SP1', hint: '2012 Standard 不支援壓縮,移除此選項' },
  { id: 'columnstore', pattern: /\bCOLUMNSTORE\b/i, since: 'Standard 版 2016 SP1', hint: '一般 rowstore 索引' },
  { id: 'partition', pattern: /\bCREATE\s+PARTITION\s+(?:FUNCTION|SCHEME)\b/i, since: 'Standard 版 2016 SP1', hint: '以排程分批刪除取代分割(DATABASE.md §0)' },
  {
    id: 'inline-index',
    pattern: /^\s*INDEX\s+\[?\w+\]?\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?\(/im,
    since: '2014',
    hint: '索引改為獨立的 CREATE INDEX',
  },
  { id: 'utf8-collation', pattern: /_UTF8\b/i, since: '2019', hint: '使用 NVARCHAR 儲存 Unicode' },
  { id: 'resumable', pattern: /\bRESUMABLE\s*=/i, since: '2017', hint: '移除此選項' },
  { id: 'truncate-partitions', pattern: /\bTRUNCATE\s+TABLE\b[^;]*\bWITH\s*\(\s*PARTITIONS\b/i, since: '2016', hint: '分批 DELETE' },
  { id: 'window-clause', pattern: /\bWINDOW\s+\w+\s+AS\s*\(/i, since: '2022', hint: '在各視窗函式中寫出 OVER (...)' },
  { id: 'json-type', pattern: /\s(?:JSON|VECTOR)\s*(?:\(|,|\)|NOT\b|NULL\b)/i, since: '2025', hint: 'NVARCHAR(MAX)' },
];

/** 移除註解與字串常值,避免誤判(保留換行以正確回報行號)。 */
export function stripSqlCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      out += "''";
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        if (sql[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function findSql2012Violations(sql: string): Sql2012Violation[] {
  const cleaned = stripSqlCommentsAndStrings(sql);
  const violations: Sql2012Violation[] = [];
  for (const rule of SQL2012_RULES) {
    const global = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    for (const m of cleaned.matchAll(global)) {
      const line = cleaned.slice(0, m.index).split('\n').length;
      violations.push({ rule: rule.id, since: rule.since, hint: rule.hint, match: m[0].trim(), line });
    }
  }
  return violations.sort((a, b) => a.line - b.line);
}

export class Sql2012CompatError extends Error {
  constructor(
    readonly violations: Sql2012Violation[],
    readonly sql: string,
  ) {
    super(`SQL 含 SQL Server 2012 不支援的語法:${violations.map((v) => `${v.rule}(${v.since})`).join(', ')}`);
    this.name = 'Sql2012CompatError';
  }
}
