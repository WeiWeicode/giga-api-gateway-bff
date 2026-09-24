# language: zh-TW
@mvp @W3-4.4 @W3-4.5 @W3-4.9 @security
功能: Token、Cookie 與工作階段
  為了讓前端不接觸 Token,並能即時撤銷登入
  身為資安管理者
  我需要 Token 只存在 httpOnly Cookie,並支援 Refresh Rotation、登出與 CSRF 防護

  背景:
    假如 "S112009" 已登入並取得 Cookie "gn_at"、"gn_rt"、"gn_csrf"

  場景: Cookie 屬性正確
    那麼 Cookie "gn_at" 具有 "HttpOnly; Secure; SameSite=Strict; Path=/",效期 15 分鐘
    而且 Cookie "gn_rt" 具有 "HttpOnly; Secure; SameSite=Strict; Path=/api/auth",效期 8 小時
    而且 Cookie "gn_csrf" 具有 "Secure; SameSite=Strict" 且不是 HttpOnly

  場景: 非 GET 請求缺少 CSRF 標頭時拒絕
    當 使用者送出 "POST /api/mes/work-orders/1/reports" 且未帶 "X-CSRF-Token"
    那麼 回應狀態為 403
    而且 回應 code 為 "CSRF_INVALID"

  場景: CSRF 標頭與 Cookie 相符時放行
    當 使用者送出 "POST /api/mes/work-orders/1/reports" 並帶 "X-CSRF-Token" 等於 "gn_csrf"
    那麼 請求轉發到上游

  場景: Access Token 過期時以 Refresh Token 換發
    假如 "gn_at" 已過期
    當 使用者呼叫 "POST /api/auth/refresh"
    那麼 回應狀態為 200
    而且 取得新的 "gn_at" 與新的 "gn_rt"
    而且 舊的 "gn_rt" 失效

  場景: 舊 Refresh Token 被重複使用時撤銷整個家族
    假如 使用者已用 "gn_rt" 換發過一次
    當 有人再以舊的 "gn_rt" 呼叫 "POST /api/auth/refresh"
    那麼 回應狀態為 401
    而且 回應 code 為 "REFRESH_TOKEN_INVALID"
    而且 該 Refresh Token 家族的所有 Token 皆失效
    而且 "gw.auth_log" 新增 event 為 "token_reuse_detected" 的紀錄

  場景: 登出後 Access Token 立即失效
    當 使用者呼叫 "POST /api/auth/logout"
    那麼 回應清除所有 "gn_*" Cookie
    而且 再以登出前的 "gn_at" 呼叫任何 API 皆回 401

  場景大綱: 記住我只在公司內網提供
    假如 使用者從 <來源> 登入並勾選「記住我」
    那麼 "gn_rt" 的效期為 <效期>

    例子:
      | 來源         | 效期   |
      | 公司內網 IP  | 7 天   |
      | 其他 IP      | 8 小時 |

  場景: IT 變更角色後,使用者下一次請求就重新計算權限
    假如 IT 移除 "S112009" 的角色 "mes-operator"
    當 使用者以原本的 "gn_at" 呼叫 "GET /api/mes/work-orders"
    那麼 BFF 發現權限版本已變更並要求 Refresh
    而且 Refresh 後的權限不包含 "mes-operator" 的權限

  場景: 轉發上游時附上短效內部 Token
    假如 路由 "mes.workorder.list" 的上游服務代碼為 "go-mes"
    當 使用者呼叫 "GET /api/mes/work-orders"
    那麼 上游收到 "X-Internal-Token"
    而且 該 Token 以 ES256 簽章,aud 為 "go-mes",效期 60 秒
    而且 該 Token 含 "emp" 為 "S112009"、"amr" 為 "ad"
    而且 上游收到的請求不含 Cookie

  場景: 下游可由 JWKS 取得公鑰
    當 內網服務呼叫 "GET /.well-known/jwks.json"
    那麼 回應包含目前與前一把簽章金鑰的公鑰與 kid
