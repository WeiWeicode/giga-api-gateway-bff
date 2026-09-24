/**
 * 記憶體路由樹(PRD §8.4.2):以 find-my-way 建立,O(路徑長度) 比對;新版本建好後原子替換。
 * 版本號單調遞增,只接受比目前更新的版本(重複或亂序的通知不會回退,DATABASE.md §7.3)。
 * /api/auth/*、/api/admin/* 為程式內建,路由表中的同名路徑一律忽略(PRD §14.1)。
 */
import FindMyWay, { type HTTPMethod } from 'find-my-way';
import type { RouteSnapshot, SnapshotPolicy, SnapshotRoute, SnapshotUpstream } from './snapshot.js';

const METHODS: HTTPMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const RESERVED = /^\/api\/(auth|admin)(\/|$)/;

export interface RouteMatch {
  route: SnapshotRoute;
  params: Record<string, string>;
}

interface Built {
  snapshot: RouteSnapshot;
  router: ReturnType<typeof FindMyWay>;
  upstreams: Map<string, SnapshotUpstream>;
  policies: Map<string, SnapshotPolicy>;
}

export class RouteTable {
  private current: Built | null = null;
  readonly warnings: string[] = [];

  get version(): number {
    return this.current?.snapshot.version ?? 0;
  }

  get snapshot(): RouteSnapshot | null {
    return this.current?.snapshot ?? null;
  }

  /** 套用新快照;版本不比目前新時忽略並回傳 false */
  apply(snapshot: RouteSnapshot): boolean {
    if (snapshot.version <= this.version) return false;
    const router = FindMyWay({ ignoreTrailingSlash: true, caseSensitive: true, maxParamLength: 200 });
    this.warnings.length = 0;
    // 明確方法先登記,'*' 後登記,使明確方法優先
    for (const r of [...snapshot.routes].sort((a, b) => Number(a.method === '*') - Number(b.method === '*'))) {
      if (RESERVED.test(r.publicPath)) {
        this.warnings.push(`略過保留路徑 ${r.method} ${r.publicPath}(${r.routeCode})`);
        continue;
      }
      const methods = r.method === '*' ? METHODS : r.method === 'GET' ? (['GET', 'HEAD'] as HTTPMethod[]) : [r.method as HTTPMethod];
      for (const m of methods) {
        try {
          router.on(m, r.publicPath, () => undefined, r);
        } catch (err) {
          // 明確方法優先於 '*';同方法同路徑重複時保留先登記者
          this.warnings.push(`${r.routeCode}:${m} ${r.publicPath} 與既有路由衝突(${(err as Error).message})`);
        }
      }
    }
    this.current = {
      snapshot,
      router,
      upstreams: new Map(snapshot.upstreams.map((u) => [u.code, u])),
      policies: new Map(snapshot.policies.map((p) => [p.code, p])),
    };
    return true;
  }

  find(method: string, path: string): RouteMatch | null {
    const found = this.current?.router.find(method as HTTPMethod, path);
    if (!found) return null;
    return { route: found.store as SnapshotRoute, params: (found.params ?? {}) as Record<string, string> };
  }

  upstream(code: string | null): SnapshotUpstream | undefined {
    return code ? this.current?.upstreams.get(code) : undefined;
  }

  policy(code: string | null): SnapshotPolicy | undefined {
    return this.current?.policies.get(code ?? 'default') ?? this.current?.policies.get('default');
  }
}
