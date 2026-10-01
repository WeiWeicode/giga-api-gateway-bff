/**
 * Gateway 管理 CLI(IMPL-PLAN W3-5.7、W3-4.15):第二階段管理 API 完成前,由 Gateway 負責人以此維護設定。
 *
 *   npm run gw -- import-openapi --file <路徑或 URL> --target <http://host:512xx> [--env test|prod]
 *   npm run gw -- apply --file <設定.yaml>          上游、限流政策、權限、角色(含 AD 群組 / 公司對應)、聚合 / mock 路由(含說明與 Gherkin)、Webhook 端點、通知範本、應用登記
 *   npm run gw -- publish [--note 說明]              發佈所有草稿(≤ 5 秒全部 BFF 生效)
 *   npm run gw -- rollback --to <版本>               以歷史版本產生新版本
 *   npm run gw -- releases                           列出最近 20 個發佈版本
 *   npm run gw -- local:create --emp <工號> [--base-url https://<gateway-host>]   IT 代建本機帳號,產生 72 小時啟用連結
 *   npm run gw -- local:unlock --emp <工號>
 *   npm run gw -- local:approve --emp <工號> [--base-url ...]   核准自行註冊的待審核申請(LOS / BPM 查無者),產生 72 小時啟用連結
 *   npm run gw -- local:reset --emp <工號>                      IT 重設本機帳號密碼(無 Email 者):產生臨時密碼,首次登入須更換
 *   npm run gw -- user:disable|user:enable --emp <工號>
 *   npm run gw -- client:create --code <服務代碼> [--name 名稱] [--perm 權限代碼 ...] [--ips CIDR,...] [--expires-days 天數]
 *                                                    建立或換發 API Key(明文只顯示一次);預設權限為自動註冊與路由查詢
 *   npm run gw -- client:disable --code <服務代碼>
 *   npm run gw -- dept:sync [--force]               由 BPM 同步部門樹(gw.department);worker 每小時自動執行
 *
 * 容器內:node dist/bff/src/cli/index.js <指令> ...
 * 所有寫入皆記錄 gw.audit_log(actor = --actor 或 cli:<OS 使用者>)。
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { parse as parseYaml } from 'yaml';
import { loadConfig, type AppConfig } from '../config.js';
import { createGwDb, openPool, type GwDatabase } from '../db/client.js';
import { createExternalDb } from '../db/external/index.js';
import {
  aggregateStep,
  app as appTable,
  apiClient,
  apiClientPermission,
  apiRoute,
  company,
  configRelease,
  localAccountToken,
  localCredential,
  notifyTemplate,
  permission,
  rateLimitPolicy,
  role,
  roleAdGroup,
  roleCompany,
  rolePermission,
  upstream,
  user,
  webhookEndpoint,
} from '../db/schema/index.js';
import { publishRelease, rollbackRelease } from '../db/sync/release.js';
import { clientKey, generateApiKey } from '../modules/auth/api-key.js';
import { AdDirectory } from '../modules/auth/ldap.js';
import { isChannel } from '../modules/notify/template.js';
import { permissionDeclError, type PermissionDecl } from './openapi.js';
import { applyProfile, isValidEmpNo, lookupEmployee, mergeProfile, normalizeEmpNo } from '../modules/auth/profile.js';
import { hashPassword, pushHistory } from '../modules/auth/password.js';
import { DepartmentSyncAborted, syncDepartments } from '../modules/rbac/department-sync.js';
import { bumpAllPermVersions } from '../modules/rbac/permission.js';
import { revokeUserSessions } from '../modules/auth/session.js';
import { audit, ensurePermissions, ImportError, importOpenApiDoc, setTargets, upsertUpstream } from '../modules/admin/route-import.js';

interface Ctx {
  config: AppConfig;
  db: GwDatabase;
  redis: Redis;
  actor: string;
}

const out = (v: unknown) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

class CliError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function readSource(file: string): Promise<string> {
  if (/^https?:\/\//.test(file)) {
    const res = await fetch(file);
    if (!res.ok) throw new CliError(`無法下載 ${file}:HTTP ${res.status}`);
    return res.text();
  }
  return readFile(file, 'utf8');
}

async function invalidatePvCache(redis: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'gw:pv:*', 'COUNT', 500);
    if (keys.length) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}

/* ------------------------------------------------------------------ */

