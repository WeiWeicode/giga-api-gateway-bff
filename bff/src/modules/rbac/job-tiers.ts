/**
 * 職級門檻(v0.12,2026-10-05 需求方決定):部門權限依門檻授予。
 *
 *   gw.user.job_level 為 BPM FunctionLevel.levelValue(> LOS JobLevel),數字越小職位越高;「以上」= job_level ≤ 門檻。
 *   全員不看職級(一般人員實際為 8、9,另有職級空白者);職級空白或非數字者只符合「全員」。
 *   門檻值以碩禾 / 禾迅的職級為準;其他公司的職級尺度不同(如 12、16),開放前需再確認。
 */
export interface JobTier {
  code: string;
  name: string;
  /** 職級上限(含);null = 不限 */
  maxLevel: number | null;
}

export const JOB_TIERS: readonly JobTier[] = [
  { code: 'all', name: '全員', maxLevel: null },
  { code: 'section', name: '課級以上', maxLevel: 7 },
  { code: 'manager', name: '理級以上', maxLevel: 6 },
  { code: 'division', name: '處級以上', maxLevel: 4 },
];

const byCode = new Map(JOB_TIERS.map((t) => [t.code, t]));

export const isJobTier = (code: string) => byCode.has(code);

/** 使用者職級是否符合門檻;未知的門檻代碼一律不符合 */
export function tierMatches(tierCode: string, jobLevel: string | null): boolean {
  const tier = byCode.get(tierCode);
  if (!tier) return false;
  if (tier.maxLevel === null) return true;
  const v = jobLevel?.trim() ?? '';
  if (!/^\d+$/.test(v)) return false;
  return Number(v) <= tier.maxLevel;
}
