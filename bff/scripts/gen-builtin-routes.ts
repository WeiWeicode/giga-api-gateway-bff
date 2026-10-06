/**
 * 產生 BFF 內建 API 清單(MONITORING-PLAN D3、W9-5):`npm run gen:builtin`
 *
 * BFF 自己的 API(/api/auth/*、/api/admin/*、/api/notify/*…)不在動態路由表(PRD §14.1),權限在處理函式內以
 * authorize(req, 代碼) / requirePerm / requireClient / app.perms.has(…, 代碼) 檢查,沒有宣告在路由設定上。
 * 本腳本以 TypeScript 編譯器解析 src/modules/**,找出每個路由與其處理函式(含同檔案內被呼叫的輔助函式)檢查的權限代碼,
 * 輸出 src/modules/admin/builtin-routes.generated.json,供路由目錄與權限查詢使用。
 *
 * 單元測試(builtin-routes.test.ts)重新產生並比對:新增或修改內建 API 後忘了執行本腳本,CI 會失敗。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface BuiltinRoute {
  method: string;
  path: string;
  /** permission:檢查權限代碼;authenticated:登入即可;public:免登入(或自行驗證,例 Webhook 簽章、API Key) */
  auth: 'permission' | 'authenticated' | 'public';
  permissions: string[];
  summary: string | null;
  module: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = path.join(ROOT, 'src', 'modules');
export const OUTPUT = path.join(MODULES, 'admin', 'builtin-routes.generated.json');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const PERM_CALLS = new Set(['authorize', 'requirePerm', 'requireClient']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** 檔案內的字串常數(const X = 'a.b.c') */
function constants(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteralLike(n.initializer))
      out.set(n.name.text, n.initializer.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** 檔案內具名函式(function x / const x = async () =>),供追蹤處理函式呼叫的輔助函式 */
function functions(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) out.set(n.name.text, n);
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      out.set(n.name.text, n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function text(n: ts.Expression | undefined, consts: Map<string, string>): string | null {
  if (!n) return null;
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isIdentifier(n)) return consts.get(n.text) ?? null;
  if (ts.isTemplateExpression(n)) {
    let s = n.head.text;
    for (const span of n.templateSpans) {
      const v = text(span.expression, consts);
      if (v === null) return null;
      s += v + span.literal.text;
    }
    return s;
  }
  return null;
}

function calleeName(c: ts.CallExpression): string | null {
  if (ts.isIdentifier(c.expression)) return c.expression.text;
  if (ts.isPropertyAccessExpression(c.expression)) return c.expression.name.text;
  return null;
}

/** 處理函式內檢查的權限(遞迴追蹤同檔案的輔助函式一層以上,避免循環) */
function checks(body: ts.Node, consts: Map<string, string>, fns: Map<string, ts.Node>, seen = new Set<ts.Node>()): { perms: Set<string>; principal: boolean } {
  const perms = new Set<string>();
  let principal = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && PERM_CALLS.has(name)) {
        const v = text(n.arguments[1], consts);
        if (v) perms.add(v);
      } else if (name === 'has' && ts.isPropertyAccessExpression(n.expression) && /perms$/.test(n.expression.expression.getText())) {
        const v = text(n.arguments[2], consts);
        if (v) perms.add(v);
      } else if (name === 'requirePrincipal') principal = true;
      else if (name && fns.has(name) && !seen.has(fns.get(name)!)) {
        seen.add(fns.get(name)!);
        const sub = checks(fns.get(name)!, consts, fns, seen);
        sub.perms.forEach((p) => perms.add(p));
        principal ||= sub.principal;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return { perms, principal };
}

function schemaSummary(opts: ts.Expression | undefined): string | null {
  if (!opts || !ts.isObjectLiteralExpression(opts)) return null;
  const schema = opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'schema');
  if (!schema || !ts.isObjectLiteralExpression(schema.initializer)) return null;
  const s = schema.initializer.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'summary');
  return s && ts.isStringLiteralLike(s.initializer) ? s.initializer.text : null;
}

export function generate(): BuiltinRoute[] {
  const out: BuiltinRoute[] = [];
  for (const file of walk(MODULES)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2023, true);
    const consts = constants(sf);
    const fns = functions(sf);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && METHODS.has(n.expression.name.text) && n.arguments.length >= 2) {
        const p = text(n.arguments[0], consts);
        if (p?.startsWith('/api/') && !p.includes('*')) {
          const handler = n.arguments[n.arguments.length - 1]!;
          const { perms, principal } = checks(handler, consts, fns);
          out.push({
            method: n.expression.name.text.toUpperCase(),
            path: p,
            auth: perms.size ? 'permission' : principal ? 'authenticated' : 'public',
            permissions: [...perms].sort(),
            summary: n.arguments.length >= 3 ? schemaSummary(n.arguments[1]) : null,
            module: path.relative(path.join(ROOT, 'src'), file).replaceAll('\\', '/'),
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function serialize(routes: BuiltinRoute[]): string {
  return JSON.stringify(routes, null, 2) + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const routes = generate();
  writeFileSync(OUTPUT, serialize(routes));
  const by = (a: BuiltinRoute['auth']) => routes.filter((r) => r.auth === a).length;
  console.log(`已產生 ${path.relative(ROOT, OUTPUT)}:${routes.length} 支(權限 ${by('permission')}、登入即可 ${by('authenticated')}、免登入 ${by('public')})`);
}
