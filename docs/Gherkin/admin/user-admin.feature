# language: zh-TW
@phase2 @P2-3
功能: 使用者、公司與本機帳號管理 API
  為了讓 IT 在管理介面處理帳號問題、設定公司網域與預設角色
  身為 IT 管理者
  我需要使用者、公司、本機帳號的管理 API,且變更權限後立即生效

  # 實作:bff/src/modules/admin/users.ts、local-account-admin.ts(與 CLI local:* 共用);E2E bff/test/e2e/08-users-admin.test.ts(對測試區)
  # 人員同步紀錄與手動觸發(GET / POST /api/admin/employee-sync/runs)待排程人員同步 Worker(W3-4.6b)後實作

  背景:
    假如 IT 以具備對應權限("gw.admin.user.*"、"gw.admin.company.*"、"gw.admin.local.*")的登入或 API Key 呼叫

  場景: 個別指派角色後已登入者須換發 Token
    假如 使用者 "V112001" 已登入
    當 IT 以 PATCH 指派角色 "hr-viewer"(可設到期時間)
    那麼 "V112001" 的 perm_version 遞增
    而且 "V112001" 下一次請求回應 401,Refresh 後的 Token 帶有 "hr-viewer"
    而且 "gw.audit_log" 記錄 action "user.update"(變更前後的角色)

  場景: 不可授予自己沒有的權限
    假如 IT 管理員沒有 "gw.admin.rbac.write"
    當 IT 指派或移除含有 "gw.admin.rbac.write" 的角色(例如 "gw-super-admin")
    那麼 回應 403 "PERMISSION_DENIED",details 列出缺少的權限

  場景: 停用使用者與強制登出
    當 IT 停用使用者,或對其執行強制登出
    那麼 其所有 Refresh Token 家族被撤銷
    而且 舊 Access Token 下一次請求即失效
    而且 IT 不可停用自己

  場景: 樂觀鎖
    當 IT 以舊的 rowVer 修改使用者或公司
    那麼 回應 409 "VERSION_CONFLICT"

  場景: 公司網域與預設角色
    當 IT 設定公司 "禾迅" 的 AD 網域為 ["gsmc"]
    那麼 該公司員工以工號登入時依序嘗試這些網域;未登記的網域代碼回應 400
    當 IT 設定公司 "禾迅" 的預設角色
    那麼 該公司所有成員(含兼任)的 perm_version 遞增,換發後帶有公司角色

  場景: 本機帳號審核、代建、重設、解鎖、停用
    當 IT 核准待審核的註冊,或代建本機帳號
    那麼 回應 72 小時有效的一次性啟用連結(只顯示這一次)
    當 IT 代建的工號在任一 AD 網域有帳號、LOS / BPM 查無、已離職或為兼任帳號
    那麼 回應 400,訊息說明原因
    當 IT 重設本機帳號密碼
    那麼 回應臨時密碼(只顯示這一次),本人首次登入回應 "PASSWORD_CHANGE_REQUIRED"
    當 IT 解除鎖定
    那麼 帳號恢復 active、失敗次數歸零
    當 IT 停用本機帳號
    那麼 該帳號無法登入、所有登入被撤銷、未使用的啟用 / 重設連結作廢
