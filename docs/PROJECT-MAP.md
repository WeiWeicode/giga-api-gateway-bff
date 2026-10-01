# 專案地圖 — giga-api-gateway-bff

> **最後更新:2026-10-01**(`:443` 改用公司 `*.gigasolar.com.tw` 憑證、`:9443` 憑證分開為 `agent-server.crt`)。
> 開發新功能後,在同一個變更內更新本文件(`AGENT.md` §10.7)。只寫結構與職責,細節連到 `docs/` 對應章節。

Gateway:Nginx(`:443` 瀏覽器與系統對系統、`:9443` 端點 Agent mTLS)+ BFF(登入、權限、動態路由表)+ 前端 / 後端共用套件。**所有 GigaNexus 專案的上位規範**。

---

## 1. 目錄

```
giga-api-gateway-bff/
├─ nginx/                     反向代理(Docker 映像)
│  ├─ nginx.conf
│  ├─ conf.d/portal.conf      :80 轉址、:443 瀏覽器 / 系統對系統、SPA 子路徑、/api → BFF、/ws
│  ├─ conf.d/agent.conf       :9443 端點 Agent 專用(mTLS + HTTPS / WebSocket → Endpoint Server;現行為 gRPC 版,待改寫)
│  ├─ snippets/               共用片段:ssl、security-headers、proxy-bff、websocket、spa-*、json-errors
│  ├─ templates/              依部署區不同的值(envsubst)
│  └─ allowlists/<dev|test|prod>/  Agent 簽發者、內部服務、BPM Webhook 來源
├─ bff/                       BFF(Node.js 22 + TypeScript + Fastify 5)
│  ├─ src/                    原始碼(建置只取這裡,tsconfig.build.json)
│  │  ├─ server.ts            進入點:載入設定、啟動
│  │  ├─ app.ts               組裝 Fastify:plugins → modules;X-Request-Id
│  │  ├─ config.ts            設定載入與驗證(zod)
│  │  ├─ errors.ts            錯誤代碼與 AppError(PRD §8.1.1)
│  │  ├─ plugins/             基礎設施:db(外部唯讀來源)、redis、errors(統一錯誤回應)
│  │  ├─ modules/             功能模組(Fastify plugin)
│  │  │  ├─ auth/             登入(AD / 本機)、工作階段、JWT 金鑰、API Key、人事資料、/api/auth/*
│  │  │  ├─ rbac/             權限計算與快取
│  │  │  ├─ router/           動態路由:路由樹、快照、同步、限流 / 快取、上游呼叫
│  │  │  ├─ admin/            管理 API:後端註冊、OpenAPI 匯入、demo(DB 檢視、上手導覽)
│  │  │  ├─ notify/           站內通知 WebSocket /ws/notify
│  │  │  └─ health/           /healthz、/readyz
│  │  ├─ db/                  資料存取:client(連線池)、schema/(Drizzle)、external/(BPM、LOS、PortalSolar 唯讀)、
│  │  │                       sync/release(發佈 → Redis)、migrate、seed、sql2012-guard
│  │  └─ cli/                 管理 CLI(`npm run gw`)、OpenAPI 轉路由草稿
│  ├─ scripts/                開發工具:SQL 2012 語法檢查、重設整合測試庫
│  └─ test/                   測試(與 src 平行):unit/、integration/、e2e/
├─ db/                        migrations/(Drizzle 產生、人工審查,不可修改已套用的)、seed/
├─ web-kit/src/               @giganexus/web-kit:前端 HTTP(CSRF、Token 更新)與 /api/auth/me
├─ sdk/node/src/              @giganexus/backend-sdk:內部 Token 驗證、自動註冊、路由查詢 CLI
├─ samples/node-backend/      下游 Node.js 後端樣本(src/、test/、AGENT.md)
├─ deploy/                    Docker Compose(開發 / 測試 / 正式)、env 範例、健康檢查、煙霧測試、gen-temp-pki.sh(測試區臨時憑證)
│  └─ dev/                    ※ 本機環境(up.sh、開發憑證 secrets/pki、mssql-init)— 不進版控
├─ tools/                     ※ 本機模擬服務(mock-ad、mock-upstream、sample-spa)— 不進版控
├─ ci-templates/              SPA 發佈的 GitLab CI 範本
├─ drizzle.config.ts          Drizzle Kit 設定(migration 產生)
└─ docs/                      規格(PRD、ARCHITECTURE、DATABASE、各 GUIDE、IMPL-PLAN、Gherkin、修正紀錄);部署:DEPLOYMENT(CI/CD)、
                             COMPANY-ENV-PLAN(上公司調整清單)、TEST-DEPLOY-RUNBOOK(CI 未就緒時的測試區手動架設)、GITLAB-SETUP(GitLab 與 Runner 架設)
```

