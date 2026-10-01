# language: zh-TW
@phase2 @P2-3a
功能: 依部門與職位指派角色,並以應用 / 選單 / Tab / 按鈕分類權限
  為了讓人事異動後權限自動跟著調整,並在一處管理所有應用的畫面權限
  身為 IT 權限管理人員
  我需要以「公司 / 部門(含下層)/ 職級 / 職稱」規則指派角色,並在 GigaItApp 設定各應用的權限

  # PRD §8.3.1–§8.3.2(v0.7);DATABASE §3.2。職位以職級為主、職稱選配;部門預設含下層。

  背景:
    假如 部門樹為 "IT"(資訊部)→ "IT-SYS"(系統課)、"IT-NET"(網管課)
    而且 角色 "it-engineer" 有指派規則:部門 "IT"、含下層、職級 ["4","5"]
    而且 角色 "it-engineer" 擁有權限 "it.app.access"

  場景大綱: 規則比對人事欄位
    假如 使用者部門為 "<部門>"、職級為 "<職級>"
    當 計算該使用者的有效角色
    那麼 <結果> 角色 "it-engineer"

    例子:
      | 部門   | 職級 | 結果   |
      | IT     | 4    | 取得   |
      | IT-SYS | 5    | 取得   |
      | IT-NET | 6    | 不取得 |
      | HR     | 4    | 不取得 |

  場景: 規則內多個條件須同時符合
    假如 角色 "it-lead" 有指派規則:部門 "IT"、職級 ["6"]、職稱 "課長"
    當 部門 "IT-SYS"、職級 "6"、職稱 "工程師" 的使用者登入
    那麼 不取得角色 "it-lead"

  場景: 人事異動後權限自動調整
    假如 使用者 "S112009" 部門為 "HR",沒有 "it.app.access"
    當 人員同步將其部門改為 "IT-SYS"、職級 "4"
    那麼 該使用者的 perm_version 遞增
    而且 下一次請求即具備 "it.app.access"

  場景: 指派規則變更立即生效
    當 IT 以 DELETE /api/admin/roles/it-engineer/rules/<規則 id> 移除部門 "IT" 的規則
    那麼 所有使用者的 perm_version 遞增
    而且 稽核紀錄新增一筆,actor 為實際操作的使用者

  場景: 權限試算與實際登入結果一致
    當 IT 以 POST /api/admin/rbac/preview 試算 { "deptCode": "IT-SYS", "jobLevel": "5" }
    那麼 回應的角色包含 "it-engineer",命中來源為 "指派規則"
    而且 權限與 apps 和同部門、同職級使用者登入後的 /api/auth/me 相同

  場景: 按鈕權限等於 API 權限
    假如 portal-api 的 x-permissions 宣告 { code: "portal.news.publish", kind: "button", parent: "portal.news.read" }
    而且 路由 "POST /api/portal/news" 的權限代碼為 "portal.news.publish"
    當 沒有 "portal.news.publish" 的使用者直接呼叫 POST /api/portal/news
    那麼 回應 403,code 為 "PERMISSION_DENIED"

  場景: 權限以樹狀回傳供設定畫面使用
    當 IT 呼叫 GET /api/admin/permissions?tree=1&app=portal
    那麼 回應以 "portal.app.access" 為根,依 parent_code 與 sort 列出選單、Tab、按鈕
