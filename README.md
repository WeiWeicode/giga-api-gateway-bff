# GigaNexus Gateway

Nginx 反向代理網關 + Node.js BFF(Fastify 5 / TypeScript / Drizzle ORM / SQL Server 2012 / Redis 7)。
規格見 [docs/](docs/):[PRD](docs/PRD.md)、[ARCHITECTURE](docs/ARCHITECTURE.md)、[DATABASE](docs/DATABASE.md)、[TECH-STACK](docs/TECH-STACK.md)、[IMPL-PLAN](docs/IMPL-PLAN.md)、[FRONTEND-GUIDE](docs/FRONTEND-GUIDE.md)、[BACKEND-GUIDE](docs/BACKEND-GUIDE.md)、[DEPLOYMENT](docs/DEPLOYMENT.md)、[Gherkin](docs/Gherkin/README.md)。

## 目錄(TECH-STACK.md §2)

```
docs/                 規格文件與 Gherkin 驗收場景
nginx/                nginx.conf、conf.d/portal.conf(:80/:443)、conf.d/agent.conf(:9443 mTLS)、snippets/、allowlists/<區域>/、Dockerfile
bff/                  BFF(Node 專案:package.json、src/、test/、Dockerfile)
  src/db/schema/        gw.* 資料表(Drizzle)          src/db/external/   BPM / LOS / PortalSolar 唯讀 view
  src/db/sync/          發佈、Redis 同步與補償          src/modules/        auth、rbac、router、notify、health
  src/cli/              管理 CLI(OpenAPI 匯入、發佈、回滾、IT 代建本機帳號)
  test/unit|integration|e2e/
web-kit/              前端共用套件 @giganexus/web-kit(HTTP、CSRF、401 Refresh、useAuth / can、路由守衛)
ci-templates/         前端 SPA 部署 CI 範本
db/migrations/        drizzle-kit 產生、人工審查 2012 相容性後的 SQL
db/seed/              種子資料(內建角色、gw.admin.* 權限、限流政策、公司與網域)
drizzle.config.ts
deploy/               docker-compose.yml(共用)+ .test.yml / .prod.yml;dev/ 為本機完整環境
tools/                測試用:mock-ad(模擬 AD)、mock-upstream(模擬下游後端)、sample-spa(入口網 + MES 範例 SPA)
.gitlab-ci.yml
```

## 本機完整環境(不需連公司網路)

> `tools/`、`deploy/dev/`、`deploy/docker-compose.dev.yml`、`deploy/dev.env`(模擬 AD / 後端、範例網頁、模擬資料庫)**不進版控,只存在開發主機**。上公司環境需調整的項目見 [docs/COMPANY-ENV-PLAN.md](docs/COMPANY-ENV-PLAN.md)。

```bash
sh deploy/dev/up.sh
```

會產生開發用憑證與金鑰(`deploy/dev/secrets/`,不入版控)、建置並啟動:

| 服務 | 內容 |
| --- | --- |
| `nginx` | `:80` 轉址、`:443`(SPA + `/api` + `/ws` + `/webhook`)、`:9443`(Agent mTLS + gRPC) |
| `bff-1`、`bff-2` | BFF ×2,共用 Redis 與 SQL Server |
| `redis` | Redis 7(本機 `127.0.0.1:16379`) |
| `mssql` + `mssql-init` | SQL Server 2022:`giganexus_gw`、`giganexus_gw_test`、`LOS`、`PortalSolar`(相容層級 110)、`BPM`(150)+ 模擬資料 |
| `mock-ad` | 模擬 AD 三網域 gsc / gsmc / ygdmc(巢狀群組、AD 錯誤碼) |
| `mock-mes` / `mock-hrm` / `mock-bpm` / `mock-portal` / `mock-endpoint` | 模擬下游後端(port 51210 / 51220 / 51250 / 51270 / 51240–51241),以 JWKS 驗證 `X-Internal-Token` |
| `gw-migrate` / `gw-setup` | migration + seed;以 CLI 從各模擬後端的 OpenAPI 匯入路由並發佈 |
| `spa-portal` / `spa-mes` | 範例 SPA 發佈到 `gw_www`(symlink 原子切換) |

