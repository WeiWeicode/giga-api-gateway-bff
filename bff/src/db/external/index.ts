import type sql from 'mssql';
import { drizzle } from 'drizzle-orm/node-mssql';
import { Sql2012GuardLogger, type Sql2012GuardMode } from '../client.js';

export { bpmEmployee, bpmOrganization, bpmOrganizationUnit } from './bpm.js';
export { losEmployee } from './los.js';
export { portalLoginData } from './portal.js';

/**
 * 外部唯讀資料庫的 Drizzle 執行個體(每個來源各自一個連線池與唯讀帳號,DATABASE.md §8.1)。
 * BPM 為 SQL Server 2019,不套用 2012 語法檢查。
 */
export function createExternalDb(pool: sql.ConnectionPool, guard: Sql2012GuardMode = 'off') {
  return drizzle({ client: pool, ...(guard === 'off' ? {} : { logger: new Sql2012GuardLogger(guard) }) });
}
