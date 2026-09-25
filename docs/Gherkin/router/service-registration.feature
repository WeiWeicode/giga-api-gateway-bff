# language: zh-TW
@W3-5.7a
功能: 後端自動註冊與既有路由查詢
  為了讓後端部署後 API 自動進入上架流程,並避免重複開發相同功能的 API
  身為 下游後端服務
  我要在測試區與正式區啟動時,以 API Key 把自己的 OpenAPI 註冊為 Gateway 草稿,並能查詢既有路由

  # BACKEND-GUIDE.md §7.5、PRD §8.4.4、§8.7。測試區與正式區設定不互通(PRD Q3),各區各自註冊。

  背景:
    假如 Gateway 負責人已為服務 "node-sample" 建立 API Key,權限為 "gw.admin.route.register"、"gw.admin.route.read"
    而且 服務的 OpenAPI 根層 "x-gateway" 為 upstream "node-sample"、system "sample"

  場景大綱: 依部署區決定是否自動註冊
    假如 服務以 GW_ENV "<部署區>" 啟動
    那麼 自動註冊 "<結果>"

    例子:
      | 部署區 | 結果                         |
      | dev    | 不執行                       |
      | test   | 寫入測試區 Gateway 的草稿    |
      | prod   | 寫入正式區 Gateway 的草稿    |

  場景: 註冊只寫入草稿,不影響線上
    當 服務以 API Key 呼叫 POST /api/admin/registrations,送出含 2 個 operation 的 OpenAPI
    那麼 回應 200,新增 2 筆、pendingPublish 為 true
    而且 兩條路由狀態為 "draft",並含 description 與 gherkin
    而且 經 Gateway 呼叫這些路徑回應 code 為 "ROUTE_NOT_FOUND"
    而且 稽核紀錄新增一筆 "route.register",actor 為 "client:node-sample"

  場景: 重複註冊不產生變更
    假如 服務已註冊且 OpenAPI 未變更
    當 服務重新啟動並再次註冊
    那麼 回應新增 0 筆、不變 2 筆、pendingPublish 為 false

  場景: 多台主機各自註冊只補上位址
    假如 服務已由 "http://sample-host-1:51290" 註冊
    當 同一服務由 "http://sample-host-2:51290" 註冊
    那麼 上游 "node-sample" 在該部署區有 2 個位址

  場景: 只能註冊 API Key 所屬的服務
    當 服務送出 "x-gateway" upstream 為 "go-mes" 的 OpenAPI
    那麼 回應 400,code 為 "IMPORT_HAS_ERRORS"
    而且 不寫入任何路由

  @security
  場景: 不可搶用其他上游的 route_code
    假如 路由 "mes.workorder.get" 屬於上游 "go-mes"
    當 服務 "node-sample" 送出 operationId 為 "mes.workorder.get" 的 OpenAPI
    那麼 回應 code 為 "IMPORT_HAS_ERRORS",details 說明 route_code 已屬於其他上游

  @security
  場景大綱: API Key 驗證
    當 以 "<API Key>" 呼叫 POST /api/admin/registrations
    那麼 回應 <HTTP>,code 為 "<code>"

    例子:
      | API Key                    | HTTP | code              |
      | (未提供)                   | 401  | UNAUTHENTICATED   |
      | 錯誤的金鑰                 | 401  | UNAUTHENTICATED   |
      | 已停用的金鑰               | 401  | UNAUTHENTICATED   |
      | 來源 IP 不在允許清單的金鑰 | 403  | PERMISSION_DENIED |

  場景: 新增 API 前查詢既有路由
    當 開發者以 API Key 呼叫 GET /api/admin/routes/catalog?q=單一項目
    那麼 回應包含符合關鍵字的路由,含狀態(含草稿)、說明與 Gherkin

  場景: 登入者需要路由檢視權限才能查詢
    假如 使用者 "S112009" 沒有 "gw.admin.route.read"
    當 "S112009" 呼叫 GET /api/admin/routes/catalog
    那麼 回應 403,code 為 "PERMISSION_DENIED"
