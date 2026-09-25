/**
 * 種子資料(IMPL-PLAN W3-1.5、PRD §8.3、§8.7)。
 * 只新增不存在的項目(以 code 判斷),不覆寫 IT 已在管理介面調整過的內容。
 */

export const SEED_ACTOR = 'system:seed';

export const ROLES = [
  { code: 'gw-super-admin', name: 'Gateway 超級管理員', description: '僅限 IT 主管群組', isSystem: true },
  { code: 'gw-it-admin', name: 'Gateway IT 管理員', description: 'IT 管理介面日常維護', isSystem: true },
  { code: 'employee', name: '員工', description: '所有登入者預設角色', isSystem: true },
] as const;

type AdminPermission = { code: `gw.admin.${string}`; name: string };

/** PRD §8.7 管理 API 權限;`.*` 展開為 read / write。 */
export const ADMIN_PERMISSIONS: readonly AdminPermission[] = [
  { code: 'gw.admin.upstream.read', name: '上游服務:檢視' },
  { code: 'gw.admin.upstream.write', name: '上游服務:編輯' },
  { code: 'gw.admin.route.read', name: 'API 路由:檢視' },
  { code: 'gw.admin.route.write', name: 'API 路由、聚合步驟、限流政策:編輯' },
  { code: 'gw.admin.route.import', name: 'API 匯入' },
  { code: 'gw.admin.route.register', name: 'API 自動註冊(後端服務 API Key 專用)' },
  { code: 'gw.admin.release', name: '發佈 / 回滾' },
  { code: 'gw.admin.rbac.read', name: '權限 / 角色:檢視、反查' },
  { code: 'gw.admin.rbac.write', name: '權限 / 角色:編輯' },
  { code: 'gw.admin.user.read', name: '使用者:檢視' },
  { code: 'gw.admin.user.write', name: '使用者:停用、個別角色、強制登出' },
  { code: 'gw.admin.user.sync', name: '人員同步:紀錄與手動觸發' },
  { code: 'gw.admin.company.read', name: '公司:檢視' },
  { code: 'gw.admin.company.write', name: '公司:網域與預設角色' },
  { code: 'gw.admin.local.read', name: '本機帳號:檢視(含待審核)' },
  { code: 'gw.admin.local.write', name: '本機帳號:代建、審核、重設、解鎖、停用' },
  { code: 'gw.admin.client.read', name: 'API Key:檢視' },
  { code: 'gw.admin.client.write', name: 'API Key:建立、停用' },
  { code: 'gw.admin.notify.read', name: '通知:範本與紀錄檢視' },
  { code: 'gw.admin.notify.write', name: '通知:範本編輯' },
  { code: 'gw.admin.audit.read', name: '稽核紀錄查詢' },
];

/**
 * 角色 → 權限。
 * gw-it-admin 的範圍為暫定:不含權限 / 角色、公司網域、API Key 的編輯,待 IT 主管確認。
 */
export const ROLE_PERMISSIONS: Record<(typeof ROLES)[number]['code'], readonly string[]> = {
  'gw-super-admin': ADMIN_PERMISSIONS.map((p) => p.code),
  'gw-it-admin': ADMIN_PERMISSIONS.map((p) => p.code).filter((c) => !['gw.admin.rbac.write', 'gw.admin.company.write', 'gw.admin.client.write'].includes(c)),
  employee: [],
};

/** 預設限流政策(數值暫定,整合週依 k6 結果調整)。 */
export const RATE_LIMIT_POLICIES = [
  { code: 'default', limitCount: 300, windowSec: 60, keyBy: 'user', burst: null },
  { code: 'report-heavy', limitCount: 30, windowSec: 60, keyBy: 'user', burst: null },
  { code: 'mes-high-freq', limitCount: 1200, windowSec: 60, keyBy: 'user', burst: 200 },
] as const;

/** 公司與 AD 網域對應(PRD Q11、Q13)。無網域公司(如禾迅)由人員同步自動建立,不在此設定。 */
export const COMPANIES = [
  { compName: '碩禾', empPrefix: 'S', domains: ['gsc', 'gsmc'] },
  { compName: '鹽城碩禾', empPrefix: null, domains: ['ygdmc'] },
] as const;
