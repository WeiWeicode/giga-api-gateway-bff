/**
 * OpenAPI → 路由草稿(PRD §8.4.4、BACKEND-GUIDE.md §6):
 *   根:x-gateway.upstream / x-gateway.system、x-gateway.project(選用:開發專案 = repo 資料夾名稱)、x-permissions
 *   operation:operationId → route_code、summary → name、x-permission → auth_mode / permission_code、
 *              x-gateway-path、x-timeout-ms、x-cache-ttl / x-cache-scope、x-audit-level、x-rate-limit、tags、
 *              description → description(API 用途說明)、x-gherkin → gherkin(行為規格,Gherkin 場景文字)
 *   沒有 x-permission 的 operation 列為錯誤,不會自動視為公開。
 */

export interface ParsedRoute {
  routeCode: string;
  name: string;
  systemCode: string;
  method: string;
  publicPath: string;
  upstreamPath: string;
  authMode: 'public' | 'authenticated' | 'permission';
  permissionCode: string | null;
  timeoutMs: number | null;
  cacheTtlSec: number | null;
  cacheScope: 'user' | 'shared' | null;
  auditLevel: 'none' | 'meta' | 'body';
  rateLimitPolicy: string | null;
  tags: string | null;
  description: string | null;
  gherkin: string | null;
}

/** x-permissions 一筆;kind / parent / sort 供應用畫面權限樹(PRD §8.3.2,v0.7) */
export interface PermissionDecl {
  code: string;
  name: string;
  kind?: PermissionKind;
  parent?: string;
  sort?: number;
}