async function importOpenApi(ctx: Ctx, file: string, target: string, env: 'test' | 'prod') {
  const text = await readSource(file);
  const doc = (file.endsWith('.json') || text.trimStart().startsWith('{') ? JSON.parse(text) : parseYaml(text)) as Record<string, unknown>;
  out(await importOpenApiDoc(ctx.db, { doc, text, fileName: file, target, env, actor: ctx.actor }));
}

interface ApplyFile {
  policies?: { code: string; limitCount: number; windowSec: number; keyBy: string; burst?: number }[];
  upstreams?: {
    code: string;
    name?: string;
    systemCode: string;
    timeoutMs?: number;
    retryCount?: number;
    circuitFailThreshold?: number;
    healthCheckPath?: string;
    /** 開發專案(repo 資料夾名稱),同 OpenAPI 的 x-gateway.project */
    project?: string;
    targets?: Record<string, string[]>;
  }[];
  /** 同 OpenAPI x-permissions(含 kind / parent / sort) */
  permissions?: PermissionDecl[];
  roles?: { code: string; name: string; description?: string; permissions?: string[]; adGroups?: string[]; companies?: string[] }[];
  companies?: { compName: string; domains?: string[] }[];
  routes?: {
    routeCode: string;
    name: string;
    systemCode: string;
    method: string;
    publicPath: string;
    routeType: 'aggregate' | 'mock' | 'proxy';
    authMode: string;
    permissionCode?: string;
    upstream?: string;
    upstreamPath?: string;
    mockResponse?: unknown;
    rateLimitPolicy?: string;
    timeoutMs?: number;
    /** API 用途說明、行為規格(Gherkin 場景文字),同 OpenAPI 的 description / x-gherkin */
    description?: string;
    gherkin?: string;
    steps?: {
      stepKey: string;
      upstream: string;
      method?: string;
      path: string;
      required?: boolean;
      order?: number;
      timeoutMs?: number;
      permissionCode?: string;
    }[];
  }[];
  /** Webhook 端點(PRD §8.6);密鑰實值放在 WEBHOOK_SECRETS_DIR/<secretRef>,不寫進設定檔 */
  webhooks?: {
    source: string;
    verifyMethod: 'hmac_sha256' | 'none';
    secretRef?: string;
    signatureHeader?: string;
    allowedIps?: string;
    dispatchType: 'queue';
    dispatchTarget: string;
    enabled?: boolean;
  }[];
  /** 應用登記(PRD §8.3.3):/api/auth/me 的 apps;permissionCode 為該應用的 app 權限 */
  apps?: { code: string; name: string; basePath: string; icon?: string; sort?: number; permissionCode: string; enabled?: boolean }[];
  /** 通知範本(PRD §8.5);變數 {{name}},emailBody 為 HTML(變數值自動跳脫) */
  notifyTemplates?: {
    code: string;
    name: string;
    channels: string[];
    emailSubject?: string;
    emailBody?: string;
    inappBody?: string;
    enabled?: boolean;
  }[];
}

