import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Sql2012GuardLogger } from '../../src/db/client.js';
import { findSql2012Violations, Sql2012CompatError, stripSqlCommentsAndStrings } from '../../src/db/sql2012-guard.js';

const rules = (s: string) => findSql2012Violations(s).map((v) => v.rule);

describe('findSql2012Violations', () => {
  it.each([
    ['CREATE OR ALTER VIEW gw.v AS SELECT 1', 'create-or-alter'],
    ['DROP TABLE IF EXISTS gw.t', 'drop-if-exists'],
    ['ALTER TABLE gw.t DROP COLUMN IF EXISTS c', 'alter-drop-if-exists'],
    ["SELECT JSON_VALUE(snapshot, '$.a') FROM gw.config_release", 'json-functions'],
    ['SELECT * FROM OPENJSON(@j)', 'json-functions'],
    ['SELECT * FROM gw.role FOR JSON PATH', 'for-json'],
    ["SELECT STRING_AGG(code, ',') FROM gw.role", 'string-agg'],
    ["SELECT value FROM STRING_SPLIT(@s, ',')", 'string-split'],
    ['SELECT TRIM(name) FROM gw.role', 'trim'],
    ["SELECT CONCAT_WS('-', a, b)", 'concat-ws'],
    ["SELECT GETDATE() AT TIME ZONE 'Taipei Standard Time'", 'at-time-zone'],
    ['SELECT GREATEST(1, 2)', 'greatest-least'],
    ['CREATE TABLE t (a int) WITH (SYSTEM_VERSIONING = ON)', 'temporal'],
    ['CREATE INDEX ix ON t (a) WITH (DATA_COMPRESSION = PAGE)', 'data-compression'],
    ['CREATE PARTITION FUNCTION pf (datetime2) AS RANGE RIGHT FOR VALUES (1)', 'partition'],
    ['CREATE TABLE t (\n  a int,\n  INDEX ix_a NONCLUSTERED (a)\n)', 'inline-index'],
  ])('%s → %s', (sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it.each([
    'SELECT LTRIM(RTRIM(name)) FROM gw.role',
    "IF OBJECT_ID(N'gw.t', N'U') IS NOT NULL DROP TABLE gw.t",
    'SELECT * FROM gw.api_route ORDER BY route_id OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY',
    'SELECT TOP (5) * FROM gw.role',
    "CREATE UNIQUE INDEX ux ON gw.api_route (method, public_path) WHERE status <> 'disabled'",
    "SELECT IIF(a > 1, 1, 0), TRY_CONVERT(int, b), CONCAT(a, b), FORMAT(d, N'yyyy')",
    'CREATE TABLE gw.t ([before_json] nvarchar(max), [row_ver] rowversion NOT NULL)',
    'SELECT [t].[trim_value] FROM gw.t',
  ])('允許:%s', (sql) => {
    expect(findSql2012Violations(sql)).toEqual([]);
  });

  it('忽略註解與字串常值中的關鍵字', () => {
    const sql = "-- STRING_AGG( 只是註解\n/* CREATE OR ALTER */ SELECT N'TRIM(x)' AS s";
    expect(findSql2012Violations(sql)).toEqual([]);
    expect(stripSqlCommentsAndStrings("SELECT 'a''b' -- c\n")).toBe("SELECT '' \n");
  });

  it('回報正確行號', () => {
    const [v] = findSql2012Violations('SELECT 1;\n\nSELECT STRING_AGG(a, b) FROM t');
    expect(v).toMatchObject({ rule: 'string-agg', line: 3 });
  });
});

describe('db/migrations', () => {
  it('所有 migration 皆無 2012 不支援的語法', () => {
    const root = fileURLToPath(new URL('../../../db/migrations', import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(findSql2012Violations(readFileSync(path.join(root, f), 'utf8')), f).toEqual([]);
  });
});

describe('Sql2012GuardLogger', () => {
  it('error 模式丟出 Sql2012CompatError', () => {
    const logger = new Sql2012GuardLogger('error');
    expect(() => logger.logQuery("select string_agg([code], ',') from [gw].[role]")).toThrow(Sql2012CompatError);
    expect(() => logger.logQuery('select top(1) [code] from [gw].[role]')).not.toThrow();
  });

  it('warn 模式只記錄', () => {
    const warnings: string[] = [];
    const logger = new Sql2012GuardLogger('warn', (msg) => warnings.push(msg));
    logger.logQuery('select trim([code]) from [gw].[role]');
    expect(warnings).toHaveLength(1);
  });
});
