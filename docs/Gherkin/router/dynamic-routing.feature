# language: zh-TW
@mvp @W3-5.1 @W3-5.2 @W3-5.3 @W3-5.4 @W3-5.5
功能: 動態路由與 API 聚合
  為了讓 API 由路由表決定轉發目標,不需改程式或 Nginx 設定
  身為前端開發者
  我只要呼叫 "/api/{system}/..." 即可取得上游資料

  背景:
    假如 上游 "go-mes" 的位址為 "http://mes-host:51210",預設逾時 10 秒
    而且 已發佈路由 "mes.workorder.get":"GET /api/mes/work-orders/:id" → "go-mes" "GET /v1/work-orders/:id"
    而且 使用者 "S112009" 已登入並具備所需權限

  場景: 依路由表轉發並改寫路徑
    當 使用者呼叫 "GET /api/mes/work-orders/123"
    那麼 上游 "go-mes" 收到 "GET /v1/work-orders/123"
    而且 上游收到的請求帶有 "X-Request-Id" 與 "X-Internal-Token"

  場景: 沒有對應路由時回 404
    當 使用者呼叫 "GET /api/mes/unknown"
    那麼 回應狀態為 404
    而且 回應 code 為 "ROUTE_NOT_FOUND"

  場景: 明確路徑優先於萬用字元
    假如 另有已發佈路由 "GET /api/mes/*" → "go-mes"
    當 使用者呼叫 "GET /api/mes/work-orders/123"
    那麼 使用路由 "mes.workorder.get"

  場景: 清理上游回應標頭
    假如 上游回應帶有 "Set-Cookie" 與 "X-Powered-By"
    當 使用者呼叫 "GET /api/mes/work-orders/123"
    那麼 回應不包含 "Set-Cookie" 與 "X-Powered-By"

  場景: 路由層限流
    假如 路由 "mes.workorder.get" 套用限流政策 "每位使用者每 60 秒 100 次"
    而且 使用者在 60 秒內已呼叫 100 次
    當 使用者再呼叫 "GET /api/mes/work-orders/123"
    那麼 回應狀態為 429
    而且 回應 code 為 "RATE_LIMITED"

  場景: GET 回應快取
    假如 路由 "mes.workorder.get" 設定 cache_ttl_sec 為 30、cache_scope 為 "shared"
    當 兩位使用者在 30 秒內呼叫 "GET /api/mes/work-orders/123"
    那麼 上游只收到 1 次請求

  場景: 上游逾時回 504
    假如 上游 "go-mes" 超過 10 秒未回應
    當 使用者呼叫 "GET /api/mes/work-orders/123"
    那麼 回應狀態為 504
    而且 回應 code 為 "UPSTREAM_TIMEOUT"

  場景: 冪等方法失敗時重試,非冪等方法不重試
    假如 上游 "go-mes" 第一次回應連線錯誤
    當 使用者呼叫 "GET /api/mes/work-orders/123"
    那麼 BFF 重試 1 次
    但是 使用者呼叫 "POST /api/mes/work-orders/123/reports" 時 BFF 不重試

  場景: 斷路器
    假如 上游 "go-mes" 連續失敗達 10 次
    當 使用者呼叫 "GET /api/mes/work-orders/123"
    那麼 回應狀態為 503
    而且 回應 code 為 "UPSTREAM_UNAVAILABLE"
    而且 30 秒內 BFF 不再轉發到 "go-mes"
    而且 30 秒後以試探請求恢復

  場景: 上游回 401 視為設定錯誤
    假如 上游 "go-mes" 因 aud 不符回應 401
    當 使用者呼叫 "GET /api/mes/work-orders/123"
    那麼 回應狀態為 502
    而且 回應 code 為 "UPSTREAM_ERROR"
    而且 系統發出上游設定錯誤告警

  Rule: 聚合路由

    背景:
      假如 已發佈聚合路由 "GET /api/portal/dashboard",步驟如下:
        | step_key | 上游       | 必要 | 權限代碼           | 順序 |
        | todos    | core-hrm   | 是   |                    | 1    |
        | approvals| bpm-adapter| 否   |                    | 1    |
        | mesRate  | go-mes     | 否   | mes.dashboard.read | 1    |

    場景: 相同順序的步驟並行執行並合併
      當 使用者呼叫 "GET /api/portal/dashboard"
      那麼 回應包含 "todos"、"approvals"、"mesRate"

    場景: 非必要步驟失敗時回傳部分結果
      假如 上游 "bpm-adapter" 逾時
      當 使用者呼叫 "GET /api/portal/dashboard"
      那麼 回應狀態為 200
      而且 回應的 "_meta.errors" 包含 "approvals"

    場景: 必要步驟失敗時整體失敗
      假如 上游 "core-hrm" 回應 500
      當 使用者呼叫 "GET /api/portal/dashboard"
      那麼 回應狀態為 502

    場景: 沒有權限的步驟略過
      假如 使用者沒有權限 "mes.dashboard.read"
      當 使用者呼叫 "GET /api/portal/dashboard"
      那麼 回應不包含 "mesRate"
      而且 上游 "go-mes" 沒有收到請求
