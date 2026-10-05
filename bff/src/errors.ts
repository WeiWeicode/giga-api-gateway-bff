/**
 * 統一錯誤格式 { code, message, requestId, details? }(PRD §8.1.1)。
 * code 對外固定不變;新增代碼需先更新 PRD 錯誤代碼總表。
 */
export const ERROR_MESSAGES = {
  VALIDATION_FAILED: '參數驗證失敗',
  UNAUTHENTICATED: '請先登入',
  PERMISSION_DENIED: '您沒有此功能的權限',
  CSRF_INVALID: 'CSRF 驗證失敗,請重新載入頁面',
  ROUTE_NOT_FOUND: '找不到此 API',
  PAYLOAD_TOO_LARGE: '請求內容過大',
  RATE_LIMITED: '請求過於頻繁,請稍後再試',
  INTERNAL_ERROR: '系統發生錯誤',
  UPSTREAM_ERROR: '系統暫時無法使用',
  UPSTREAM_UNAVAILABLE: '系統暫時無法使用',
  UPSTREAM_TIMEOUT: '系統回應逾時',
  INVALID_CREDENTIALS: '帳號或密碼錯誤',
  ACCOUNT_NOT_REGISTERED: '此工號尚未註冊,請先註冊帳號',
  ACCOUNT_LOCKED: '帳號已鎖定,請使用忘記密碼或聯絡 IT',
  ACCOUNT_DISABLED: '帳號已停用,請聯絡 IT',
  COMPANY_NOT_OPEN: '您所屬的公司尚未開放使用,請聯絡 IT',
  AD_PASSWORD_EXPIRED: 'AD 密碼已過期,請先於 Windows 變更密碼',
  LOGIN_THROTTLED: '登入失敗次數過多,請 15 分鐘後再試',
  PASSWORD_CHANGE_REQUIRED: '請先設定新密碼',
  REFRESH_TOKEN_INVALID: '登入已失效,請重新登入',
  PASSWORD_POLICY_VIOLATION: '新密碼不符合密碼政策',
  PASSWORD_REUSED: '新密碼不可與前 3 次相同',
  REGISTRATION_NOT_ALLOWED: '無法註冊,請聯絡 IT',
  TOKEN_INVALID: '連結無效',
  TOKEN_EXPIRED: '連結已過期,請重新申請',
  TOKEN_USED: '連結已使用過,請重新申請',
  VERSION_CONFLICT: '資料已被他人修改,請重新載入',
  ROUTE_PATH_CONFLICT: '對外路徑與既有路由衝突',
  UPSTREAM_PORT_OUT_OF_RANGE: '上游位址的 port 不在 51200–51300',
  IMPORT_HAS_ERRORS: '匯入批次含錯誤項目,未寫入任何路由',
  CHANNEL_NOT_SUPPORTED: '不支援的通知通道',
  WEBHOOK_SOURCE_NOT_FOUND: '沒有此來源的 Webhook 設定',
  WEBHOOK_SIGNATURE_INVALID: 'Webhook 簽章驗證失敗',
  WEBHOOK_TIMESTAMP_INVALID: 'Webhook 時間戳超出允許範圍',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  CSRF_INVALID: 403,
  ROUTE_NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502,
  UPSTREAM_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_NOT_REGISTERED: 401,
  ACCOUNT_LOCKED: 401,
  ACCOUNT_DISABLED: 403,
  COMPANY_NOT_OPEN: 403,
  AD_PASSWORD_EXPIRED: 401,
  LOGIN_THROTTLED: 429,
  PASSWORD_CHANGE_REQUIRED: 403,
  REFRESH_TOKEN_INVALID: 401,
  PASSWORD_POLICY_VIOLATION: 400,
  PASSWORD_REUSED: 400,
  REGISTRATION_NOT_ALLOWED: 403,
  TOKEN_INVALID: 400,
  TOKEN_EXPIRED: 400,
  TOKEN_USED: 400,
  VERSION_CONFLICT: 409,
  ROUTE_PATH_CONFLICT: 409,
  UPSTREAM_PORT_OUT_OF_RANGE: 400,
  IMPORT_HAS_ERRORS: 400,
  CHANNEL_NOT_SUPPORTED: 400,
  WEBHOOK_SOURCE_NOT_FOUND: 404,
  WEBHOOK_SIGNATURE_INVALID: 401,
  WEBHOOK_TIMESTAMP_INVALID: 401,
};

export class GwError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: unknown,
    status?: number,
  ) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'GwError';
    this.status = status ?? ERROR_STATUS[code];
  }
}

export function errorBody(code: string, message: string, requestId: string, details?: unknown) {
  return details === undefined ? { code, message, requestId } : { code, message, requestId, details };
}