async function applyConfig(ctx: Ctx, file: string) {
  const cfg = parseYaml(await readSource(file)) as ApplyFile;
  const result = await ctx.db.transaction(async (tx) => {
    const r = { policies: 0, upstreams: 0, permissions: 0, roles: 0, routes: 0, webhooks: 0, notifyTemplates: 0, apps: 0, pvBumped: false };
    for (const p of cfg.policies ?? []) {
      const [cur] = await tx.select().from(rateLimitPolicy).where(eq(rateLimitPolicy.code, p.code));
      const v = { limitCount: p.limitCount, windowSec: p.windowSec, keyBy: p.keyBy, burst: p.burst ?? null, updatedBy: ctx.actor };
      if (cur) await tx.update(rateLimitPolicy).set(v).where(eq(rateLimitPolicy.policyId, cur.policyId));
      else await tx.insert(rateLimitPolicy).values({ code: p.code, ...v, createdBy: ctx.actor });
      r.policies++;
    }
    const upIds = new Map<string, number>();
    for (const u of cfg.upstreams ?? []) {
      const id = await upsertUpstream(tx, u, ctx.actor);
      upIds.set(u.code, id);
      for (const [env, urls] of Object.entries(u.targets ?? {})) await setTargets(tx, id, env, urls, ctx.actor);
      r.upstreams++;
    }
    for (const p of cfg.permissions ?? []) {
      const msg = permissionDeclError(p as unknown as Record<string, unknown>);
      if (msg) throw new CliError(`${msg}:${JSON.stringify(p)}`);
    }
    r.permissions = await ensurePermissions(tx, cfg.permissions ?? [], ctx.actor);

    for (const c of cfg.companies ?? []) {
      const [row] = await tx.select({ id: company.companyId }).from(company).where(eq(company.compName, c.compName));
      if (!row) await tx.insert(company).values({ compName: c.compName, createdBy: ctx.actor, updatedBy: ctx.actor });
    }

    for (const ro of cfg.roles ?? []) {
      let [cur] = await tx.select().from(role).where(eq(role.code, ro.code));
      if (!cur)
        [cur] = await tx
          .insert(role)
          .output()
          .values({ code: ro.code, name: ro.name, description: ro.description ?? null, createdBy: ctx.actor, updatedBy: ctx.actor });
      const roleId = cur!.roleId;
      if (ro.permissions) {
        const ids = ro.permissions.length
          ? await tx.select({ id: permission.permissionId, code: permission.code }).from(permission).where(inArray(permission.code, ro.permissions))
          : [];
        const unknown = ro.permissions.filter((c) => !ids.some((i) => i.code === c));
        if (unknown.length) throw new CliError(`角色 ${ro.code} 的權限不存在:${unknown.join(', ')}`);
        await tx.delete(rolePermission).where(
          and(
            eq(rolePermission.roleId, roleId),
            ids.length
              ? notInArray(
                  rolePermission.permissionId,
                  ids.map((i) => i.id),
                )
              : sql`1 = 1`,
          ),
        );
        const have = new Set(
          (await tx.select({ id: rolePermission.permissionId }).from(rolePermission).where(eq(rolePermission.roleId, roleId))).map((x) => x.id),
        );
        for (const i of ids) if (!have.has(i.id)) await tx.insert(rolePermission).values({ roleId, permissionId: i.id, createdBy: ctx.actor });
      }
      if (ro.adGroups) {
        await tx.delete(roleAdGroup).where(eq(roleAdGroup.roleId, roleId));
        for (const dn of ro.adGroups) await tx.insert(roleAdGroup).values({ roleId, adGroupDn: dn, createdBy: ctx.actor });
      }
      if (ro.companies) {
        await tx.delete(roleCompany).where(eq(roleCompany.roleId, roleId));
        for (const name of ro.companies) {
          let [c] = await tx.select({ id: company.companyId }).from(company).where(eq(company.compName, name));
          if (!c) [c] = await tx.insert(company).output({ id: company.companyId }).values({ compName: name, createdBy: ctx.actor, updatedBy: ctx.actor });
          await tx.insert(roleCompany).values({ roleId, companyId: c!.id, createdBy: ctx.actor });
        }
      }
      await audit(tx, ctx.actor, 'role.apply', 'role', ro.code, ro);
      r.roles++;
    }
    if (r.roles || r.permissions) {
      await bumpAllPermVersions(tx, ctx.actor);
      r.pvBumped = true;
    }

    const policyIds = new Map((await tx.select().from(rateLimitPolicy)).map((p) => [p.code, p.policyId]));
    const upstreamIdOf = async (code: string) => {
      if (upIds.has(code)) return upIds.get(code)!;
      const [u] = await tx.select({ id: upstream.upstreamId }).from(upstream).where(eq(upstream.code, code));
      if (!u) throw new CliError(`上游不存在:${code}`);
      upIds.set(code, u.id);
      return u.id;
    };
    for (const rt of cfg.routes ?? []) {
      const values = {
        name: rt.name,
        systemCode: rt.systemCode,
        method: rt.method,
        publicPath: rt.publicPath,
        routeType: rt.routeType,
        upstreamId: rt.upstream ? await upstreamIdOf(rt.upstream) : null,
        upstreamPath: rt.upstreamPath ?? null,
        authMode: rt.authMode,
        permissionCode: rt.permissionCode ?? null,
        rateLimitPolicyId: rt.rateLimitPolicy ? (policyIds.get(rt.rateLimitPolicy) ?? null) : null,
        timeoutMs: rt.timeoutMs ?? null,
        mockResponse: rt.mockResponse === undefined ? null : JSON.stringify(rt.mockResponse),
        description: rt.description?.trim() || null,
        gherkin: rt.gherkin?.trim() || null,
        source: 'manual',
        status: 'draft',
        updatedBy: ctx.actor,
      };
      let [cur] = await tx.select({ id: apiRoute.routeId }).from(apiRoute).where(eq(apiRoute.routeCode, rt.routeCode));
      if (cur) await tx.update(apiRoute).set(values).where(eq(apiRoute.routeId, cur.id));
      else
        [cur] = await tx
          .insert(apiRoute)
          .output({ id: apiRoute.routeId })
          .values({ routeCode: rt.routeCode, ...values, createdBy: ctx.actor });
      await tx.delete(aggregateStep).where(eq(aggregateStep.routeId, cur!.id));
      for (const s of rt.steps ?? []) {
        await tx.insert(aggregateStep).values({
          routeId: cur!.id,
          stepKey: s.stepKey,
          stepOrder: s.order ?? 1,
          upstreamId: await upstreamIdOf(s.upstream),
          method: s.method ?? 'GET',
          pathTemplate: s.path,
          required: s.required ?? false,
          timeoutMs: s.timeoutMs ?? 5000,
          permissionCode: s.permissionCode ?? null,
          createdBy: ctx.actor,
          updatedBy: ctx.actor,
        });
      }
      r.routes++;
    }
    for (const w of cfg.webhooks ?? []) {
      if (w.verifyMethod === 'hmac_sha256' && !w.secretRef) throw new CliError(`Webhook ${w.source} 使用 hmac_sha256 必須設定 secretRef`);
      const v = {
        verifyMethod: w.verifyMethod,
        secretRef: w.secretRef ?? null,
        signatureHeader: w.signatureHeader ?? null,
        allowedIps: w.allowedIps ?? null,
        dispatchType: w.dispatchType,
        dispatchTarget: w.dispatchTarget,
        isEnabled: w.enabled ?? true,
        updatedBy: ctx.actor,
      };
      const [cur] = await tx.select({ id: webhookEndpoint.endpointId }).from(webhookEndpoint).where(eq(webhookEndpoint.sourceCode, w.source));
      if (cur) await tx.update(webhookEndpoint).set(v).where(eq(webhookEndpoint.endpointId, cur.id));
      else await tx.insert(webhookEndpoint).values({ sourceCode: w.source, ...v, createdBy: ctx.actor });
      await audit(tx, ctx.actor, 'webhook.apply', 'webhook_endpoint', w.source, v);
      r.webhooks++;
    }
    for (const a of cfg.apps ?? []) {
      if (!/^[a-z][a-z0-9-]{0,29}$/.test(a.code)) throw new CliError(`應用代碼格式錯誤:${a.code}`);
      if (!a.basePath.startsWith('/') || !a.basePath.endsWith('/')) throw new CliError(`應用 ${a.code} 的 basePath 需以 / 開頭與結尾`);
      const [perm] = await tx.select({ id: permission.permissionId, kind: permission.kind }).from(permission).where(eq(permission.code, a.permissionCode));
      if (!perm) throw new CliError(`應用 ${a.code} 的權限不存在:${a.permissionCode}`);
      // 應用的進入權限分類為 app(PRD §8.3.2)
      if (perm.kind !== 'app')
        await tx.update(permission).set({ kind: 'app', parentCode: null, updatedBy: ctx.actor }).where(eq(permission.permissionId, perm.id));
      const v = {
        name: a.name,
        basePath: a.basePath,
        icon: a.icon ?? null,
        sort: a.sort ?? 0,
        permissionCode: a.permissionCode,
        isEnabled: a.enabled ?? true,
        updatedBy: ctx.actor,
      };
      const [cur] = await tx.select({ id: appTable.appId }).from(appTable).where(eq(appTable.code, a.code));
      if (cur) await tx.update(appTable).set(v).where(eq(appTable.appId, cur.id));
      else await tx.insert(appTable).values({ code: a.code, ...v, createdBy: ctx.actor });
      await audit(tx, ctx.actor, 'app.apply', 'app', a.code, v);
      r.apps++;
    }
    if (r.apps && !r.pvBumped) {
      // me.apps 依應用登記計算:清除權限版本,下一次請求即重新換發
      await bumpAllPermVersions(tx, ctx.actor);
      r.pvBumped = true;
    }
    for (const t of cfg.notifyTemplates ?? []) {
      const bad = t.channels.filter((c) => !isChannel(c));
      if (bad.length) throw new CliError(`通知範本 ${t.code} 的通道不支援:${bad.join(', ')}`);
      const v = {
        name: t.name,
        channels: JSON.stringify(t.channels),
        emailSubject: t.emailSubject ?? null,
        emailBody: t.emailBody ?? null,
        inappBody: t.inappBody ?? null,
        isEnabled: t.enabled ?? true,
        updatedBy: ctx.actor,
      };
      const [cur] = await tx.select({ id: notifyTemplate.templateId }).from(notifyTemplate).where(eq(notifyTemplate.code, t.code));
      if (cur) await tx.update(notifyTemplate).set(v).where(eq(notifyTemplate.templateId, cur.id));
      else await tx.insert(notifyTemplate).values({ code: t.code, ...v, createdBy: ctx.actor });
      await audit(tx, ctx.actor, 'notify.template.apply', 'notify_template', t.code, { channels: t.channels });
      r.notifyTemplates++;
    }
    await audit(tx, ctx.actor, 'config.apply', 'file', file.slice(-100), { ...r });
    return r;
  });
  if (result.pvBumped) await invalidatePvCache(ctx.redis);
  out(result);
}

