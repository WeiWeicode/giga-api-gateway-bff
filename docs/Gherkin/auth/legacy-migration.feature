# language: zh-TW
@mvp @W3-4.16 @security @wip
功能: 舊單一入口帳號首次登入自動遷移
  為了讓習慣舊單一入口密碼的員工不用重新註冊
  身為沒有 AD 帳號的員工
  我在新入口網輸入舊密碼即可自動建立帳號,但必須立即設定新密碼

  # 2026-10-02 實作,預設關閉(LEGACY_MIGRATION_ENABLED=false):待 P-15(現行系統測試帳號、LoginData 唯讀 view、演算法常數)驗證密文一致後開啟

  背景:
    假如 公司 "禾迅" 沒有設定任何網域
    而且 "V112001" 沒有本機帳號
    而且 LOS 有 "V112001" 在職資料
    而且 舊單一入口 LoginData 有 "V112001",PNum 為舊密碼 "old1234" 以舊演算法加密的結果

  場景: 舊密碼正確時自動建立本機帳號並要求設定新密碼
    當 使用者以帳號 "V112001" 與密碼 "old1234" 登入
    那麼 回應 code 為 "PASSWORD_CHANGE_REQUIRED"
    而且 回應只設定 10 分鐘有效、只能變更密碼的限定憑證
    而且 回應不設定 "gn_at" 與 "gn_rt"
    而且 "gw.local_credential" 新增 "V112001",registered_via 為 "legacy_portal"、must_change_password 為 1
    而且 "gw.auth_log" 新增 event 為 "legacy_migrated" 的紀錄

  場景: 設定新密碼後完成登入
    假如 使用者已以舊密碼通過驗證並取得限定憑證
    當 使用者設定新密碼 "newpass99"
    那麼 回應設定 "gn_at" 與 "gn_rt"
    而且 must_change_password 為 0

  場景: 新密碼不可與舊密碼相同
    假如 使用者已以舊密碼通過驗證並取得限定憑證
    當 使用者設定新密碼 "old1234"
    那麼 回應 code 為 "PASSWORD_REUSED"

  場景: 限定憑證只能變更密碼
    假如 使用者已以舊密碼通過驗證並取得限定憑證
    當 使用者以限定憑證呼叫 "GET /api/mes/work-orders"
    那麼 回應狀態為 401
    而且 回應 code 為 "UNAUTHENTICATED"

  場景: 中途離開後再次登入仍須設定新密碼
    假如 使用者已以舊密碼通過驗證,但未設定新密碼
    當 使用者再以帳號 "V112001" 與密碼 "old1234" 登入
    那麼 以本機帳號驗證成功
    而且 回應 code 為 "PASSWORD_CHANGE_REQUIRED"
    而且 BFF 不再讀取 LoginData

  場景: 舊密碼錯誤時與一般登入失敗相同
    當 使用者以帳號 "V112001" 與密碼 "wrong" 登入
    那麼 回應狀態為 401
    而且 回應 code 為 "INVALID_CREDENTIALS"
    而且 不建立本機帳號

  場景: 已離職者不遷移
    假如 LOS 記錄 "V112001" 已離職
    當 使用者以帳號 "V112001" 與密碼 "old1234" 登入
    那麼 回應狀態為 401
    而且 不建立本機帳號

  場景: AD 找得到帳號時不改試舊入口
    假如 "S112009" 在網域 "gsc" 中存在
    而且 舊單一入口 LoginData 也有 "S112009"
    當 使用者以帳號 "S112009" 與舊入口密碼登入,但 AD 密碼驗證失敗
    那麼 回應狀態為 401
    而且 BFF 不讀取 LoginData

  場景: 舊密文與 EName 不寫入新資料庫
    當 "V112001" 完成遷移
    那麼 "giganexus_gw" 中沒有任何欄位含有 LoginData 的 PNum 或 EName 內容

  場景: 新舊系統密碼各自獨立
    假如 "V112001" 已完成遷移並設定新密碼
    當 使用者在新入口網變更密碼
    那麼 舊單一入口 LoginData 的資料不變
