/**
 * W3-1.1 Drizzle × SQL Server PoC(IMPL-PLAN §4.1 檢查表)
 *
 * 本機 / CI 容器為 SQL Server 2022(相容層級 110),所有 Drizzle 產生的 SQL 皆經 2012 語法檢查(guard=error)。
 * M0 Go / No-Go 需再以同一組測試對真正的 SQL Server 2012 RTM(P-04)執行:
 *   GW_DB_HOST=<2012 主機> GW_TEST_DB_NAME=giganexus_gw_test npm run test:int
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPool } from '../../src/db/client.js';
import { bpmEmployee, createExternalDb, losEmployee, portalLoginData } from '../../src/db/external/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { apiRoute, auditLog, configRelease, permission, role, upstream, user } from '../../src/db/schema/index.js';
import { Sql2012CompatError } from '../../src/db/sql2012-guard.js';
import { openMigratePool, openTestDb, uniq, type TestDb } from './helpers.js';

let t: TestDb;
const actor = { createdBy: 'poc', updatedBy: 'poc' };

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t?.close();
});

async function newUpstream(code = uniq('up')) {
  const [row] = await t.db
    .insert(upstream)
    .output()
    .values({ code, name: 'PoC 上游', systemCode: 'mes', ...actor });
  return row!;
}

describe('① 連線:mssql / tedious,encrypt: false', () => {
  it('以 BFF 專屬帳號連上 giganexus_gw(相容層級 110)', async () => {
    const r = await t.pool.request().query<{ db: string; login: string; compat: number }>(
      `SELECT DB_NAME() AS db, SUSER_SNAME() AS login,
              (SELECT compatibility_level FROM sys.databases WHERE name = DB_NAME()) AS compat`,
    );
    expect(r.recordset[0]).toEqual({ db: t.config.gwDb.database, login: t.config.gwDb.user, compat: 110 });
    expect(t.config.gwDb.encrypt).toBe(false);
  });
});

describe('② 資料型別:INT IDENTITY、DATETIME2(3)、NVARCHAR(MAX)、UNIQUEIDENTIFIER、ROWVERSION', () => {
  it('寫入與讀回型別正確', async () => {
    const guid = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
    const longJson = JSON.stringify({ groups: Array.from({ length: 500 }, (_, i) => `CN=GN-群組-${i},OU=Groups,DC=gsc,DC=com,DC=tw`) });
    const [u] = await t.db
      .insert(user)
      .output()
      .values({
        employeeNo: uniq('T').slice(0, 20),
        displayName: '測試員工',
        profileSource: 'ad_only',
        adObjectGuid: guid.toLowerCase(),
        adGroups: longJson,
        ...actor,
      });
    expect(u!.userId).toBeTypeOf('number');
    expect(u!.adObjectGuid).toBe(guid);
    expect(u!.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(u!.createdAt.getTime() - Date.now())).toBeLessThan(60_000); // UTC 儲存、正確還原
    expect(u!.rowVer).toBeInstanceOf(Buffer);
    expect(u!.rowVer.length).toBe(8);
    expect(u!.isDisabled).toBe(false);

    const [back] = await t.db.select().from(user).where(eq(user.userId, u!.userId));
    expect(back!.adGroups).toBe(longJson);
    expect(back!.adGroups!.length).toBeGreaterThan(4000);
    expect(back!.displayName).toBe('測試員工');
  });
});

describe('③ drizzle-kit generate 的 SQL 可在 2012 執行', () => {
  it('migration 可重複執行,已套用的版本不重跑', async () => {
    const count = async () => {
      const pool = await openMigratePool();
      try {
        return (await pool.request().query<{ n: number }>('SELECT COUNT(*) AS n FROM drizzle.__drizzle_migrations')).recordset[0]!.n;
      } finally {
        await pool.close();
      }
    };
    const before = await count();
    await runMigrations({ database: t.config.gwDb.database });
    expect(before).toBeGreaterThanOrEqual(1);
    expect(await count()).toBe(before);
  }, 120_000);
  // 語法靜態檢查見 unit/sql2012-guard.test.ts「所有 migration 皆無 2012 不支援的語法」
});

describe('④ 篩選唯一索引:(method, public_path) WHERE status <> disabled', () => {
  it('停用的路由不佔用路徑;兩條啟用中的相同路徑會衝突', async () => {
    const up = await newUpstream();
    const path = `/api/mes/${uniq('p')}`;
    const route = (status: string) => ({
      routeCode: uniq('mes.poc'),
      name: 'PoC',
      systemCode: 'mes',
      method: 'GET',
      publicPath: path,
      routeType: 'proxy',
      upstreamId: up.upstreamId,
      authMode: 'authenticated',
      status,
      ...actor,
    });
    await t.db.insert(apiRoute).values(route('disabled'));
    await t.db.insert(apiRoute).values(route('disabled'));
    await t.db.insert(apiRoute).values(route('draft'));
    await expect(t.db.insert(apiRoute).values(route('published'))).rejects.toThrow(/duplicate key|uq_api_route_method_path_active/);
  });
});

describe('⑤ 增刪改查與交易', () => {
  it('CRUD', async () => {
    const up = await newUpstream();
    await t.db.update(upstream).set({ name: '改名', updatedBy: 'poc2' }).where(eq(upstream.upstreamId, up.upstreamId));
    const [after] = await t.db.select().from(upstream).where(eq(upstream.upstreamId, up.upstreamId));
    expect(after).toMatchObject({ name: '改名', updatedBy: 'poc2' });
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(up.updatedAt.getTime());
    await t.db.delete(upstream).where(eq(upstream.upstreamId, up.upstreamId));
    expect(await t.db.select().from(upstream).where(eq(upstream.upstreamId, up.upstreamId))).toEqual([]);
  });

  it('交易失敗整筆回滾(含稽核紀錄)', async () => {
    const code = uniq('tx');
    await expect(
      t.db.transaction(async (tx) => {
        await tx.insert(upstream).values({ code, name: 'tx', systemCode: 'mes', ...actor });
        await tx.insert(auditLog).values({ action: 'upstream.create', entityType: 'upstream', entityId: code });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await t.db.select().from(upstream).where(eq(upstream.code, code))).toEqual([]);
    expect(await t.db.select().from(auditLog).where(eq(auditLog.entityId, code))).toEqual([]);
  });

  it('巢狀交易(savepoint)只回滾內層', async () => {
    const outer = uniq('outer');
    const inner = uniq('inner');
    await t.db.transaction(async (tx) => {
      await tx.insert(upstream).values({ code: outer, name: 'o', systemCode: 'mes', ...actor });
      await tx
        .transaction(async (tx2) => {
          await tx2.insert(upstream).values({ code: inner, name: 'i', systemCode: 'mes', ...actor });
          throw new Error('inner');
        })
        .catch(() => undefined);
    });
    const rows = await t.db
      .select({ code: upstream.code })
      .from(upstream)
      .where(inArray(upstream.code, [outer, inner]));
    expect(rows.map((r) => r.code)).toEqual([outer]);
  });
});

describe('⑥ 分頁:OFFSET … FETCH、TOP', () => {
  it('產生 2012 可用的分頁語法', async () => {
    const q = t.db.select({ code: permission.code }).from(permission).orderBy(asc(permission.code)).offset(5).fetch(5);
    expect(q.toSQL().sql).toMatch(/offset @par\d+ rows fetch next @par\d+ rows only/i);
    const all = await t.db.select({ code: permission.code }).from(permission).orderBy(asc(permission.code));
    expect(await q).toEqual(all.slice(5, 10));

    const top = t.db.select({ code: role.code }).top(2).from(role).orderBy(asc(role.code));
    expect(top.toSQL().sql).toMatch(/^select top\(@par\d+\)/i);
    expect(await top).toHaveLength(2);
  });
});

describe('⑦ ROWVERSION 樂觀鎖', () => {
  it('以 row_ver 比對更新,過期版本可偵測衝突', async () => {
    const up = await newUpstream();
    const staleVer = up.rowVer;

    const first = await t.db
      .update(upstream)
      .set({ name: 'A 先存', updatedBy: 'a' })
      .output({ inserted: { rowVer: upstream.rowVer } })
      .where(and(eq(upstream.upstreamId, up.upstreamId), eq(upstream.rowVer, staleVer)));
    expect(first).toHaveLength(1);
    expect(first[0]!.inserted.rowVer.equals(staleVer)).toBe(false);

    const second = await t.db
      .update(upstream)
      .set({ name: 'B 後存', updatedBy: 'b' })
      .output({ inserted: { rowVer: upstream.rowVer } })
      .where(and(eq(upstream.upstreamId, up.upstreamId), eq(upstream.rowVer, staleVer)));
    expect(second).toHaveLength(0); // 衝突 → 管理 API 回 409

    const [now] = await t.db.select({ name: upstream.name }).from(upstream).where(eq(upstream.upstreamId, up.upstreamId));
    expect(now!.name).toBe('A 先存');
  });
});

describe('⑧ Migration 記錄已套用版本', () => {
  it('drizzle.__drizzle_migrations 記錄每個 migration 的 hash 與名稱;BFF 帳號無權讀取', async () => {
    const pool = await openMigratePool();
    try {
      const r = await pool
        .request()
        .query<{ name: string; hash: string }>(
          'SELECT CAST(name AS NVARCHAR(200)) AS name, CAST(hash AS NVARCHAR(100)) AS hash FROM drizzle.__drizzle_migrations ORDER BY id',
        );
      expect(r.recordset[0]!.name).toMatch(/_init$/);
      expect(r.recordset.every((x) => x.hash.length > 0)).toBe(true);
    } finally {
      await pool.close();
    }
    await expect(t.pool.request().query('SELECT 1 FROM drizzle.__drizzle_migrations')).rejects.toThrow(/permission was denied/i);
  });
});

describe('⑨ 100 並行查詢下連線池穩定(max 10)', () => {
  it('全部成功,連線數不超過上限', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        t.db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(permission)
          .where(sql`${i} >= 0`),
      ),
    );
    expect(results).toHaveLength(100);
    expect(new Set(results.map((r) => r[0]!.n)).size).toBe(1);
    expect(t.pool.size).toBeLessThanOrEqual(10);
  });
});

describe('⑩ 外部唯讀資料來源:BPM(2019,encrypt: true)與 LOS / PortalSolar(2012,encrypt: false)', () => {
  it('以唯讀 schema 查詢三個來源,並無法讀取個資原始表', async () => {
    const { losDb, bpmDb, portalDb } = t.config;
    if (!losDb || !bpmDb || !portalDb) throw new Error('需設定 LOS_DB_* / BPM_DB_* / PORTAL_DB_*');
    expect(bpmDb.encrypt).toBe(true);
    expect(losDb.encrypt).toBe(false);

    const [bpmPool, losPool, portalPool] = await Promise.all([
      openPool(bpmDb, { appName: 'giganexus-gw-test-bpm', poolMax: 3 }),
      openPool(losDb, { appName: 'giganexus-gw-test-los', poolMax: 3 }),
      openPool(portalDb, { appName: 'giganexus-gw-test-portal', poolMax: 3 }),
    ]);
    try {
      const bpm = createExternalDb(bpmPool);
      const los = createExternalDb(losPool, 'error');
      const portal = createExternalDb(portalPool, 'error');

      const [b] = await bpm.select().from(bpmEmployee).where(eq(bpmEmployee.employeeNo, 'S112009'));
      // 只驗欄位對應:職稱、主管會隨 BPM 人事異動(2026-10-02 起 S112009 主管為 S094009、職稱「一般人員」)
      expect(b).toMatchObject({ deptCode: 'S1800', title: expect.toBeOneOf([null, expect.any(String)]), managerEmployeeNo: expect.stringMatching(/^S\d{6}$/) });

      const [l] = await los.select().from(losEmployee).where(eq(losEmployee.userId, 'S112009'));
      // 同上,部門與日期會異動;日期驗 view 的 CONVERT(…, 103) 字串格式(profile.ts parseLosDate 允許前導 0)
      expect(l).toMatchObject({
        efDept: expect.stringMatching(/^S\d{4}$/),
        jobName: '工程師',
        leaveDate: expect.stringMatching(/^\d{1,2}\/\d{1,2}\/\d{4}$/),
        isVUser: false,
      });
      expect(l).not.toHaveProperty('ID');

      const [p] = await portal.select().from(portalLoginData).where(eq(portalLoginData.pid, 'V112001'));
      expect(p).toMatchObject({ pid: 'V112001', certify: 'NoPass' });

      await expect(losPool.request().query('SELECT TOP 1 ID FROM dbo.EmployeeInfo')).rejects.toThrow(/permission was denied/i);
      await expect(portalPool.request().query('SELECT TOP 1 EName FROM dbo.LoginData')).rejects.toThrow(/permission was denied/i);
    } finally {
      await Promise.all([bpmPool.close(), losPool.close(), portalPool.close()]);
    }
  });
});

describe('補充:權限與 2012 語法防護', () => {
  it('BFF 帳號不可修改或刪除稽核紀錄', async () => {
    const entityId = uniq('audit');
    await t.db.insert(auditLog).values({ action: 'poc.test', entityType: 'poc', entityId });
    await expect(t.db.update(auditLog).set({ action: 'tampered' }).where(eq(auditLog.entityId, entityId))).rejects.toThrow(/UPDATE permission was denied/i);
    await expect(t.db.delete(auditLog).where(eq(auditLog.entityId, entityId))).rejects.toThrow(/DELETE permission was denied/i);
  });

  it('執行期 SQL 含 2016+ 語法時,測試環境直接失敗', async () => {
    await expect(t.db.execute(sql`select string_agg(${role.code}, ',') from ${role}`)).rejects.toThrow(Sql2012CompatError);
  });

  it('發佈快照以 NVARCHAR(MAX) 儲存,由應用層解析 JSON', async () => {
    const snapshot = { version: 1, routes: [{ code: 'mes.workorder.get', path: '/api/mes/work-orders/:id' }] };
    const [rel] = await t.db
      .insert(configRelease)
      .output({ id: configRelease.releaseId })
      .values({ snapshot: JSON.stringify(snapshot), publishedBy: 'poc' });
    const [back] = await t.db.select({ snapshot: configRelease.snapshot }).from(configRelease).where(eq(configRelease.releaseId, rel!.id));
    expect(JSON.parse(back!.snapshot)).toEqual(snapshot);
  });
});