async function createLocalAccount(ctx: Ctx, empArg: string, baseUrl: string) {
  const emp = normalizeEmpNo(empArg);
  if (!isValidEmpNo(emp)) throw new CliError(`工號格式錯誤:${empArg}`);
  // 一個工號只有一種驗證方式:任一 AD 網域找得到者必須使用 AD(PRD §8.2.5)
  const ad = new AdDirectory(ctx.config.ldapDomains);
  for (const code of ad.codes) if (await ad.exists(code, emp).catch(() => false)) throw new CliError(`${emp} 在 AD 網域 ${code} 已有帳號,不可建立本機帳號`);

  const ext: { bpm?: ReturnType<typeof createExternalDb>; los?: ReturnType<typeof createExternalDb> } = {};
  const pools = [];
  for (const [name, src] of [
    ['bpm', ctx.config.bpmDb],
    ['los', ctx.config.losDb],
  ] as const) {
    if (!src) continue;
    const p = await openPool(src, { appName: `giganexus-cli-${name}`, poolMax: 1 }).catch(() => null);
    if (p) {
      pools.push(p);
      ext[name] = createExternalDb(p);
    }
  }
  try {
    const lookup = await lookupEmployee(ext, emp);
    if (lookup.selfVirtual) throw new CliError(`${emp} 為兼任帳號,不可單獨登入`);
    const merged = mergeProfile(lookup);
    if (merged.profileSource === 'ad_only') throw new CliError(`${emp} 在 LOS / BPM 查無資料`);
    if (merged.employmentStatus === 'resigned') throw new CliError(`${emp} 已離職`);

    const token = randomBytes(32).toString('base64url');
    const userId = await ctx.db.transaction(async (tx) => {
      let [u] = await tx.select({ id: user.userId }).from(user).where(eq(user.employeeNo, emp));
      if (!u)
        [u] = await tx
          .insert(user)
          .output({ id: user.userId })
          .values({ employeeNo: emp, displayName: merged.displayName ?? emp, profileSource: merged.profileSource, createdBy: ctx.actor, updatedBy: ctx.actor });
      await applyProfile(tx, u!.id, merged, ctx.actor);
      const [cred] = await tx.select().from(localCredential).where(eq(localCredential.userId, u!.id));
      if (cred?.status === 'active') throw new CliError(`${emp} 已有啟用中的本機帳號`);
      if (cred)
        await tx
          .update(localCredential)
          .set({ status: 'pending_verify', registeredVia: 'admin', mustChangePassword: false, updatedBy: ctx.actor })
          .where(eq(localCredential.userId, u!.id));
      else
        await tx
          .insert(localCredential)
          .values({ userId: u!.id, status: 'pending_verify', registeredVia: 'admin', createdBy: ctx.actor, updatedBy: ctx.actor });
      // 同用途新 token 產生時,舊 token 一併作廢
      await tx
        .update(localAccountToken)
        .set({ usedAt: new Date() })
        .where(and(eq(localAccountToken.userId, u!.id), eq(localAccountToken.purpose, 'activate'), isNull(localAccountToken.usedAt)));
      await tx.insert(localAccountToken).values({
        userId: u!.id,
        purpose: 'activate',
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
      });
      await audit(tx, ctx.actor, 'local.create', 'user', emp, { emp, companies: merged.companies.map((c) => c.compName) });
      return u!.id;
    });
    out({ employeeNo: emp, userId, activationToken: token, link: `${baseUrl.replace(/\/$/, '')}/register/activate?token=${token}`, expiresInHours: 72 });
  } finally {
    await Promise.all(pools.map((p) => p.close()));
  }
}

