# language: zh-TW
@mvp @W3-5.8b
功能: 忘記密碼、IT 重設與變更密碼(本機帳號)
  為了讓本機帳號使用者忘記密碼時能安全重設
  身為本機帳號使用者
  我要透過 Email 連結或 IT 協助重設密碼

  # 畫面與細節於入口網(W5)開發時確定(PRD Q23);以下為 API 行為

  背景:
    假如 "V112001" 有狀態為 "active" 的本機帳號

  場景: 有 Email 時寄送重設連結
    假如 LOS 記錄 "V112001" 的 Email 為 "wang@example.com"
    當 使用者以工號 "V112001" 申請忘記密碼
    那麼 系統寄送 30 分鐘有效的重設連結到 "wang@example.com"
    當 使用者開啟連結並設定新密碼 "newpass99"
    那麼 密碼更新成功
    而且 "V112001" 所有 Refresh Token 家族皆失效
    而且 該連結再次使用時回應 code 為 "TOKEN_USED"

  場景: 重設連結過期
    假如 重設連結已產生超過 30 分鐘
    當 使用者開啟連結
    那麼 回應 code 為 "TOKEN_EXPIRED"

  @security
  場景: 查無帳號時回應與成功時相同
    當 使用者以不存在的工號 "V999999" 申請忘記密碼
    那麼 回應狀態為 200
    而且 回應訊息與有帳號時相同
    而且 不寄送任何 Email

  場景: AD 帳號不走本機忘記密碼
    假如 "S112009" 使用 AD 登入
    當 使用者以工號 "S112009" 申請忘記密碼
    那麼 不寄送重設連結
    而且 回應提示依公司 AD 流程處理

  場景: 沒有 Email 由 IT 重設並強制首次登入改密碼
    假如 LOS 與 BPM 都沒有 "V112001" 的 Email
    當 IT 為 "V112001" 重設密碼
    那麼 "must_change_password" 為 1
    當 使用者以 IT 提供的密碼登入
    那麼 回應 code 為 "PASSWORD_CHANGE_REQUIRED"
    而且 只取得 10 分鐘有效、只能變更密碼的限定憑證

  場景: IT 解鎖被鎖定的帳號
    假如 "V112001" 的本機帳號狀態為 "locked"
    當 IT 解鎖 "V112001"
    那麼 本機帳號狀態變為 "active"
    而且 failed_count 為 0
    而且 "gw.audit_log" 記錄此操作

  場景: 已登入者變更密碼
    假如 "V112001" 已登入
    當 使用者呼叫 "POST /api/auth/password/change" 提供正確舊密碼與新密碼 "newpass99"
    那麼 密碼更新成功
    而且 其他裝置的登入被撤銷
