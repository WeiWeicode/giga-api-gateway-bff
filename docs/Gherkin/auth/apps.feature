# language: zh-TW
@phase2 @P2-3a
功能: 應用登記、應用切換與應用層守衛
  為了讓員工登入一次就能在有權限的應用之間切換
  身為 員工
  我要在任一應用右上角看到我可使用的應用,沒有權限的應用看不到也進不去

  # PRD §8.3.3(v0.7);FRONTEND-GUIDE §7.4。

  背景:
    假如 已登記應用 "portal"(員工入口網,"/",權限 "portal.app.access")與 "it"(IT 管理系統,"/it/",權限 "it.app.access")
    而且 角色 "employee" 擁有 "portal.app.access"

  場景: /api/auth/me 只回傳有權限的應用
    假如 使用者 "S112009" 只有角色 "employee"
    當 呼叫 GET /api/auth/me
    那麼 apps 只有 "portal"

  場景: 同時有兩個應用權限
    假如 使用者 "S100001" 另有 "it.app.access"
    當 呼叫 GET /api/auth/me
    那麼 apps 依排序為 "portal"、"it"

  @e2e
  場景: 沒有 IT 應用權限時導回員工入口網
    假如 使用者 "S112009" 已登入且沒有 "it.app.access"
    當 開啟 /it/gateway/services/routes
    那麼 導向 "/" 並提示「您沒有 IT 管理系統的使用權限」
    而且 呼叫 /api/it/* 回應 403,code 為 "PERMISSION_DENIED"

  @e2e
  場景: 未登入時先登入再回到原頁
    當 未登入的使用者開啟 /it/gateway/services/routes
    那麼 導向 /login?redirect=%2Fit%2Fgateway%2Fservices%2Froutes
    而且 登入成功後回到該頁

  場景: 停用的應用不出現在清單
    假如 應用 "it" 已停用
    當 使用者 "S100001" 呼叫 GET /api/auth/me
    那麼 apps 不含 "it"
