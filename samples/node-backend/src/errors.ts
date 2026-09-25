/** 錯誤(BACKEND-GUIDE.md §5.3):自訂代碼以系統代碼開頭,例 SAMPLE_ITEM_NOT_FOUND;不可使用 Gateway 專用代碼 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
