import fp from 'fastify-plugin';
import type sql from 'mssql';
import type { AppConfig, SqlSourceConfig } from '../config.js';
import { createGwDb, openPool, type GwDatabase } from '../db/client.js';
import { createExternalDb } from '../db/external/index.js';

export type ExternalDb = ReturnType<typeof createExternalDb>;

declare module 'fastify' {
  interface FastifyInstance {
    db: GwDatabase;
    gwPool: sql.ConnectionPool;
    /** 外部唯讀來源:BPM、LOS、PortalSolar(各自連線池與唯讀帳號,DATABASE.md §8.1);未設定或連不上時為 undefined */
    ext: { bpm?: ExternalDb; los?: ExternalDb; portal?: ExternalDb };
  }
}

/**
 * giganexus_gw 讀寫連線池(每實例 max 10)+ 外部唯讀連線池(每實例 max 3,TECH-STACK.md §4)。
 * 外部來源連不上不影響啟動(登入補查失敗時以 AD 資料登入)。
 */
export default fp<{ config: AppConfig }>(
  async (app, { config }) => {
    const pool = await openPool(config.gwDb, { appName: 'giganexus-bff', poolMax: config.gwDb.poolMax });
    pool.on('error', (err) => app.log.error({ err }, 'giganexus_gw 連線池錯誤'));
    app.decorate('gwPool', pool);
    app.decorate('db', createGwDb(pool, config.sql2012Guard));

    const ext: { bpm?: ExternalDb; los?: ExternalDb; portal?: ExternalDb } = {};
    const pools: sql.ConnectionPool[] = [pool];
    const timers: NodeJS.Timeout[] = [];
    const openExternal = async (name: 'bpm' | 'los' | 'portal', src: SqlSourceConfig | undefined, guard: boolean): Promise<boolean> => {
      if (!src) return true;
      try {
        const p = await openPool(src, { appName: `giganexus-bff-${name}`, poolMax: 3, connectTimeoutMs: 3_000, requestTimeoutMs: 5_000 });
        p.on('error', (err) => app.log.warn({ err: err.message, source: name }, '外部資料庫連線池錯誤'));
        pools.push(p);
        ext[name] = createExternalDb(p, guard ? config.sql2012Guard : 'off');
        return true;
      } catch (err) {
        app.log.warn({ err: (err as Error).message, source: name }, '外部資料庫無法連線,稍後重試(登入時以 AD 資料為準)');
        return false;
      }
    };
    // 啟動時連不上的來源每 60 秒重試
    const retryLater = (name: 'bpm' | 'los' | 'portal', src: SqlSourceConfig | undefined, guard: boolean) => {
      const t = setInterval(() => {
        void openExternal(name, src, guard).then((ok) => ok && clearInterval(t));
      }, 60_000);
      t.unref();
      timers.push(t);
    };
    const sources = [
      ['bpm', config.bpmDb, false],
      ['los', config.losDb, true],
      ['portal', config.portalDb, true],
    ] as const;
    await Promise.all(sources.map(async ([name, src, guard]) => (await openExternal(name, src, guard)) || retryLater(name, src, guard)));
    app.decorate('ext', ext);

    app.addHook('onClose', async () => {
      timers.forEach(clearInterval);
      await Promise.all(pools.map((p) => p.close().catch(() => undefined)));
    });
  },
  { name: 'db' },
);