## 2. 分層(AGENT.md §10.7.2 TypeScript 列)

| 層 | 位置 | 說明 |
| --- | --- | --- |
| 介面 | `bff/src/modules/*/routes.ts`、`modules/router/plugin.ts`、`modules/notify/ws.ts`、`modules/health/`、`cli/` | 參數驗證、回應格式;不寫商業規則 |
| 核心邏輯 | `modules/auth/`(login、session、identity、password、profile)、`modules/rbac/permission.ts`、`modules/router/`(table、snapshot、guards、upstream)、`modules/admin/`(registration、route-import) | 登入、權限、路由比對與轉送 |
| 基礎設施 | `plugins/`(db、redis、errors)、`db/`(client、schema、external、sync、migrate) | 資料庫、Redis、外部唯讀來源 |
| 共用設定 / 錯誤 | `config.ts`、`errors.ts` | 全專案共用 |
| 共用套件(其他 repo 使用) | `web-kit/`、`sdk/node/` | 前端 / 下游後端依賴 |

## 3. 主要流程

| 流程 | 經過 |
| --- | --- |
| 瀏覽器呼叫 API | Nginx `conf.d/portal.conf` → `snippets/proxy-bff.conf` → `bff/src/app.ts` → 內建路由(`modules/auth/routes.ts` 等)或 `modules/router/plugin.ts`(`table` 比對 → `guards` 限流 / 快取 → `rbac` 權限 → `upstream` 帶 `X-Internal-Token` 轉給下游) |
| 登入 | `modules/auth/routes.ts` → `login.ts`(`ldap.ts` / `password.ts`)→ `profile.ts`(BPM → LOS → AD)→ `session.ts` + `keys.ts` |
| 路由發佈 | CLI / 管理 API → `db/sync/release.ts`(SQL Server → Redis)→ 各 BFF `modules/router/sync.ts` 載入快照、原子替換路由樹 |
| 下游後端上架 | 下游以 `sdk/node` 自動註冊 → `modules/admin/registration.ts` → `route-import.ts`(草稿)→ IT 發佈 |
| 端點 Agent | Nginx `conf.d/agent.conf`(:9443 mTLS)→ `proxy_pass`(HTTPS / WebSocket)→ Endpoint Server(W6,`../RustIt`,Rust + Axum);BFF 不經手 |

## 4. 要改什麼 → 看哪裡

| 要做的事 | 位置 |
| --- | --- |
| 新增 / 修改設定值 | `bff/src/config.ts`、`bff/.env.example`、`deploy/*.env.example` |
| 新增錯誤代碼 | 先更新 `docs/PRD.md` §8.1.1,再改 `bff/src/errors.ts` |
| 新增 BFF 內建 API | `bff/src/modules/<模組>/routes.ts`,在 `app.ts` 註冊 |
| 資料表變更 | `bff/src/db/schema/*.ts` → `npm run db:generate` → 審查 `db/migrations/` → `npm run db:check-2012` |
| Redis 鍵 | `docs/DATABASE.md` §6 先登記 |
| Nginx 路徑 / 標頭 | `nginx/conf.d/`、`nginx/snippets/`;依部署區的值放 `templates/`、`allowlists/` |
| 前端共用 HTTP / 權限 | `web-kit/src/` |
| 下游後端 SDK | `sdk/node/src/` |

## 5. 測試地圖

| 類型 | 位置 | 指令(在 `bff/`) |
| --- | --- | --- |
| 單元 | `bff/test/unit/` | `npm test` |
| 整合(需 SQL Server) | `bff/test/integration/` | `npm run test:int` |
| 端到端(需 `sh deploy/dev/up.sh`) | `bff/test/e2e/`(編號即執行順序) | `npm run test:e2e` |
| 驗收場景 | `docs/Gherkin/**/*.feature` | 對應上列測試 |
| 下游樣本 | `samples/node-backend/test/` | 在該目錄 `npm test` |

## 6. 與設計原則的已知差異

| 項目 | 說明 |
| --- | --- |
| 測試目錄名稱 `test/` | Node.js 專案慣例;與原則中的 `tests/` 同義,不改名 |
| `web-kit/`、`sdk/node/` 沒有測試 | 由 `bff/test/e2e` 與使用端間接驗證;新增功能時再補 `test/` |
| 沒有 `src/utils/` | 目前沒有跨模組的無 I/O 工具函式;需要時再建立並更新本地圖 |
| `tools/`、`deploy/dev/` 不進版控 | 本機環境,內容以開發主機為準(AGENT.md §9) |