- 開啟 `https://localhost/`(開發用根憑證 `deploy/dev/secrets/pki/ca.crt`,可匯入瀏覽器)
- 測試帳號(密碼皆為 `Passw0rd!`,虛構資料):`S112009`(碩禾 AD,MES 作業員)、`S100001`(IT 管理)、`Y110001`(鹽城碩禾,無 MES 權限)、`S112030`(只在新網域 gsmc);本機帳號 `V112001` 以 CLI 代建:`docker compose ... exec bff-1 node dist/bff/src/cli/index.js local:create --emp V112001`
- 停止:`sh deploy/dev/down.sh`(加 `-v` 清除資料)

前端開發也可依 FRONTEND-GUIDE §8 以 Vite proxy 連 Gateway:`cd tools/sample-spa && npx vite -c vite.portal.config.ts`。

## 測試

```bash
cd bff
npm test            # 單元測試
npm run test:int    # 整合測試(Drizzle PoC;自動重建 giganexus_gw_test)
npm run test:e2e    # 經 Nginx 的端到端測試(需先 deploy/dev/up.sh)
```

E2E 測試對應 `docs/Gherkin` 的 nginx-entry、agent-mtls、ad-login、local-account、token-session、permission、dynamic-routing、release-publish 場景。

### 容器 ≠ SQL Server 2012

官方容器映像最早為 2017,相容層級 110 只擋得住少數新語法(IMPL-PLAN §6),另有兩道防線:

1. `npm run db:check-2012`:靜態檢查 migration 是否含 2016+ 語法。
2. `SQL2012_GUARD=error`:開發 / 測試時,Drizzle 產生的每一句 SQL 都經同一套規則檢查,違規即丟例外。

M0 Go / No-Go 仍需以整合測試對**真正的 SQL Server 2012 測試庫**(P-04)複驗。

## 目前進度

| 項目 | 狀態 |
| --- | --- |
| W3-1 骨架、schema、migration、seed、Drizzle PoC | 完成(容器預驗,待 2012 複驗) |
| W3-2 Nginx 入口:TLS、SPA、`/api`、WebSocket、`auth_request`、Webhook 白名單、JSON 錯誤、限流 | 完成 |
| W3-3 Agent `:9443` mTLS + gRPC、CRL、簽發者限制 | 完成(見下方注意事項) |
| W3-4 AD 多網域登入、本機帳號、JWT Cookie、Refresh Rotation、CSRF、RBAC、內部 Token / JWKS、登入補查 BPM / LOS、IT 代建 | 完成 |
| W3-4.6b 人員排程同步 Worker、W3-4.16 舊單一入口遷移 | 未開始(後者需 P-15 測試帳號) |
| W3-5 動態路由、聚合、限流、快取、斷路器、發佈 / 回滾 / 補償、CLI 匯入 | 完成 |
| W3-5.8 通知 Worker、W3-5.8a/b 自行註冊與忘記密碼、W3-5.10 Webhook 驗簽 | 未開始(`/ws/notify` 連線已可用) |

注意事項:

- Nginx `ssl_verify_client on` 對無效 / 無憑證的 Agent 會完成 TLS 握手後在 HTTP 層回 400(不會到達 Endpoint Server),而非 TLS 層中斷;與 IMPL-PLAN W3-3 驗收字面「TLS 層被拒」不同,需確認是否可接受。
- 斷路器狀態由各 BFF 實例在記憶體中維護(DATABASE.md §6 列有 `gw:cb:{upstream}`,目前未使用)。
- 權限對應變更時 CLI 以全體使用者遞增 `perm_version`(DATABASE.md §7.2 為「受影響使用者」);管理 API(P2-3)時改為精準遞增。
- `.gitlab-ci.yml`、`ci-templates/spa-deploy.yml`、`deploy/docker-compose.test|prod.yml` 尚未在實際 Runner / 主機上執行過。
