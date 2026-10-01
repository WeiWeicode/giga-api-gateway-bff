# GigaNexus Gateway

Nginx 反向代理網關 + Node.js BFF(Fastify 5 / TypeScript / Drizzle ORM / SQL Server 2012 / Redis 7)。
規格見 [docs/](docs/):[PRD](docs/PRD.md)、[ARCHITECTURE](docs/ARCHITECTURE.md)、[DATABASE](docs/DATABASE.md)、[TECH-STACK](docs/TECH-STACK.md)、[IMPL-PLAN](docs/IMPL-PLAN.md)、[FRONTEND-GUIDE](docs/FRONTEND-GUIDE.md)、[BACKEND-GUIDE](docs/BACKEND-GUIDE.md)、[ENDPOINT-AGENT-GUIDE](docs/ENDPOINT-AGENT-GUIDE.md)、[DEPLOYMENT](docs/DEPLOYMENT.md)、[Gherkin](docs/Gherkin/README.md);上公司環境的調整與交接見 [COMPANY-ENV-PLAN](docs/COMPANY-ENV-PLAN.md)。

## 目錄(TECH-STACK.md §2)

```
docs/                 規格文件與 Gherkin 驗收場景
nginx/                nginx.conf、conf.d/portal.conf(:80/:443)、conf.d/agent.conf(:9443 mTLS)、snippets/、allowlists/<區域>/、Dockerfile
bff/                  BFF(Node 專案:package.json、src/、test/、Dockerfile)
  src/db/schema/        gw.* 資料表(Drizzle)          src/db/external/   BPM / LOS / PortalSolar 唯讀 view
  src/db/sync/          發佈、Redis 同步與補償          src/modules/        auth、rbac、router、admin、notify、health
  src/cli/              管理 CLI(OpenAPI 匯入、發佈、回滾、IT 代建本機帳號、API Key)
  test/unit|integration|e2e/
web-kit/              前端共用套件 @giganexus/web-kit(HTTP、CSRF、401 Refresh、useAuth / can、路由守衛)
sdk/node/             下游後端共用套件 @giganexus/backend-sdk(GW_ENV、Token 驗證、自動註冊、gw-lookup 路由查詢)
samples/node-backend/ Node.js 下游後端樣本(Fastify)與 AI 協作準則 AGENT.md
ci-templates/         前端 SPA 部署 CI 範本
db/migrations/        drizzle-kit 產生、人工審查 2012 相容性後的 SQL
db/seed/              種子資料(內建角色、gw.admin.* 權限、限流政策、公司與網域)
drizzle.config.ts
deploy/               docker-compose.yml(共用)+ .test.yml / .prod.yml、env 範本、gen-temp-pki.sh、煙霧測試
.gitlab-ci.yml
```

## 開發環境

開發機直接連公司 SQL Server 2012 測試庫 `giganexus_gw_test`(與測試區共用,寫入的資料測試區看得到)與本機 Redis:

```bash
docker run -d --name gw-redis -p 127.0.0.1:16379:6379 redis:7-alpine
```

```bash
cd bff && cp .env.example .env
```

填入 `.env` 的密碼(向 DBA 取得)與 JWT 金鑰後:

```bash
npm run dev
```

```bash
npm run dev:worker
```

- BFF 在 `http://localhost:3100`;worker 處理 Webhook、通知與部門同步佇列。設定 `MAIL_HOST` 時必須同時設定 `MAIL_REDIRECT_TO`(只填自己的信箱)。
- 瀏覽器與跨專案驗證以測試區 `https://giganexus-test.gigasolar.com.tw` 為準:推送 `develop` 由 CI 部署(DEPLOYMENT.md)。
- 需要登入帳號時以假工號建立本機帳號(自行註冊 → `npm run gw -- local:approve --emp <工號>`),**不可使用真實員工的帳密**,測完刪除。

## 測試

```bash
cd bff
npm test            # 單元測試
npm run test:int    # 整合測試(Drizzle PoC;自動重建 giganexus_gw_test)
npm run test:e2e    # 對測試區的端到端測試(需 ssh host2,見下方)
```