/** 核准自行註冊的待審核申請(PRD §8.2.5:LOS / BPM 查無者由管理員確認身分) */
async function approveLocalAccount(ctx: Ctx, empArg: string, baseUrl: string) {
  const emp = normalizeEmpNo(empArg);
  const [row] = await ctx.db
    .select({ userId: user.userId, status: localCredential.status })
    .from(user)
    .innerJoin(localCredential, eq(localCredential.userId, user.userId))
    .where(eq(user.employeeNo, emp));
  if (row?.status !== 'pending_approval') throw new CliError(`${emp} 沒有待審核的註冊申請`);
  const token = randomBytes(32).toString('base64url');
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(localCredential)
      .set({ status: 'pending_verify', approvedBy: ctx.actor.slice(0, 64), approvedAt: new Date(), updatedBy: ctx.actor })
      .where(eq(localCredential.userId, row.userId));
    await tx
      .update(localAccountToken)
      .set({ usedAt: new Date() })
      .where(and(eq(localAccountToken.userId, row.userId), eq(localAccountToken.purpose, 'activate'), isNull(localAccountToken.usedAt)));
    await tx.insert(localAccountToken).values({
      userId: row.userId,
      purpose: 'activate',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    });
    await audit(tx, ctx.actor, 'local.approve', 'user', emp, {});
  });
  out({ employeeNo: emp, link: `${baseUrl.replace(/\/$/, '')}/register/activate?token=${token}`, expiresInHours: 72 });
}

