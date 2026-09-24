/**
 * 本機帳號密碼(PRD §8.2.5):
 *   - 只存 Argon2id 雜湊(OWASP:m = 19 MiB、t = 2、p = 1)
 *   - 政策(Q14):至少 8 碼、英文與數字混合、不含工號、不可與前 3 次相同
 */
import { hash, verify } from '@node-rs/argon2';

const ARGON2 = { algorithm: 2 /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
export const PASSWORD_HISTORY_SIZE = 3;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

export type PolicyRule = 'min_length' | 'letter' | 'digit' | 'contains_employee_no';

export function checkPasswordPolicy(password: string, employeeNo: string): PolicyRule[] {
  const failed: PolicyRule[] = [];
  if (password.length < 8) failed.push('min_length');
  if (!/[A-Za-z]/.test(password)) failed.push('letter');
  if (!/[0-9]/.test(password)) failed.push('digit');
  if (employeeNo && password.toUpperCase().includes(employeeNo.toUpperCase())) failed.push('contains_employee_no');
  return failed;
}

export const POLICY_MESSAGES: Record<PolicyRule, string> = {
  min_length: '至少 8 碼',
  letter: '需包含英文字母',
  digit: '需包含數字',
  contains_employee_no: '不可包含工號',
};

export function parseHistory(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 新密碼是否與目前或前 3 次相同 */
export async function isReused(password: string, current: string | null, historyJson: string | null): Promise<boolean> {
  for (const h of [current, ...parseHistory(historyJson)]) if (h && (await verifyPassword(h, password))) return true;
  return false;
}

export function pushHistory(current: string | null, historyJson: string | null): string {
  return JSON.stringify([...(current ? [current] : []), ...parseHistory(historyJson)].slice(0, PASSWORD_HISTORY_SIZE));
}
