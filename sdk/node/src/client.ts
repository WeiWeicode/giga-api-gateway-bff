/**
 * Gateway 管理端點(BACKEND-GUIDE.md §7.5),以 X-Api-Key 呼叫:
 *   POST /api/admin/registrations     自動註冊:送出 OpenAPI → Gateway 寫入草稿(IT 核可後發佈)
 *   GET  /api/admin/routes/catalog    查詢既有路由(含說明與 Gherkin)
 */

/** Gateway 統一錯誤格式 { code, message, requestId, details? }(PRD §8.1.1) */
export class GatewayError extends Error {
  override name = 'GatewayError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(`${code}:${message}`);
  }
}

export interface RegistrationResult {
  batchId: number;
  upstream: string;
  environment: 'test' | 'prod';
  created: number;
  updated: number;
  unchanged: number;
  createdPermissions: number;
  addedTargets: number;
  /** 有新增或修改的路由,等待 IT 發佈 */
  pendingPublish: boolean;
}

export interface CatalogRoute {
  routeCode: string;
  name: string;
  systemCode: string;
  method: string;
  publicPath: string;
  routeType: string;
  upstream: string | null;
  /** 開發專案:實作此路由上游服務的 repo 資料夾名稱(x-gateway.project);未登記為 null */
  project: string | null;
  upstreamPath: string | null;
  authMode: string;
  permissionCode: string | null;
  status: 'draft' | 'published' | 'deprecated' | 'disabled';
  tags: string | null;
  description: string | null;
  gherkin: string | null;
}

export interface CatalogResult {
  environment: 'test' | 'prod';
  total: number;
  truncated: boolean;
  items: CatalogRoute[];
}

export interface LookupQuery {
  /** 關鍵字:比對 route_code、名稱、對外路徑、權限代碼、標籤、說明、開發專案 */
  q?: string;
  system?: string;
  /** 逗號分隔:draft,published,deprecated,disabled;預設為停用以外 */
  status?: string;
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + path, {
      method,
      headers: { accept: 'application/json', 'x-api-key': this.apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      // 非 JSON(例如 Nginx 預設錯誤頁)
    }
    if (!res.ok) {
      throw new GatewayError(
        res.status,
        typeof json?.code === 'string' ? json.code : `HTTP_${res.status}`,
        typeof json?.message === 'string' ? json.message : text.slice(0, 200),
        typeof json?.requestId === 'string' ? json.requestId : (res.headers.get('x-request-id') ?? undefined),
        json?.details,
      );
    }
    return json as T;
  }

  /** 送出 OpenAPI 規格;target 為 Gateway 連到本服務的位址 */
  register(spec: object, target: string): Promise<RegistrationResult> {
    return this.call('POST', '/api/admin/registrations', { spec, target });
  }

  lookup(query: LookupQuery = {}): Promise<CatalogResult> {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
    return this.call('GET', `/api/admin/routes/catalog?${qs}`);
  }
}