/** IT 重設密碼(無 Email 者,PRD §8.2.5):臨時密碼只顯示一次,首次登入須更換;撤銷所有登入 */
async function resetLocalPassword(ctx: Ctx, empArg: string) {
  const emp = normalizeEmpNo(empArg);
  const [row] = await ctx.db
    .select({ userId: user.userId, cred: localCredential })
    .from(user)
    .innerJoin(localCredential, eq(localCredential.userId, user.userId))
    .where(eq(user.employeeNo, emp));
  if (!row || !['active', 'locked'].includes(row.cred.status)) throw new CliError(`${emp} 沒有啟用中或鎖定的本機帳號`);
  // 臨時密碼:12 碼英數,保證含英文與數字(符合 Q14)
  const temp = `${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}a1`;
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(localCredential)
      .set({
        passwordHash: await hashPassword(temp),
        passwordHistory: pushHistory(row.cred.passwordHash, row.cred.passwordHistory),
        passwordChangedAt: new Date(),
        status: 'active',
        failedCount: 0,
        lockedAt: null,
        mustChangePassword: true,
        updatedBy: ctx.actor,
      })
      .where(eq(localCredential.userId, row.userId));
    await audit(tx, ctx.actor, 'local.reset', 'user', emp, {});
  });
  const revoked = await revokeUserSessions(ctx.redis, row.userId).catch(() => -1);
  await ctx.redis.del(`gw:login:fail:${emp}`).catch(() => undefined);
  out({ employeeNo: emp, temporaryPassword: temp, mustChangePassword: true, revokedSessions: revoked, message: '臨時密碼只顯示這一次,請以安全管道交給本人' });
}

/** 部門樹同步(PRD §8.3.1);樹結構變更時已遞增全體 perm_version,這裡清除 pv 快取 */
async function syncDepartmentTree(ctx: Ctx, force: boolean) {
  if (!ctx.config.bpmDb) throw new CliError('未設定 BPM_DB_HOST');
  const pool = await openPool(ctx.config.bpmDb, { appName: 'giganexus-cli-bpm', poolMax: 1 });
  try {
    const r = await syncDepartments(ctx.db, createExternalDb(pool), ctx.actor, { force });
    if (r.treeChanged) await invalidatePvCache(ctx.redis);
    await ctx.db.transaction((tx) => audit(tx, ctx.actor, 'department.sync', 'department', 'bpm', r));
    out(r);
  } catch (err) {
    if (err instanceof DepartmentSyncAborted) throw new CliError(err.message);
    if (/OrganizationUnit|Organization'|permission was denied/i.test((err as Error).message))
      throw new CliError(`bpm_reader 尚無組織資料表的唯讀權限,請 DBA 執行 db/dba/03-bpm-org-grant.sql(${(err as Error).message})`);
    throw err;
  } finally {
    await pool.close();
  }
}

async function setUserDisabled(ctx: Ctx, empArg: string, disabled: boolean) {
  const emp = normalizeEmpNo(empArg);
  const [u] = await ctx.db.select({ id: user.userId }).from(user).where(eq(user.employeeNo, emp));
  if (!u) throw new CliError(`找不到使用者 ${emp}`);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(user)
      .set({ isDisabled: disabled, permVersion: sql`${user.permVersion} + 1`, updatedBy: ctx.actor })
      .where(eq(user.userId, u.id));
    await audit(tx, ctx.actor, disabled ? 'user.disable' : 'user.enable', 'user', emp, { disabled });
  });
  // 強制登出:撤銷 Refresh Token 家族;舊 Access Token 因 pv 變更下一次請求即失效
  const families = await ctx.redis.smembers(`gw:user:rt:${u.id}`);
  if (families.length) await ctx.redis.del(...families.map((f) => `gw:rt:${f}`), `gw:user:rt:${u.id}`);
  await ctx.redis.del(`gw:pv:${u.id}`);
  out({ employeeNo: emp, disabled, revokedSessions: families.length });
}

