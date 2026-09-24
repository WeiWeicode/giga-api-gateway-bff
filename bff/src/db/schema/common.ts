import { sql } from 'drizzle-orm';
import { customType, datetime2, mssqlSchema, nvarchar } from 'drizzle-orm/mssql-core';

/** 所有 Gateway 資料表置於 schema `gw`(DATABASE.md)。schema 由 DBA 建立,migration 不建立。 */
export const gw = mssqlSchema('gw').existing();

/**
 * ROWVERSION(樂觀鎖)。由 SQL Server 自動維護,應用程式只讀取、在 UPDATE 的 WHERE 比對。
 * 驅動回傳 8 bytes Buffer;對外(API)以 hex 字串表示,見 rowVerToHex / rowVerFromHex。
 */
export const rowversion = customType<{ data: Buffer; driverData: Buffer; notNull: true; default: true }>({
  dataType() {
    return 'rowversion';
  },
});

/** UNIQUEIDENTIFIER(AD objectGUID 等),以大寫字串表示。 */
export const uniqueidentifier = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'uniqueidentifier';
  },
  fromDriver(value) {
    return value.toUpperCase();
  },
});

/** 時間一律以 UTC 儲存(SYSUTCDATETIME),時區在應用層轉換。 */
export const utcNow = sql`sysutcdatetime()`;

export const createdAt = () => datetime2('created_at', { precision: 3 }).notNull().default(utcNow);

/** ★共通欄位:created_at/by、updated_at/by、row_ver */
export const auditColumns = () => ({
  createdAt: createdAt(),
  createdBy: nvarchar('created_by', { length: 64 }).notNull(),
  updatedAt: datetime2('updated_at', { precision: 3 })
    .notNull()
    .default(utcNow)
    .$onUpdate(() => new Date()),
  updatedBy: nvarchar('updated_by', { length: 64 }).notNull(),
  rowVer: rowversion('row_ver').notNull(),
});

export function rowVerToHex(v: Buffer): string {
  return v.toString('hex');
}

export function rowVerFromHex(hex: string): Buffer {
  if (!/^[0-9a-f]{16}$/i.test(hex)) throw new Error('row_ver 格式錯誤');
  return Buffer.from(hex, 'hex');
}
