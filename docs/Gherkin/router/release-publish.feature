# language: zh-TW
@W3-5.6 @W3-5.7
功能: 路由設定發佈、回滾與 Redis 同步
  為了讓 IT 修改 API 設定後不需重新部署即可生效,並能安全回滾
  身為 IT 管理者
  我需要草稿 / 發佈兩段式流程,且發佈後 5 秒內所有 BFF 實例生效

  背景:
    假如 有 2 個 BFF 實例正在運作
    而且 目前發佈版本為 N

  @mvp
  場景: 編輯草稿不影響線上
    當 IT 修改路由 "mes.workorder.get" 的逾時設定並存為草稿
    那麼 線上仍使用版本 N 的設定

  @mvp
  場景: 發佈後 5 秒內所有實例生效
    假如 有待發佈的草稿
    當 IT 發佈草稿
    那麼 "gw.config_release" 新增版本 N+1,含完整快照與差異摘要
    而且 Redis "gw:routes:version" 為 N+1
    而且 5 秒內 2 個 BFF 實例皆使用版本 N+1
    而且 "gw.audit_log" 記錄 action "release.publish"

  @mvp
  場景: 先提交資料庫,再更新 Redis
    假如 發佈時資料庫交易失敗
    當 IT 發佈草稿
    那麼 Redis 的版本仍為 N

  @mvp
  場景: Redis 更新失敗時由補償機制修正
    假如 資料庫已提交版本 N+1
    但是 寫入 Redis 失敗
    當 經過 60 秒
    那麼 其中一個 BFF 實例取得 "gw:lock:sync" 並重推快照
    而且 所有 BFF 實例改用版本 N+1

  @mvp
  場景: Redis 不可用時既有路由仍可服務
    假如 Redis 停止運作
    當 使用者呼叫已發佈的路由
    那麼 BFF 以記憶體中的路由樹正常轉發

  @mvp
  場景: BFF 重啟時 Redis 與資料庫皆不可用
    假如 Redis 與 SQL Server 皆無法連線
    當 BFF 實例重新啟動
    那麼 BFF 以本地最後快照檔建立路由樹

  @mvp
  場景: 亂序或重複的版本通知不會造成回退
    假如 BFF 實例目前使用版本 N+1
    當 該實例收到版本 N 的變更通知
    那麼 該實例仍使用版本 N+1

  @phase2 @P2-2
  場景: 回滾到歷史版本
    假如 版本 N+1 發佈後發現問題
    當 IT 選擇回滾到版本 N
    那麼 產生新版本 N+2,內容等同版本 N,rolled_back_from 為 N
    而且 5 秒內所有 BFF 實例使用版本 N+2

  @mvp
  場景: 認證與管理 API 不受路由表影響
    假如 IT 誤發佈了錯誤的路由設定
    當 使用者呼叫 "/api/auth/login" 或 "/api/admin/releases"
    那麼 這些 API 仍正常運作

  @mvp
  場景: 測試區驗證過的版本推送到正式區
    假如 測試區版本 N+1 已驗證通過
    當 IT 從測試區匯出版本 N+1 並匯入正式區
    那麼 正式區產生草稿
    而且 正式區發佈需要手動核可