/** 後端服務 API Key 的預設權限:自動註冊與路由查詢(BACKEND-GUIDE.md §7.5) */
const DEFAULT_CLIENT_PERMS = ['gw.admin.route.register', 'gw.admin.route.read'];

/** 建立 API Key;代碼已存在時換發(舊金鑰立即失效)。明文只輸出這一次,不寫入 log 與稽核 */
async function createApiClient(ctx: Ctx, code: string, opts: { name?: string; perms?: string[]; ips?: string; expiresDays?: string }) {
  if (!/^[a-z][a-z0-9-]{1,49}$/.test(code)) throw new CliError(`服務代碼格式錯誤:${code}`);
  const permCodes = opts.perms?.length ? opts.perms : DEFAULT_CLIENT_PERMS;
  const perms = await ctx.db.select({ id: permission.permissionId, code: permission.code }).from(permission).where(inArray(permission.code, permCodes));
  const unknown = permCodes.filter((c) => !perms.some((p) => p.code === c));
  if (unknown.length) throw new CliError(`權限不存在:${unknown.join(', ')}`);
  const days = opts.expiresDays ? Number(opts.expiresDays) : null;
  if (days !== null && !(days > 0)) throw new CliError(`--expires-days 需為正數:${opts.expiresDays}`);
  const { key, keyPrefix, keyHash } = await generateApiKey();
  const values = {
    name: opts.name ?? code,
    keyPrefix,
    keyHash,
    allowedIps: opts.ips ?? null,
    expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null,
    isEnabled: true,
    updatedBy: ctx.actor,
  };
  const [cur] = await ctx.db.select().from(apiClient).where(eq(apiClient.code, code));
  await ctx.db.transaction(async (tx) => {
    let clientId = cur?.clientId;
    if (cur) {
      await tx.update(apiClient).set(values).where(eq(apiClient.clientId, cur.clientId));
      await tx.delete(apiClientPermission).where(eq(apiClientPermission.clientId, cur.clientId));
    } else {
      const [row] = await tx
        .insert(apiClient)
        .output({ id: apiClient.clientId })
        .values({ code, ...values, createdBy: ctx.actor });
      clientId = row!.id;
    }
    for (const p of perms) await tx.insert(apiClientPermission).values({ clientId: clientId!, permissionId: p.id });
    await audit(tx, ctx.actor, cur ? 'client.rotate' : 'client.create', 'api_client', code, {
      keyPrefix,
      permissions: permCodes,
      allowedIps: values.allowedIps,
      expiresAt: values.expiresAt,
    });
  });
  if (cur) await ctx.redis.del(clientKey(cur.keyPrefix));
  out({
    code,
    rotated: !!cur,
    keyPrefix,
    key,
    permissions: permCodes,
    expiresAt: values.expiresAt,
    message: '明文 API Key 只顯示這一次,請存入該服務的 Docker secret',
  });
}

