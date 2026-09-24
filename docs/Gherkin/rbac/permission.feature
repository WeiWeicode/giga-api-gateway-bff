# language: zh-TW
@mvp @W3-4.6 @W3-4.7 @W3-4.8
功能: RBAC 權限控管
  為了讓每支 API 只給有權限的人呼叫
  身為 IT 管理者
  我需要以「AD 群組 / 公司 / 個別指派 → 角色 → 權限 → API」控制存取

  背景:
    假如 路由 "GET /api/mes/work-orders" 的 auth_mode 為 "permission",權限代碼為 "mes.workorder.read"
    而且 角色 "mes-operator" 擁有權限 "mes.workorder.read"

  場景大綱: 依 auth_mode 決定是否需要登入與權限
    假如 路由 "<路由>" 的 auth_mode 為 "<模式>"
    當 <呼叫者> 呼叫該路由
    那麼 回應狀態為 <狀態>

    例子:
      | 路由                       | 模式          | 呼叫者               | 狀態 |
      | GET /api/portal/news       | public        | 未登入的使用者       | 200  |
      | GET /api/portal/profile    | authenticated | 未登入的使用者       | 401  |
      | GET /api/portal/profile    | authenticated | 已登入的一般員工     | 200  |
      | GET /api/mes/work-orders   | permission    | 沒有該權限的員工     | 403  |
      | GET /api/mes/work-orders   | permission    | 具 mes-operator 角色 | 200  |

  場景: 無權限時回應統一格式
    當 沒有權限的員工呼叫 "GET /api/mes/work-orders"
    那麼 回應狀態為 403
    而且 回應 code 為 "PERMISSION_DENIED"
    而且 回應內容包含 "code"、"message"、"requestId"
    而且 請求不會轉發到上游

  場景: AD 群組自動對應角色
    假如 AD 群組 "GN-MES-Operators" 對應角色 "mes-operator"
    而且 "S112009" 屬於 AD 群組 "GN-MES-Operators"
    當 "S112009" 登入後呼叫 "GET /api/mes/work-orders"
    那麼 回應狀態為 200

  場景: 公司預設角色適用本機帳號
    假如 公司 "禾迅" 的預設角色為 "hv-employee"
    而且 角色 "hv-employee" 擁有權限 "portal.news.read"
    當 本機帳號 "V112001" 登入
    那麼 回應的 me 中 permissions 包含 "portal.news.read"

  場景: 兼任公司的角色併入本人
    假如 "V112001" 有兼任帳號 "GV112001" 屬於公司 "碩禾"
    而且 公司 "碩禾" 的預設角色為 "gs-employee"
    當 "V112001" 登入
    那麼 回應的 me 中 roles 同時包含 "hv-employee" 與 "gs-employee"
    而且 內部 Token 的 "cos" 包含 "禾迅" 與 "碩禾"

  場景: 個別指派可設定到期日
    假如 "V112001" 被個別指派角色 "mes-operator",到期日為昨天
    當 "V112001" 呼叫 "GET /api/mes/work-orders"
    那麼 回應狀態為 403

  場景: 權限快取命中時判斷在 2 毫秒內完成
    假如 "S112009" 的權限已快取於 "gw:perm:{userId}:{pv}"
    當 "S112009" 連續呼叫 "GET /api/mes/work-orders" 1000 次
    那麼 權限判斷的 p95 小於 2 毫秒

  場景: 角色權限變更後遞增權限版本
    當 IT 從角色 "mes-operator" 移除權限 "mes.workorder.read"
    那麼 擁有該角色的使用者 perm_version 皆加 1
    而且 "gw.audit_log" 記錄 action "role.permission.revoke"

  場景: 反查誰可以呼叫某支 API
    當 IT 查詢權限 "mes.workorder.read" 的可存取對象
    那麼 結果列出擁有該權限的角色、AD 群組、公司與個別使用者
