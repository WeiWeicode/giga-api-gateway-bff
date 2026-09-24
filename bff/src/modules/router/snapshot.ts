/**
 * 路由快照(DATABASE.md §7.2、PRD §8.4.2):發佈時由 SQL Server 組成完整快照,
 * 存入 gw.config_release.snapshot 與 Redis gw:routes:snapshot,各 BFF 實例據此建立記憶體路由樹。
 * JSON 欄位(request_headers_add…)在此解析,資料庫端不處理 JSON(SQL Server 2012)。
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { GwDatabase } from '../../db/client.js';
import { aggregateStep, apiRoute, rateLimitPolicy, upstream, upstreamTarget } from '../../db/schema/index.js';

export interface SnapshotUpstream {
  code: string;
  protocol: string;
  lbStrategy: string;
  timeoutMs: number;
  retryCount: number;
  circuitFailThreshold: number;
  forwardCookies: boolean;
  healthCheckPath: string | null;
  targets: { baseUrl: string; weight: number }[];
}

export interface SnapshotPolicy {
  code: string;
  limitCount: number;
  windowSec: number;
  keyBy: 'user' | 'ip' | 'client' | 'route';
}

export interface SnapshotStep {
  stepKey: string;
  stepOrder: number;
  upstreamCode: string;
  method: string;
  pathTemplate: string;
  required: boolean;
  timeoutMs: number;
  permissionCode: string | null;
}

export type AuthMode = 'public' | 'authenticated' | 'permission' | 'api_key';

export interface SnapshotRoute {
  routeCode: string;
  name: string;
  systemCode: string;
  method: string;
  publicPath: string;
  routeType: 'proxy' | 'aggregate' | 'internal' | 'mock';
  upstreamCode: string | null;
  upstreamMethod: string | null;
  upstreamPath: string | null;
  authMode: AuthMode;
  permissionCode: string | null;
  rateLimitPolicy: string | null;
  cacheTtlSec: number | null;
  cacheScope: 'user' | 'shared' | null;
  timeoutMs: number | null;
  maxBodyKb: number | null;
  requestHeadersAdd: Record<string, string> | null;
  responseHeadersRemove: string[] | null;
  mockResponse: unknown;
  auditLevel: 'none' | 'meta' | 'body';
  status: 'published' | 'deprecated';
  deprecatedAt: string | null;
  steps: SnapshotStep[];
}

export interface RouteSnapshotContent {
  environment: string;
  upstreams: SnapshotUpstream[];
  policies: SnapshotPolicy[];
  routes: SnapshotRoute[];
}

export interface RouteSnapshot extends RouteSnapshotContent {
  version: number;
  publishedAt: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type Db = GwDatabase | Parameters<Parameters<GwDatabase['transaction']>[0]>[0];

/** 以目前資料庫中「已發佈 / 已棄用」的路由組成快照內容(不含版本號) */
export async function buildSnapshotContent(db: Db, environment: string): Promise<RouteSnapshotContent> {
  const env = environment === 'prod' ? 'prod' : 'test';
  const ups = await db.select().from(upstream).where(eq(upstream.isEnabled, true));
  const targets = ups.length
    ? await db
        .select()
        .from(upstreamTarget)
        .where(
          and(
            inArray(
              upstreamTarget.upstreamId,
              ups.map((u) => u.upstreamId),
            ),
            eq(upstreamTarget.isEnabled, true),
            eq(upstreamTarget.environment, env),
          ),
        )
    : [];
  const upCode = new Map(ups.map((u) => [u.upstreamId, u.code]));
  const policies = await db.select().from(rateLimitPolicy);
  const policyCode = new Map(policies.map((p) => [p.policyId, p.code]));
  const routes = await db
    .select()
    .from(apiRoute)
    .where(inArray(apiRoute.status, ['published', 'deprecated']));
  const steps = routes.length
    ? await db
        .select()
        .from(aggregateStep)
        .where(
          inArray(
            aggregateStep.routeId,
            routes.map((r) => r.routeId),
          ),
        )
    : [];

  return {
    environment: env,
    upstreams: ups
      .map((u) => ({
        code: u.code,
        protocol: u.protocol,
        lbStrategy: u.lbStrategy,
        timeoutMs: u.timeoutMs,
        retryCount: u.retryCount,
        circuitFailThreshold: u.circuitFailThreshold,
        forwardCookies: u.forwardCookies,
        healthCheckPath: u.healthCheckPath,
        targets: targets.filter((t) => t.upstreamId === u.upstreamId).map((t) => ({ baseUrl: t.baseUrl, weight: t.weight })),
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    policies: policies
      .map((p) => ({ code: p.code, limitCount: p.limitCount, windowSec: p.windowSec, keyBy: p.keyBy as SnapshotPolicy['keyBy'] }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    routes: routes
      .map((r) => ({
        routeCode: r.routeCode,
        name: r.name,
        systemCode: r.systemCode,
        method: r.method,
        publicPath: r.publicPath,
        routeType: r.routeType as SnapshotRoute['routeType'],
        upstreamCode: r.upstreamId ? (upCode.get(r.upstreamId) ?? null) : null,
        upstreamMethod: r.upstreamMethod,
        upstreamPath: r.upstreamPath,
        authMode: r.authMode as AuthMode,
        permissionCode: r.permissionCode,
        rateLimitPolicy: r.rateLimitPolicyId ? (policyCode.get(r.rateLimitPolicyId) ?? null) : null,
        cacheTtlSec: r.cacheTtlSec,
        cacheScope: r.cacheScope as SnapshotRoute['cacheScope'],
        timeoutMs: r.timeoutMs,
        maxBodyKb: r.maxBodyKb,
        requestHeadersAdd: parseJson<Record<string, string> | null>(r.requestHeadersAdd, null),
        responseHeadersRemove: parseJson<string[] | null>(r.responseHeadersRemove, null),
        mockResponse: parseJson<unknown>(r.mockResponse, null),
        auditLevel: r.auditLevel as SnapshotRoute['auditLevel'],
        status: r.status as SnapshotRoute['status'],
        deprecatedAt: r.deprecatedAt?.toISOString() ?? null,
        steps: steps
          .filter((s) => s.routeId === r.routeId)
          .map((s) => ({
            stepKey: s.stepKey,
            stepOrder: s.stepOrder,
            upstreamCode: upCode.get(s.upstreamId) ?? '',
            method: s.method,
            pathTemplate: s.pathTemplate,
            required: s.required,
            timeoutMs: s.timeoutMs,
            permissionCode: s.permissionCode,
          }))
          .sort((a, b) => a.stepOrder - b.stepOrder || a.stepKey.localeCompare(b.stepKey)),
      }))
      .sort((a, b) => a.routeCode.localeCompare(b.routeCode)),
  };
}

/** 與前一版的差異摘要(新增 / 修改 / 停用) */
export function diffSnapshots(prev: RouteSnapshotContent | null, next: RouteSnapshotContent) {
  const before = new Map((prev?.routes ?? []).map((r) => [r.routeCode, JSON.stringify(r)]));
  const after = new Map(next.routes.map((r) => [r.routeCode, JSON.stringify(r)]));
  return {
    added: [...after.keys()].filter((k) => !before.has(k)),
    modified: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
    removed: [...before.keys()].filter((k) => !after.has(k)),
    upstreamsChanged: JSON.stringify(prev?.upstreams ?? []) !== JSON.stringify(next.upstreams),
    policiesChanged: JSON.stringify(prev?.policies ?? []) !== JSON.stringify(next.policies),
  };
}
