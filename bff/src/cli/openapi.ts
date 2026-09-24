/**
 * OpenAPI → 路由草稿(PRD §8.4.4、BACKEND-GUIDE.md §6):
 *   根:x-gateway.upstream / x-gateway.system、x-permissions
 *   operation:operationId → route_code、summary → name、x-permission → auth_mode / permission_code、
 *              x-gateway-path、x-timeout-ms、x-cache-ttl / x-cache-scope、x-audit-level、x-rate-limit、tags
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
}

export interface ParsedSpec {
  upstreamCode: string;
  systemCode: string;
  permissions: { code: string; name: string }[];
  routes: ParsedRoute[];
  errors: { operation: string; message: string }[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/;
const SYSTEM = /^[a-z][a-z0-9-]{1,29}$/;

/** /v1/work-orders/{id} → /api/mes/work-orders/:id(預設去掉開頭的版本段) */
export function toPublicPath(system: string, upstreamPath: string): string {
  const rest = upstreamPath.replace(/^\/v\d+(?=\/|$)/, '');
  return `/api/${system}${rest}`.replace(/\{(\w+)\}/g, ':$1');
}

export function parseOpenApi(doc: Record<string, unknown>): ParsedSpec {
  const errors: ParsedSpec['errors'] = [];
  const xg = (doc['x-gateway'] ?? {}) as { upstream?: string; system?: string };
  if (!xg.upstream) errors.push({ operation: '(root)', message: '缺少 x-gateway.upstream' });
  if (!xg.system || !SYSTEM.test(xg.system)) errors.push({ operation: '(root)', message: '缺少或不合法的 x-gateway.system' });
  const system = xg.system ?? '';
  const permissions = ((doc['x-permissions'] ?? []) as { code?: string; name?: string }[]).filter((p) => {
    if (!p.code || !CODE.test(p.code) || !p.name) {
      errors.push({ operation: '(x-permissions)', message: `權限代碼格式錯誤:${JSON.stringify(p)}` });
      return false;
    }
    return true;
  }) as { code: string; name: string }[];
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
      });
    }
  }
  const declared = new Set(permissions.map((p) => p.code));
  for (const r of routes)
    if (r.permissionCode && !declared.has(r.permissionCode))
      errors.push({ operation: r.routeCode, message: `x-permission ${r.permissionCode} 未列在 x-permissions` });
  return { upstreamCode: xg.upstream ?? '', systemCode: system, permissions, routes, errors };
}

/** 上游位址的 port 必須在 51200–51300(BACKEND-GUIDE.md §3) */
export function checkUpstreamPort(baseUrl: string): boolean {
  const u = new URL(baseUrl);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return port >= 51200 && port <= 51300;
}
