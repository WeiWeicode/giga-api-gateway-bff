# GigaNexus Gateway — Gherkin 行為規格

> 以 Gherkin(繁體中文關鍵字,`# language: zh-TW`)描述 Gateway 的驗收行為,對應 [PRD.md](../PRD.md) **v0.7** 與 [IMPL-PLAN.md](../IMPL-PLAN.md) 的工作項目。
> 可直接供 `@cucumber/cucumber`(或 `vitest-cucumber`)執行;步驟定義放在 `bff/test/features/steps/`(待實作)。

## 檔案一覽

| 目錄 / 檔案 | 內容 | PRD | 工作項目 |
| --- | --- | --- | --- |
| `gateway/nginx-entry.feature` | `:443` 入口、HTTP 轉址、SPA 子路徑、標頭淨化、入口限流、WebSocket | §7.1–§7.4 | W3-2 |
| `gateway/agent-mtls.feature` | Agent 專用 `:9443` mTLS + gRPC | §7.6 | W3-3 |
| `auth/ad-login.feature` | AD 多網域登入、失敗限流、群組對應角色 | §8.2.1 | W3-4.2–4.3 |
| `auth/token-session.feature` | Cookie、CSRF、Refresh Rotation、登出、記住我、內部 Token | §8.2.2–§8.2.3 | W3-4.4–4.5、4.9 |
| `auth/local-account.feature` | 登入方式判斷、本機帳號登入、密碼政策、鎖定 | §8.2.5 | W3-4.14–4.15 |
| `auth/self-registration.feature` | 自行註冊(Email 驗證、到職日比對、管理員審核) | §8.2.5 | W3-5.8a |
| `auth/password-reset.feature` | 忘記密碼、IT 重設、變更密碼 | §8.2.5 | W3-5.8b |
| `auth/legacy-migration.feature` | 舊單一入口帳號首次登入自動遷移 | §8.2.5、DATABASE §9 | W3-4.16 |
| `rbac/permission.feature` | 路由 `auth_mode`、權限檢查、角色來源、權限版本 | §8.3 | W3-4.6–4.8 |
| `rbac/role-rules.feature` | 依部門(含下層)/ 職級 / 職稱指派角色、權限分類與樹、權限試算(`@wip`,規格) | §8.3.1–§8.3.2 | P2-3a |
| `auth/apps.feature` | 應用登記、`me.apps`、應用切換與應用層守衛(`@wip`,規格) | §8.3.3 | P2-3a |
| `router/dynamic-routing.feature` | 代理、路徑改寫、限流、快取、斷路器、聚合 | §8.4.1–§8.4.2 | W3-5.1–5.5 |
| `router/release-publish.feature` | 草稿 / 發佈 / 回滾、即時生效、Redis 補償 | §8.4.3、DATABASE §7 | W3-5.6–5.7、P2-2 |
| `router/api-import.feature` | OpenAPI 匯入規則(含說明與行為規格) | §8.4.4、BACKEND-GUIDE §6 | W3-5.7、W3-5.7a、P2-4 |
| `router/service-registration.feature` | 後端自動註冊(API Key、草稿)、既有路由查詢 | §8.4.4、§8.7、BACKEND-GUIDE §7.5 | W3-5.7a |
| `employee-sync/employee-sync.feature` | BPM / LOS 人員同步、兼任帳號、安全檢查 | DATABASE §8 | W3-4.6a–6c |
| `notify/notification.feature` | Email / 站內通知、佇列重試、去重 | §8.5 | W3-5.8–5.9 |
| `webhook/webhook.feature` | BPM Webhook 驗簽、防重放、去重 | §7.5、§8.6 | W3-5.10 |

## 標籤慣例

| 標籤 | 意義 |
| --- | --- |
| `@mvp` / `@phase2` | 所屬階段(PRD §13) |
| `@W3-4.14` 等 | 對應 IMPL-PLAN 工作項目 |
| `@security` | 安全相關,整合週資安檢查必跑 |
| `@e2e` | 需經 Nginx 的端到端環境(docker-compose)執行 |
| `@wip` | 規格細節未定(例:忘記密碼畫面,PRD Q23),暫不列入 CI |

## 撰寫原則

- 關鍵字使用 zh-TW 官方詞彙:`功能`、`背景`、`場景`、`場景大綱`、`例子`、`假如`、`當`、`那麼`、`而且`、`但是`;**Rule 在 zh-TW 沒有中文關鍵字,須寫 `Rule:`**。
- 主機位址以 `GATEWAY_IP` 表示(避免與場景大綱的 `<參數>` 混淆),執行時由步驟定義代入。
- 以**可觀察的行為**描述(HTTP 狀態、回應 `code`、Cookie、資料表狀態),不描述實作細節。
- 數值(逾時、次數、效期)與 PRD 一致;PRD 變更時同步修改本目錄。
- 範例工號沿用文件慣例(`S112009` 碩禾 AD、`V112001` 禾迅無網域);不使用真實個資。
