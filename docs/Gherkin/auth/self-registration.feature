# language: zh-TW
@mvp @W3-5.8a
功能: 本機帳號自行註冊
  為了讓無網域子公司的員工不用等 IT 就能開通帳號
  身為禾迅員工
  我要以工號與姓名申請註冊;LOS / BPM 找得到我就通過,找不到才由管理員審核

  # API:POST /api/auth/register { employeeNo, name, hireDate?, password? }(PRD §8.2.4);
  # 待審核由 IT 以管理 API POST /api/admin/local-accounts/:id/approve(P2-3)或 CLI local:approve 核准

  背景:
    假如 公司 "禾迅" 沒有設定任何網域
    而且 所有 AD 網域都查無 "V112001"
    而且 "V112001" 尚未註冊本機帳號

  場景: LOS / BPM 有 Email 時寄驗證連結
    假如 LOS 有 "V112001" 在職資料,姓名 "王小明",Email "wang@example.com"
    當 使用者以工號 "V112001"、姓名 "王小明" 申請註冊
    那麼 回應 code 為 "VERIFICATION_SENT"
    而且 系統寄送 30 分鐘有效的驗證連結到 "wang@example.com"
    而且 本機帳號狀態為 "pending_verify"
    當 使用者在 30 分鐘內開啟連結並設定密碼 "abc12345"
    那麼 本機帳號狀態變為 "active"
    而且 registered_via 為 "self_email"

  場景: 驗證只寄到 LOS / BPM 登記的 Email
    假如 LOS 有 "V112001" 在職資料,Email "wang@example.com"
    當 使用者申請註冊時另外填寫 Email "attacker@example.com"
    那麼 驗證連結只寄到 "wang@example.com"

  場景: 沒有 Email 時比對到職日後直接啟用並通知主管
    假如 LOS 有 "V112001" 在職資料,姓名 "王小明",沒有 Email,到職日 "2023-03-22"
    而且 LOS 記錄其主管 Email 為 "boss@example.com"
    當 使用者以工號 "V112001"、姓名 "王小明"、到職日 "2023-03-22" 申請註冊並設定密碼 "abc12345"
    那麼 本機帳號狀態變為 "active"
    而且 registered_via 為 "self_jobdate"
    而且 系統寄送新註冊通知到 "boss@example.com"
    而且 到職日不會寫入 "gw.user"

  場景: LOS / BPM 都找不到時轉管理員審核
    假如 LOS 與 BPM 都沒有 "V112099"
    而且 所有 AD 網域都查無 "V112099"
    當 使用者以工號 "V112099"、姓名 "陳新人" 申請註冊
    那麼 回應 code 為 "REGISTRATION_PENDING_APPROVAL"
    而且 本機帳號狀態為 "pending_approval"
    當 管理員核准此申請
    那麼 系統產生一次性啟用連結
    而且 registered_via 為 "self_approved"

  @security
  場景大綱: 不符資格時一律回覆相同訊息
    假如 <情況>
    當 使用者以工號 "V112001"、姓名 "王小明" 申請註冊
    那麼 回應 code 為 "REGISTRATION_NOT_ALLOWED"
    而且 回應訊息不說明具體原因

    例子:
      | 情況                                   |
      | LOS 記錄的姓名為 "王大明"              |
      | LOS 記錄 "V112001" 已離職              |
      | "V112001" 已有本機帳號                 |
      | 網域 "gsmc" 中存在帳號 "V112001"       |
      | LOS 無 Email 且輸入的到職日不符        |

  @security
  場景: 註冊請求限流
    假如 同一來源 IP 在 1 小時內已送出 10 次註冊請求
    當 該 IP 再送出註冊請求
    那麼 回應狀態為 429
    而且 回應 code 為 "RATE_LIMITED"

  場景: 在舊入口註冊過的員工也可以直接到新入口網註冊
    假如 舊單一入口 LoginData 有 "V112001"
    而且 LOS 有 "V112001" 在職資料與 Email
    當 使用者在新入口網以工號 "V112001" 申請註冊
    那麼 系統寄送驗證連結
    而且 建立本機帳號後不再讀取 LoginData