async function disableApiClient(ctx: Ctx, code: string) {
  const [cur] = await ctx.db.select().from(apiClient).where(eq(apiClient.code, code));
  if (!cur) throw new CliError(`找不到 API Key:${code}`);
  await ctx.db.transaction(async (tx) => {
    await tx.update(apiClient).set({ isEnabled: false, updatedBy: ctx.actor }).where(eq(apiClient.clientId, cur.clientId));
    await audit(tx, ctx.actor, 'client.disable', 'api_client', code, { keyPrefix: cur.keyPrefix });
  });
  // 提交後直接刪除快取(DATABASE.md §7.2)
  await ctx.redis.del(clientKey(cur.keyPrefix));
  out({ code, disabled: true });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      file: { type: 'string' },
      target: { type: 'string' },
      env: { type: 'string', default: 'test' },
      note: { type: 'string' },
      to: { type: 'string' },
      emp: { type: 'string' },
      'base-url': { type: 'string', default: 'https://localhost' },
      actor: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
      perm: { type: 'string', multiple: true },
      ips: { type: 'string' },
      'expires-days': { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  if (!command || command === 'help') {
    console.log('用法見 bff/src/cli/index.ts 檔頭註解');
    return;
  }
  const config = loadConfig();
  const pool = await openPool(config.gwDb, { appName: 'giganexus-cli', poolMax: 2 });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect().catch(() => undefined);
  const ctx: Ctx = { config, db: createGwDb(pool, config.sql2012Guard), redis, actor: values.actor ?? `cli:${userInfo().username}` };
  const need = (v: string | undefined, name: string) => {
    if (!v) throw new CliError(`缺少參數 --${name}`);
    return v;
  };
  try {
    switch (command) {
      case 'import-openapi':
        await importOpenApi(ctx, need(values.file, 'file'), need(values.target, 'target'), values.env === 'prod' ? 'prod' : 'test');
        break;
      case 'apply':
        await applyConfig(ctx, need(values.file, 'file'));
        break;
      case 'publish': {
        const r = await publishRelease(ctx.db, ctx.redis, { actor: ctx.actor, note: values.note, environment: config.gwEnv });
        out(r.redisSynced ? r : { ...r, message: '已發佈,同步中(Redis 更新失敗,由補償機制於 60 秒內修正)' });
        break;
      }
      case 'rollback':
        out(await rollbackRelease(ctx.db, ctx.redis, { actor: ctx.actor, toVersion: Number(need(values.to, 'to')), note: values.note }));
        break;
      case 'releases':
        out(
          await ctx.db
            .select({
              version: configRelease.releaseId,
              publishedBy: configRelease.publishedBy,
              publishedAt: configRelease.publishedAt,
              note: configRelease.note,
              rolledBackFrom: configRelease.rolledBackFrom,
              diff: configRelease.diffSummary,
            })
            .top(20)
            .from(configRelease)
            .orderBy(desc(configRelease.releaseId)),
        );
        break;
      case 'local:create':
        await createLocalAccount(ctx, need(values.emp, 'emp'), values['base-url']!);
        break;
      case 'local:unlock': {
        const emp = normalizeEmpNo(need(values.emp, 'emp'));
        const [u] = await ctx.db.select({ id: user.userId }).from(user).where(eq(user.employeeNo, emp));
        if (!u) throw new CliError(`找不到使用者 ${emp}`);
        await ctx.db.transaction(async (tx) => {
          await tx
            .update(localCredential)
            .set({ status: 'active', failedCount: 0, lockedAt: null, updatedBy: ctx.actor })
            .where(and(eq(localCredential.userId, u.id), eq(localCredential.status, 'locked')));
          await audit(tx, ctx.actor, 'local.unlock', 'user', emp, {});
        });
        await ctx.redis.del(`gw:login:fail:${emp}`);
        out({ employeeNo: emp, unlocked: true });
        break;
      }
      case 'local:approve':
        await approveLocalAccount(ctx, need(values.emp, 'emp'), values['base-url']!);
        break;
      case 'local:reset':
        await resetLocalPassword(ctx, need(values.emp, 'emp'));
        break;
      case 'user:disable':
      case 'user:enable':
        await setUserDisabled(ctx, need(values.emp, 'emp'), command === 'user:disable');
        break;
      case 'client:create':
        await createApiClient(ctx, need(values.code, 'code'), { name: values.name, perms: values.perm, ips: values.ips, expiresDays: values['expires-days'] });
        break;
      case 'client:disable':
        await disableApiClient(ctx, need(values.code, 'code'));
        break;
      case 'dept:sync':
        await syncDepartmentTree(ctx, values.force === true);
        break;
      default:
        throw new CliError(`未知的指令:${command}`);
    }
  } finally {
    await pool.close();
    redis.disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof CliError || err instanceof ImportError) {
    console.error(`錯誤:${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else console.error(err);
  process.exit(1);
});
