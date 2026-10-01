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

/** Gateway 提供給其他系統呼叫的 API 權限(PRD §8.5);授予 API Key(`client:create --perm`)或角色,不屬於管理權限 */
export const SERVICE_PERMISSIONS = [{ code: 'notify.message.send', name: '通知:發送', systemCode: 'notify', resource: 'message', action: 'send' }] as const;

/**
 * 角色 → 權限。
 * gw-it-admin 的範圍(IT 主管已確認,2026-09-29):不含權限 / 角色、公司網域、API Key 的編輯。
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

/**
 * 公司與 AD 網域對應(PRD Q11、Q13)。無網域公司(如禾迅)由人員同步自動建立,不在此設定。
 * compName 必須與 LOS `CompName`(無 LOS 資料時為 BPM `Organization`)完全一致,否則登入時另建一家無網域的公司,該員工下次登入回 ACCOUNT_NOT_REGISTERED;公司實際值待 DBA 確認。
 * 2026-09-30 需求方決定:只使用 gsmc(碩禾_新);gsc(舊網域)與 ygdmc(鹽城碩禾)不再使用,鹽城碩禾改為無網域(本機帳號)。
 */
export const COMPANIES = [{ compName: '碩禾', empPrefix: 'S', domains: ['gsmc'] }] as const;

/**
 * 系統通知範本(PRD §8.5、§8.2.5):BFF 內建流程使用,只新增不覆寫(IT 可於管理介面調整文字)。
 * 變數 {{name}};emailBody 為 HTML,變數值自動跳脫。
 */
export const NOTIFY_TEMPLATES = [
  {
    code: 'AUTH_REGISTER_VERIFY',
    name: '本機帳號註冊驗證',
    channels: ['email'],
    emailSubject: 'GigaNexus 帳號註冊驗證',
    emailBody:
      '<p>{{name}} 您好:</p><p>您以工號 {{employeeNo}} 申請註冊 GigaNexus 員工入口網帳號。請於 {{expiresMinutes}} 分鐘內開啟下列連結設定密碼:</p><p><a href="{{link}}">{{link}}</a></p><p>若非本人申請,請忽略本信並通知 IT。</p>',
  },
  {
    code: 'AUTH_REGISTER_MANAGER_NOTICE',
    name: '部屬註冊本機帳號通知',
    channels: ['email'],
    emailSubject: 'GigaNexus 新註冊通知:{{name}}({{employeeNo}})',
    emailBody: '<p>您好:</p><p>{{name}}(工號 {{employeeNo}})已以到職日驗證,註冊 GigaNexus 員工入口網本機帳號。</p><p>若非本人申請,請立即通知 IT 停用此帳號。</p>',
  },
  {
    code: 'AUTH_PASSWORD_RESET',
    name: '本機帳號重設密碼',
    channels: ['email'],
    emailSubject: 'GigaNexus 重設密碼',
    emailBody:
      '<p>{{name}} 您好:</p><p>我們收到工號 {{employeeNo}} 的重設密碼申請。請於 {{expiresMinutes}} 分鐘內開啟下列連結設定新密碼(連結只能使用一次):</p><p><a href="{{link}}">{{link}}</a></p><p>若非本人申請,請忽略本信,您的密碼不會變更。</p>',
  },
] as const;
