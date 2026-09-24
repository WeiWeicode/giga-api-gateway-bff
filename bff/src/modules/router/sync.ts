/**
 * 路由快照載入與同步(PRD §8.4.2、DATABASE.md §7.3):
 *   啟動:Redis → SQL Server → 本地快照檔(三層退路)
 *   執行中:訂閱 gw:config:changed 即時重載;每 60 秒比對版本作為 Pub/Sub 遺漏的保險,並執行補償
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { GwDatabase } from '../../db/client.js';
import { CHANGED_CHANNEL, compensate, latestRelease, SNAPSHOT_KEY } from '../../db/sync/release.js';
import type { RouteSnapshot } from './snapshot.js';
import type { RouteTable } from './table.js';

export class RouteSync {
  private sub: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  lastSource: 'redis' | 'db' | 'file' | 'none' = 'none';

  constructor(
    private readonly deps: {
      db: GwDatabase;
      redis: Redis;
      table: RouteTable;
      log: FastifyBaseLogger;
      snapshotFile: string;
      instanceId: string;
      intervalMs: number;
    },
  ) {}

  private apply(snapshot: RouteSnapshot, source: 'redis' | 'db' | 'file'): boolean {
    const { table, log } = this.deps;
    const before = table.version;
    if (!table.apply(snapshot)) return false;
    this.lastSource = source;
    for (const w of table.warnings) log.warn(w);
    log.info({ from: before, to: snapshot.version, source, routes: snapshot.routes.length }, '路由表已更新');
    if (source !== 'file') void this.saveFile(snapshot);
    return true;
  }

  private async saveFile(snapshot: RouteSnapshot): Promise<void> {
    const file = this.deps.snapshotFile;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot));
      await rename(tmp, file);
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message, file }, '無法寫入本地路由快照檔');
    }
  }

  private async fromRedis(): Promise<RouteSnapshot | null> {
    const raw = await this.deps.redis.get(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as RouteSnapshot) : null;
  }

  /** 啟動時載入:任一層成功即可提供服務 */
  async load(): Promise<void> {
    const { db, log, snapshotFile } = this.deps;
    try {
      const s = await this.fromRedis();
      if (s) this.apply(s, 'redis');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Redis 無法讀取路由快照,改讀 SQL Server');
    }
    try {
      const s = await latestRelease(db);
      if (s) this.apply(s, 'db'); // 資料庫版本較新時(Redis 落後)以資料庫為準
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'SQL Server 無法讀取路由快照');
    }
    if (this.deps.table.version === 0) {
      try {
        this.apply(JSON.parse(await readFile(snapshotFile, 'utf8')) as RouteSnapshot, 'file');
        log.warn({ file: snapshotFile }, 'Redis 與 SQL Server 皆不可用,以本地最後快照檔建立路由樹');
      } catch {
        log.warn('尚無任何已發佈的路由');
      }
    }
  }

  async start(): Promise<void> {
    await this.load();
    const { redis, log } = this.deps;
    this.sub = redis.duplicate({ connectionName: `${this.deps.instanceId}-sub`, enableOfflineQueue: true });
    this.sub.on('error', (err) => log.warn({ err: err.message }, 'Redis 訂閱連線錯誤'));
    this.sub.on('message', (_channel, message) => {
      const v = Number(message);
      if (v > this.deps.table.version) void this.reloadFromRedis(v);
    });
    await this.sub.subscribe(CHANGED_CHANNEL).catch((err: Error) => log.warn({ err: err.message }, '無法訂閱 gw:config:changed'));
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.timer.unref();
  }

  private async reloadFromRedis(expected: number): Promise<void> {
    try {
      const s = await this.fromRedis();
      if (s && s.version >= expected) {
        this.apply(s, 'redis');
        return;
      }
      const d = await latestRelease(this.deps.db);
      if (d) this.apply(d, 'db');
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, '重載路由快照失敗,等待下次比對');
    }
  }

  /** 定期比對:補償 Redis 落後,並確保本實例不落後 */
  async tick(): Promise<void> {
    try {
      const r = await compensate(this.deps.db, this.deps.redis, this.deps.instanceId);
      if (r.pushed) this.deps.log.warn(r, 'Redis 路由版本落後資料庫,已重推快照');
      if (this.deps.table.version < Math.max(r.dbVersion, r.redisVersion)) await this.reloadFromRedis(r.dbVersion);
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, '路由版本比對失敗');
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.sub?.disconnect();
  }
}
