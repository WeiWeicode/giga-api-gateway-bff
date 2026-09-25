# language: zh-TW
@W3-5.7 @P2-4
功能: 由 OpenAPI 匯入 API 路由
  為了讓後端完成後快速上架 API
  身為 IT 管理者
  我要上傳後端提供的 OpenAPI 規格,預覽差異後匯入為草稿

  # MVP 期間由 Gateway 負責人以 CLI 執行(W3-5.7),第二階段開放管理介面(P2-4);規則相同

  背景:
    假如 上游 "go-mes" 已登記,位址 port 為 51210
    而且 OpenAPI 根層 "x-gateway" 為 upstream "go-mes"、system "mes"

  場景: 每個 operation 轉成一條路由
    假如 OpenAPI 含 operation:
      | method | path                 | operationId        | summary  | x-permission       |
      | GET    | /v1/work-orders/{id} | mes.workorder.get  | 查詢工單 | mes.workorder.read |
    當 IT 匯入此規格
    那麼 預覽結果為 "新增 1 筆"
    而且 路由的對外路徑為 "GET /api/mes/work-orders/:id"
    而且 上游路徑為 "/v1/work-orders/:id"
    而且 route_code 為 "mes.workorder.get"
    而且 路由狀態為 "draft"

  @W3-5.7a
  場景: 匯入 API 用途說明與行為規格
    假如 operation "mes.workorder.get" 的 "description" 為 "依工單號查詢工單內容與狀態"
    而且 其 "x-gherkin" 為一段以 "場景:" 開頭的 Gherkin 文字
    當 IT 匯入此規格
    那麼 路由的 description 為 "依工單號查詢工單內容與狀態"
    而且 路由的 gherkin 為該段 Gherkin 文字
    而且 發佈後的路由快照不含 description 與 gherkin

  @W3-5.7a
  場景: 說明超過 1000 字時列為錯誤
    假如 operation "mes.workorder.get" 的 "description" 超過 1000 字
    當 IT 匯入此規格
    那麼 預覽中 "mes.workorder.get" 為錯誤 "description 需為 1000 字以內的文字"

  場景: 以 x-gateway-path 指定對外路徑
    假如 operation "mes.workorder.getV2" 的 path 為 "/v2/work-orders/{id}"
    而且 其 "x-gateway-path" 為 "/api/mes/v2/work-orders/{id}"
    當 IT 匯入此規格
    那麼 路由的對外路徑為 "GET /api/mes/v2/work-orders/:id"

  場景: 缺少 x-permission 的 operation 列為錯誤
    假如 operation "mes.workorder.list" 沒有 "x-permission"
    當 IT 匯入此規格
    那麼 預覽中 "mes.workorder.list" 為錯誤
    而且 該 operation 不會被寫入草稿
    而且 提交此批次時回應 code 為 "IMPORT_HAS_ERRORS"

  場景大綱: x-permission 對應 auth_mode
    假如 operation 的 "x-permission" 為 "<值>"
    當 IT 匯入此規格
    那麼 路由的 auth_mode 為 "<auth_mode>"

    例子:
      | 值                 | auth_mode     |
      | mes.workorder.read | permission    |
      | authenticated      | authenticated |
      | public             | public        |

  場景: 權限代碼不存在時可一併建立
    假如 "x-permissions" 列出 "mes.workorder.report"(報工)
    而且 "gw.permission" 沒有 "mes.workorder.report"
    當 IT 匯入並選擇「一併建立權限」
    那麼 "gw.permission" 新增 "mes.workorder.report",名稱為 "報工"

  場景: 重新匯入時標示修改與不變
    假如 路由 "mes.workorder.get" 已發佈
    當 IT 匯入逾時設定改為 20000 毫秒的新版規格
    那麼 預覽中 "mes.workorder.get" 為 "更新"
    而且 其他未變動的 operation 為 "不變"

  場景: 路徑衝突時列為錯誤
    假如 已有其他路由使用 "GET /api/mes/work-orders/:id"
    當 IT 匯入另一個上游對應到相同對外路徑的 operation
    那麼 預覽中該 operation 為錯誤 "ROUTE_PATH_CONFLICT"

  場景: 上游 port 不在規定區間時拒絕
    當 IT 登記上游 "legacy-notes" 位址為 "http://notes-host:5121"
    那麼 回應 code 為 "UPSTREAM_PORT_OUT_OF_RANGE"

  場景: 匯入批次留存紀錄
    當 IT 匯入規格檔 "mes-openapi.yaml"
    那麼 "gw.api_import_batch" 記錄檔名、檔案雜湊與新增 / 更新 / 不變 / 錯誤筆數
    而且 "gw.api_import_item" 記錄每個 operation 的處理結果
