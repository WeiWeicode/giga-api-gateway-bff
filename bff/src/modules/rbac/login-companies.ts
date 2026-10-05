/**
 * 分階段開放的公司(config.loginCompanies,環境變數 LOGIN_COMPANIES):
 * 只有所屬公司在清單內的使用者可登入 / 換發 Token,管理端人員與部門清單也只列這些公司。清單為空 = 不限。
 */
import { inArray } from 'drizzle-orm';
import type { GwDatabase } from '../../db/client.js';
import { company } from '../../db/schema/index.js';

/** 使用者所屬公司(啟用中的 comp_name)是否有任一家已開放 */
export function companyOpen(allowed: string[], companies: string[]): boolean {
  return !allowed.length || companies.some((c) => allowed.includes(c));
}

/** 已開放公司的 company_id;不限時回 null */
export async function openCompanyIds(db: GwDatabase, allowed: string[]): Promise<number[] | null> {
  if (!allowed.length) return null;
  const rows = await db.select({ id: company.companyId }).from(company).where(inArray(company.compName, allowed));
  return rows.map((r) => r.id);
}
