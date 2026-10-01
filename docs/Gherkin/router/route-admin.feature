# language: zh-TW
@phase2 @P2-1
功能: 路由設定管理 API
  為了讓 IT 在管理介面自助維護上游、API 路由、聚合步驟與限流政策
  身為 IT 管理者
  我需要可查詢、新增、修改、停用的管理 API,且同時編輯時不互相覆蓋

  # 實作:bff/src/modules/admin/routing.ts;E2E bff/test/e2e/07-routing-admin.test.ts(對測試區)

  背景:
    假如 IT 以具備 "gw.admin.upstream.*"、"gw.admin.route.*" 的登入或 API Key 呼叫

  場景: 修改只寫資料庫,下次發佈才生效
    假如 路由 "mes.workorder.get" 已發佈
    當 IT 以 PATCH 修改其逾時設定
    那麼 該路由狀態改為 "draft"
    而且 線上仍使用目前發佈版本的設定
    而且 "gw.audit_log" 記錄 action "route.update",操作人為實際呼叫者

  場景: 樂觀鎖防止覆蓋他人的修改
    假如 A 與 B 讀到同一筆上游,rowVer 相同
    而且 A 已儲存修改
    當 B 以舊的 rowVer 儲存
    那麼 回應 409 "VERSION_CONFLICT"
    而且 資料維持 A 的修改

  場景大綱: 新增路由的檢查
    當 IT 新增路由 <內容>
    那麼 回應 <狀態> "<code>"

    例子:
      | 內容                                  | 狀態 | code                 |
      | 系統代碼為 admin 或 auth              | 400  | VALIDATION_FAILED    |
      | 對外路徑不是 /api/{系統代碼} 開頭     | 400  | VALIDATION_FAILED    |
      | proxy 未指定上游                      | 400  | VALIDATION_FAILED    |
      | auth_mode=permission 未指定權限代碼   | 400  | VALIDATION_FAILED    |
      | 正式區新增 mock 路由                  | 400  | VALIDATION_FAILED    |
      | 同方法同路徑已有未停用的路由          | 409  | ROUTE_PATH_CONFLICT  |

  場景: 上游位址的 port 限制
    當 IT 新增上游,位址為 "http://mes-host:8080"
    那麼 回應 400 "UPSTREAM_PORT_OUT_OF_RANGE"

  場景: 仍被使用的上游不可停用
    假如 上游 "go-mes" 仍有未停用的路由或聚合步驟
    當 IT 停用 "go-mes"
    那麼 回應 400 "VALIDATION_FAILED",details 列出使用中的路由

  場景: 仍被路由參照的限流政策不可刪除
    假如 限流政策 "report-heavy" 被路由使用
    當 IT 刪除 "report-heavy"
    那麼 回應 400 "VALIDATION_FAILED"

  場景: 聚合步驟整組取代
    假如 路由 "portal.dashboard.get" 為 aggregate
    當 IT 以 PUT 送出新的步驟清單
    那麼 舊步驟全部移除、改為新清單
    而且 步驟代碼重複、上游不存在或已停用、權限代碼不存在時回應 400

  場景: 健康檢查
    當 IT 對上游執行健康檢查
    那麼 回應本區每個位址的結果(ok、HTTP 狀態、耗時;連不到時 ok=false)