E2E 從開發機經 `https://giganexus-test.gigasolar.com.tw` 呼叫測試區:CLI 與 Redis 經 `ssh host2` 在測試區容器內執行、資料庫以 `.env` 直連 `giganexus_gw_test`。測試自行建立假工號(`Z99E2E` 開頭)的本機帳號、角色與 API Key,結束時刪除;不使用真實員工帳密,也不執行會影響共用測試區的操作(停止容器、發佈所有草稿)。測試區需先部署要驗證的版本。

後端樣本:`cd samples/node-backend && npm install && npm test`(OpenAPI 自我檢查、Token 驗證、部署區設定)。

### SQL Server 2012 相容性

開發與測試區都直接連公司 SQL Server 2012(`giganexus_gw_test`),另有兩道防線:

1. `npm run db:check-2012`:靜態檢查 migration 是否含 2016+ 語法。
2. `SQL2012_GUARD=error`:開發時 Drizzle 產生的每一句 SQL 都經同一套規則檢查,違規即丟例外。

`npm run test:int` 會清空目標庫的 schema `gw`,**不可指向 `giganexus_gw_test`**,需 DBA 另建專用庫(P-04)後執行。

## 目前進度

| 項目 | 狀態 |
| --- | --- |
| W3-1 骨架、schema、migration、seed、Drizzle PoC | 完成(migration 已套用至公司 2012 測試庫,`test:int` 正式複驗待 P-04 專用庫) |
| W3-2 Nginx 入口:TLS、SPA、`/api`、WebSocket、`auth_request`、Webhook 白名單、JSON 錯誤、限流 | 完成 |
| ~~W3-3 Agent `:9443` mTLS + gRPC~~ | gRPC 版完成後**取消**:Agent 改為 Rust + WebSocket(PRD v0.9),`agent.conf` 與 E2E 隨 W6 改寫([ENDPOINT-AGENT-GUIDE.md](docs/ENDPOINT-AGENT-GUIDE.md) §10 G0);mTLS、簽發者限制、憑證指紋限流沿用 |
| W3-4 AD 多網域登入、本機帳號、JWT Cookie、Refresh Rotation、CSRF、RBAC、內部 Token / JWKS、登入補查 BPM / LOS、IT 代建 | 完成 |
| W3-4.6b 人員排程同步 Worker、W3-4.16 舊單一入口遷移 | 未開始(後者需 P-15 測試帳號) |
| W3-5 動態路由、聚合、限流、快取、斷路器、發佈 / 回滾 / 補償、CLI 匯入 | 完成 |
| W3-5.7a 後端自動註冊(API Key、草稿)、路由查詢、`gw.api_route.gherkin`、Node.js SDK 與樣本 | 完成 |
| W3-5.8 通知(Email + 站內)、W3-5.8a/b 自行註冊與忘記密碼、W3-5.10 Webhook 驗簽 | 完成(2026-10-01;目前沒有 Webhook 外部來源,BPM 不送) |
| W3-5.12 整合週(k6 壓測、資安檢查) | 未開始 |
| P2-1 路由設定管理 API(上游、路由、聚合步驟、限流政策,`row_ver` 樂觀鎖)、P2-2 發佈 / 預覽 / 回滾 API | 完成(2026-10-01;路由試打 `POST /api/admin/routes/:id/test` 未做) |
| P2-3a 指派規則、部門樹、權限分類、應用登記與 `me.apps` | 完成(部門樹已由 BPM `OrganizationUnit` / `Organization` 同步至 `gw.department`(2026-10-01,DBA 已授權 `bpm_reader` 唯讀)) |

注意事項:

- Nginx `ssl_verify_client on` 對無效 / 無憑證的 Agent 會完成 TLS 握手後在 HTTP 層回 400(不會到達 Endpoint Server),而非 TLS 層中斷;2026-10-01 需求方確認接受(ENDPOINT-AGENT-GUIDE §10 G2)。
- 斷路器狀態由各 BFF 實例在記憶體中維護(DATABASE.md §6 列有 `gw:cb:{upstream}`,目前未使用)。
- 權限對應變更時 CLI 與管理 API 都以全體使用者遞增 `perm_version`(DATABASE.md §7.2 為「受影響使用者」)。
- 測試區(主機 2)已由 `.gitlab-ci.yml` `develop` Pipeline 部署(2026-09-30,`https://giganexus-test.gigasolar.com.tw`);`deploy-prod` 與 `deploy/docker-compose.prod.yml` 待 2026-12 正式區(主機 3)建置後執行。