export const PERMISSION_KINDS = ['app', 'menu', 'tab', 'button', 'api'] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export interface ParsedSpec {
  upstreamCode: string;
  systemCode: string;
  /** 開發專案(x-gateway.project);未提供時為 null,匯入時保留上游既有值 */
  project: string | null;
  permissions: PermissionDecl[];
  routes: ParsedRoute[];
  errors: { operation: string; message: string }[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/;
const SYSTEM = /^[a-z][a-z0-9-]{1,29}$/;
/** repo 資料夾名稱(AGENT.md §10.2),例 giga-endpoint、GigaItApp */
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** x-permissions 一筆的格式檢查;正確回傳 null(CLI apply 的 permissions: 共用) */
export function permissionDeclError(p: Record<string, unknown>): string | null {
  if (typeof p.code !== 'string' || !CODE.test(p.code) || typeof p.name !== 'string' || !p.name) return '權限代碼格式錯誤';
  if (p.kind !== undefined && !(PERMISSION_KINDS as readonly unknown[]).includes(p.kind)) return `kind 需為 ${PERMISSION_KINDS.join(' / ')}`;
  if (p.parent !== undefined && (typeof p.parent !== 'string' || !CODE.test(p.parent) || p.parent === p.code)) return 'parent 需為其他權限代碼';
  if (p.sort !== undefined && (!Number.isInteger(p.sort) || (p.sort as number) < 0 || (p.sort as number) > 32767)) return 'sort 需為 0–32767 的整數';
  return null;
}

/** /v1/work-orders/{id} → /api/mes/work-orders/:id(預設去掉開頭的版本段) */
export function toPublicPath(system: string, upstreamPath: string): string {
  const rest = upstreamPath.replace(/^\/v\d+(?=\/|$)/, '');
  return `/api/${system}${rest}`.replace(/\{(\w+)\}/g, ':$1');
}

export function parseOpenApi(doc: Record<string, unknown>): ParsedSpec {
  const errors: ParsedSpec['errors'] = [];
  const xg = (doc['x-gateway'] ?? {}) as { upstream?: string; system?: string; project?: unknown };
  if (!xg.upstream) errors.push({ operation: '(root)', message: '缺少 x-gateway.upstream' });
  if (!xg.system || !SYSTEM.test(xg.system)) errors.push({ operation: '(root)', message: '缺少或不合法的 x-gateway.system' });
  if (xg.project !== undefined && (typeof xg.project !== 'string' || !PROJECT.test(xg.project)))
    errors.push({ operation: '(root)', message: 'x-gateway.project 需為 repo 資料夾名稱(英數、. _ -,100 字內)' });
  const system = xg.system ?? '';
  const permissions = ((doc['x-permissions'] ?? []) as Record<string, unknown>[]).filter((p) => {
    const msg = permissionDeclError(p);
    if (msg) errors.push({ operation: '(x-permissions)', message: `${msg}:${JSON.stringify(p)}` });
    return !msg;
  }) as unknown as PermissionDecl[];
  if (!Array.isArray(doc['x-permissions'])) errors.push({ operation: '(root)', message: '缺少 x-permissions' });

  const routes: ParsedRoute[] = [];
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  for (const [path, ops] of Object.entries(paths)) {
    for (const m of METHODS) {
      const op = ops[m];
      if (!op) continue;
      const label = `${m.toUpperCase()} ${path}`;
      const fail = (message: string) => errors.push({ operation: String(op.operationId ?? label), message });
      const operationId = op.operationId as string | undefined;
      const summary = op.summary as string | undefined;
      const perm = op['x-permission'] as string | undefined;
      if (!operationId || !CODE.test(operationId)) fail('operationId 必填,格式 {system}.{resource}.{action}');
      if (!summary) fail('summary 必填');
      if (!perm) fail('x-permission 必填(權限代碼、authenticated 或 public)');
      else if (!['public', 'authenticated'].includes(perm) && !CODE.test(perm)) fail(`x-permission 格式錯誤:${perm}`);
      const ttl = op['x-cache-ttl'] as number | undefined;
      const scope = op['x-cache-scope'] as 'user' | 'shared' | undefined;
      if (ttl !== undefined && (m !== 'get' || !scope || !['user', 'shared'].includes(scope)))
        fail('x-cache-ttl 僅限 GET,且必須設定 x-cache-scope(shared / user)');
      const timeout = op['x-timeout-ms'] as number | undefined;
      if (timeout !== undefined && (timeout < 100 || timeout > 60_000)) fail('x-timeout-ms 需介於 100 ~ 60000');
      const audit = (op['x-audit-level'] as string | undefined) ?? 'none';
      if (!['none', 'meta', 'body'].includes(audit)) fail(`x-audit-level 錯誤:${audit}`);
      const description = op.description as unknown;
      if (description !== undefined && (typeof description !== 'string' || description.length > 1000)) fail('description 需為 1000 字以內的文字');
      const gherkin = op['x-gherkin'] as unknown;
      if (gherkin !== undefined && typeof gherkin !== 'string') fail('x-gherkin 需為文字(Gherkin 場景)');
      if (!operationId || !summary || !perm) continue;

      routes.push({
        routeCode: operationId,
        name: summary,
        systemCode: system,
        method: m.toUpperCase(),
        publicPath: ((op['x-gateway-path'] as string | undefined) ?? toPublicPath(system, path)).replace(/\{(\w+)\}/g, ':$1'),
        upstreamPath: path.replace(/\{(\w+)\}/g, ':$1'),
        authMode: perm === 'public' ? 'public' : perm === 'authenticated' ? 'authenticated' : 'permission',
        permissionCode: perm === 'public' || perm === 'authenticated' ? null : perm,
        timeoutMs: timeout ?? null,
        cacheTtlSec: ttl ?? null,
        cacheScope: ttl !== undefined ? (scope ?? null) : null,
        auditLevel: audit as ParsedRoute['auditLevel'],
        rateLimitPolicy: (op['x-rate-limit'] as string | undefined) ?? null,
        tags: Array.isArray(op.tags) ? (op.tags as string[]).join(',') : null,
        description: typeof description === 'string' && description.trim() ? description.trim() : null,
        gherkin: typeof gherkin === 'string' && gherkin.trim() ? gherkin.trim() : null,
      });
    }
  }
  const declared = new Set(permissions.map((p) => p.code));
  for (const r of routes)
    if (r.permissionCode && !declared.has(r.permissionCode))
      errors.push({ operation: r.routeCode, message: `x-permission ${r.permissionCode} 未列在 x-permissions` });
  const project = typeof xg.project === 'string' && PROJECT.test(xg.project) ? xg.project : null;
  return { upstreamCode: xg.upstream ?? '', systemCode: system, project, permissions, routes, errors };
}

/** 上游位址的 port 必須在 51200–51300(BACKEND-GUIDE.md §3) */
export function checkUpstreamPort(baseUrl: string): boolean {
  const u = new URL(baseUrl);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return port >= 51200 && port <= 51300;
}
