# language: zh-TW
@mvp @W3-2 @e2e
功能: Nginx 入口(:443)
  為了讓所有前端與 API 經由同一個地端入口進出
  身為 Gateway 維運人員
  我需要 Nginx 以主機 IP 提供 HTTPS、SPA 子路徑與 API 轉發,並淨化危險標頭

  背景:
    假如 Gateway 以 "https://GATEWAY_IP" 對外提供服務
    而且 伺服器憑證的 SAN 包含 Gateway 的 IP 位址

  場景: HTTP 一律轉址到 HTTPS
    當 使用者以 "http://GATEWAY_IP/mes/" 連線
    那麼 回應狀態為 301
    而且 Location 標頭為 "https://GATEWAY_IP/mes/"

  @security
  場景大綱: 只接受 TLS 1.2 以上
    當 用戶端以 <協定> 連線到 ":443"
    那麼 TLS 握手 <結果>

    例子:
      | 協定    | 結果 |
      | TLS 1.0 | 失敗 |
      | TLS 1.1 | 失敗 |
      | TLS 1.2 | 成功 |
      | TLS 1.3 | 成功 |

  場景: SPA 子路徑在重新整理深層頁面時回傳該系統的 index.html
    假如 "/srv/www/mes/current" 已部署 MES 看板
    當 使用者直接開啟 "/mes/work-orders/123"
    那麼 回應狀態為 200
    而且 回應內容為 MES 看板的 "index.html"
    而且 "index.html" 的 Cache-Control 為 "no-cache"

  場景: 帶 hash 的靜態資源長期快取
    當 使用者請求 "/mes/assets/index-a1b2c3.js"
    那麼 Cache-Control 為 "max-age=31536000, immutable"

  @security
  場景: 清除使用者偽造的內部身分標頭
    當 用戶端呼叫 "/api/mes/work-orders" 並帶入標頭:
      | 標頭             | 值          |
      | X-User-Id        | admin       |
      | X-Internal-Token | forged.jwt  |
    那麼 BFF 收到的請求不包含 "X-User-Id" 與用戶端送入的 "X-Internal-Token"
    而且 BFF 收到的請求帶有 "X-Request-Id"

  @security
  場景: 回應不洩漏伺服器資訊
    當 用戶端呼叫任一 "/api/" 路徑
    那麼 回應不包含 "Server" 版本與 "X-Powered-By" 標頭
    而且 回應包含 "X-Content-Type-Options: nosniff"

  @security
  場景: 登入 API 套用較嚴格的來源 IP 限流
    假如 同一來源 IP 在 1 分鐘內已呼叫 "/api/auth/login" 5 次
    當 該 IP 再次呼叫 "/api/auth/login"
    那麼 回應狀態為 429
    而且 回應 code 為 "RATE_LIMITED"

  場景: 通知 WebSocket 可長時間維持
    假如 使用者已登入
    當 使用者連線 "wss://GATEWAY_IP/ws/notify"
    那麼 連線升級成功
    而且 連線在 1 小時內不會因逾時中斷

  場景: 串流 WebSocket 透過 auth_request 驗證後直連 Endpoint Server
    假如 使用者已登入且具備端點遠端操作權限
    當 使用者連線 "wss://GATEWAY_IP/ws/endpoint/PC-001"
    那麼 Nginx 以 "/_auth/verify" 向 BFF 驗證並收到 204
    而且 連線轉給 Endpoint Server 並帶有 "X-Internal-Token"

  場景: 未登入者無法建立串流 WebSocket
    當 未登入的用戶端連線 "wss://GATEWAY_IP/ws/endpoint/PC-001"
    那麼 回應狀態為 401
