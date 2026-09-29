# GigaNexus Gateway — 技術棧與部署

> 本文件自 [PRD.md](PRD.md) §11 拆出,為該主題的唯一維護來源;PRD 僅保留摘要與連結。
> 對應 PRD 版本:**v0.5**(2026-09-25)。

---

## 1. 技術棧

| 層級 | 技術 | 用途 |
| --- | --- | --- |
| 反向代理 | **Nginx 1.26+**(stable,含 `http_v2`、`grpc`、`auth_request`、`ssl`) | 入口、TLS、mTLS、gRPC |
| BFF 執行環境 | **Node.js 22 LTS** + **TypeScript** | |
| Web 框架 | **Fastify 5** | 高效能、plugin 架構、JSON Schema 驗證 |
| 主要套件 | `@fastify/cookie`、`@fastify/websocket`、`@fastify/multipart`、`@fastify/swagger`、`undici`(上游連線池)、`jose`(JWT/JWKS)、`ldapts`(AD,多網域)、`@node-rs/argon2`(本機帳號密碼雜湊)、純 JS DES 實作(舊單一入口密碼比對,不啟用 OpenSSL legacy provider)、`drizzle-orm` + `mssql`(tedious 驅動)、`ioredis`、`bullmq`、`nodemailer`、`pino`(日誌)、`prom-client`(指標)、`zod` 或 TypeBox(型別/驗證) | |
| 資料庫 | **SQL Server 2012 Standard**(公司現有主機,`11.00.2100` = 2012 RTM);獨立資料庫 `giganexus_gw`、schema `gw` | 設定、權限、稽核;相容性限制見 [DATABASE.md](DATABASE.md) §0 |
| 外部人員資料(唯讀) | **BPM:SQL Server 2019 Standard**(另一台主機,加密連線);**LOS:`[LOS].[dbo].[EmployeeInfo]`**(SQL Server 2012 同主機) | 部門、職稱、主管等人事資料;BPM 為主、LOS 補充,見 [DATABASE.md](DATABASE.md) §8 |
| ORM / Migration | **Drizzle ORM**(MSSQL dialect)+ **drizzle-kit** | 型別安全的查詢、schema 定義、migration 產生;與 Redis 的同步規則見 [DATABASE.md](DATABASE.md) §7 |
| 快取 / 佇列 | **Redis 7** | 路由快照、Session、限流、佇列 |
| 測試 | Vitest + Testcontainers(Redis)、k6(壓測);資料庫整合測試連**專用的 SQL Server 2012 測試庫**(官方容器映像最早只有 2017,無法代表 2012 的行為);人員同步以 BPM / LOS 唯讀 view 的測試資料驗證 | |
| 部署 | Docker Compose(Linux 容器);Windows 主機用 **Docker Desktop**、GitLab 主機(Ubuntu)用 Docker Engine;GitLab CI/CD + Runner + Container Registry(`:5050`) | `develop` 自動部署測試區、`main` 手動部署正式區,見 [DEPLOYMENT.md](DEPLOYMENT.md) |

## 2. 專案結構(預計)

```
giga-api-gateway-bff/
├─ docs/                 PRD.md、ARCHITECTURE.md、DATABASE.md、TECH-STACK.md、IMPL-PLAN.md、FRONTEND-GUIDE.md、BACKEND-GUIDE.md、DEPLOYMENT.md、REFERENCES.md、Gherkin/*.feature
├─ nginx/
│  ├─ nginx.conf
│  ├─ conf.d/portal.conf       # 443:SPA、/api、/ws、/webhook
│  ├─ conf.d/agent.conf        # 9443 Agent 專用:mTLS + grpc_pass
│  └─ snippets/                # ssl、security-headers、proxy-common
├─ bff/
│  ├─ src/
│  │  ├─ db/
│  │  │  ├─ schema/            # Drizzle schema(gw.* 資料表定義)
│  │  │  ├─ external/          # BPM / LOS 唯讀 schema(不產生 migration)
│  │  │  ├─ sync/              # SQL Server → Redis 同步(快照發佈、補償、權限快取)
│  │  │  └─ client.ts          # 連線池:giganexus_gw(讀寫)、LOS / BPM / PortalSolar(唯讀)
│  │  ├─ plugins/              # db、redis、auth、rbac、metrics
│  │  ├─ modules/auth|rbac|router|admin|notify|webhook|health
│  │  ├─ cli/                  # 管理 CLI(W3-5.7 OpenAPI 匯入 / 發佈 / 回滾、W3-4.15 IT 代建)
│  │  ├─ workers/notify.worker.ts
│  │  ├─ workers/employee-sync.worker.ts   # BPM + LOS → gw.user
│  │  └─ server.ts
│  └─ test/
├─ web-kit/                   # 前端共用套件 @giganexus/web-kit(見 FRONTEND-GUIDE.md §6)
├─ sdk/node/                  # 下游後端共用套件 @giganexus/backend-sdk:部署區設定、Token 驗證、自動註冊、路由查詢(見 BACKEND-GUIDE.md §7.5)
├─ samples/node-backend/      # Node.js 下游後端樣本(Fastify)與 AI 協作準則 AGENT.md
├─ ci-templates/               # 前端 SPA 部署用 GitLab CI 片段(見 FRONTEND-GUIDE.md §9)
├─ db/migrations/              # drizzle-kit 產生、人工審查後的 SQL(版本化)
├─ db/seed/                    # 內建角色、權限、預設政策(Drizzle seed 腳本)
├─ drizzle.config.ts
├─ deploy/                     # docker-compose.yml(共用)+ .test.yml / .prod.yml(見 DEPLOYMENT.md §5)
│  └─ dev/                     # 本機完整環境(docker-compose.dev.yml):模擬資料庫初始化、開發用憑證產生、路由設定
├─ tools/                      # 測試用:mock-ad(模擬 AD)、mock-upstream(模擬下游後端 / Endpoint gRPC)、sample-spa(範例 SPA)
└─ .gitlab-ci.yml
```

## 3. 部署拓樸

- 測試區(主機 2)、正式區(主機 3)各一套 `nginx + bff ×2 + worker(通知 + 人員同步)+ redis`;SQL Server 使用既有主機,測試區與正式區各一個 `giganexus_gw` 資料庫(可為同主機上不同名稱,如 `giganexus_gw_test`)。
- **以主機 IP 對外**(內部無 DNS,PRD Q1):Nginx 開 `:80`(轉址)、`:443`(瀏覽器與系統)、`:9443`(Agent 專用);伺服器憑證 SAN 帶 IP。
- BFF 無狀態,可水平擴充;Nginx upstream 以 `keepalive` 連 BFF。
- Secrets(各 AD 網域的 LDAP 服務帳號、JWT 私鑰、SMTP、DB 連線字串)以 Docker secrets / 受保護的 CI 變數注入,**不入版控**。
- 主機 2(測試區)、主機 3(正式區)為 Windows + Docker Desktop,各有 GitLab Runner;主機 1(Ubuntu)為 GitLab 與 Container Registry。
- Nginx 設定在 CI 以 `nginx -t` 檢查通過才建置映像檔;部署時重建 Nginx 容器(正式區安排離峰)。
- 資料庫 migration 在部署時以一次性容器執行(`docker compose run --rm migrate`),失敗即中止部署;正式區需手動核可。
- 完整流程、各元件部署與回滾、Docker Desktop 設定見 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 4. 資料庫與 ORM 注意事項

| 項目 | 說明 | 處理方式 |
| --- | --- | --- |
| Drizzle MSSQL 支援仍為 Beta | Drizzle 對 MSSQL 的支援目前在 v1 Beta / RC 階段(`drizzle-orm@rc`、`drizzle-kit@rc`),官方文件**未載明最低支援的 SQL Server 版本** | W3-1 以 SQL Server 2012 做 PoC:schema 定義、CRUD、交易、`OFFSET … FETCH` 分頁、`ROWVERSION` 樂觀鎖、drizzle-kit generate / migrate;`package.json` **鎖定確切版本**,升版須重跑 PoC。**備案(已決定,依序)**:① PoC 未通過改用 **Kysely**(MSSQL 方言,同為 tedious 驅動),migration 改為手寫 SQL;② Kysely 也無法在 2012 上使用時,**走第三條路:沿用 GeneralBackend 已在 2012 正式環境驗證的 Sequelize 6 + mssql/tedious**(連線設定見 [REFERENCES.md](REFERENCES.md) §1.1),migration 以 Umzug 執行手寫 SQL。因同步邏輯集中在 `db/sync/`、查詢集中在各模組 repository,替換範圍可控 |
| TLS 1.2 不相容 | SQL Server 2012 RTM 不支援 TLS 1.2;Node.js 22 預設最低 TLS 1.2,加密連線會握手失敗 | **已決定:內網不加密**(`encrypt: false`),已取得主管與工程師同意,2026-09-24。補償控制:① 主機防火牆僅允許 BFF / worker 主機連 1433;② BFF 使用專屬 SQL 登入帳號,只授權 `giganexus_gw`,稽核表僅 INSERT/SELECT;③ 帳密存 Docker secret 並定期更換;④ 敏感值(API Key、Refresh Token)在資料庫只存雜湊。日後 DBA 升級至 SP4 以上時改回 `encrypt: true` |
| 產品已停止支援 | SQL Server 2012 延伸支援已於 2022-07-12 結束,不再有安全性更新 | 列入 PRD 風險;`gw` 資料表只使用 2012 支援的功能(見 [DATABASE.md](DATABASE.md) §0),未來升級 SQL Server 時可直接遷移 |
| 連線池 | Drizzle 使用 `mssql` 連線池;共連 4 個資料庫(`giganexus_gw`、LOS、BPM、PortalSolar) | `giganexus_gw`:每個 BFF 實例 max 10;LOS / BPM / PortalSolar:每實例 max 3(只供登入補查與舊帳號遷移),worker 另設。`/readyz` 只檢查 `giganexus_gw`,LOS / BPM 停機不影響服務就緒,只發告警 |
| 已驗證的參考實作 | GeneralBackend 已在正式環境以 tedious + `encrypt: false` 連線 SQL Server 2012、以 mssql 查詢 BPM | PoC 以其連線參數為基準;不沿用其每次請求建立連線的寫法(見 [REFERENCES.md](REFERENCES.md) §1.4) |
| 外部資料庫帳號 | LOS、BPM、PortalSolar 由其他系統擁有 | 各申請一個**唯讀**登入帳號,只授權指定 view / 表;BPM 連線 `encrypt: true`;兩者皆存 Docker secret |

### 4.1 Drizzle PoC 紀錄(W3-1.1)

> 測試程式:`bff/test/integration/poc-drizzle.test.ts`(對應 [IMPL-PLAN.md](IMPL-PLAN.md) §4.1 檢查表);版本鎖定 `drizzle-orm` / `drizzle-kit` `1.0.0-rc.4`、`mssql` `11.0.2`(tedious 18,與 GeneralBackend 同一主版本;drizzle 的 peer 要求 `mssql@^11`)。

**2026-09-24 本機預驗**:SQL Server 2022 容器、資料庫相容層級 110,所有執行期 SQL 經 2012 語法檢查(`SQL2012_GUARD=error`)。**非 M0 判定依據**,M0 需對 SQL Server 2012 RTM 測試庫(P-04)重跑同一組測試。

| # | 檢查項目 | 本機預驗 | 備註 |
| --- | --- | --- | --- |
| 1 | `mssql`(`encrypt: false`)連線 | 通過 | |
| 2 | INT IDENTITY、DATETIME2(3)、NVARCHAR(MAX)、UNIQUEIDENTIFIER、ROWVERSION | 通過 | Drizzle 無 ROWVERSION / UNIQUEIDENTIFIER 內建型別,以 `customType` 定義;INSERT 時 ROWVERSION 欄位送 `default` 可正常執行 |
| 3 | `drizzle-kit generate` 的 SQL 可在 2012 執行 | 通過(需手動調整) | ① drizzle-kit 先建 FK 再建唯一索引,參照非主鍵唯一欄位(`permission.code`)的 FK 會失敗 → 調整為「資料表 → 索引 → FK」;② 叢集索引設定無法以 schema 表達 → 稽核表手動改;③ 產出 SQL 未含 2016+ 語法 |
| 4 | 篩選唯一索引 | 通過 | `uniqueIndex().on(...).where(sql\`...\`)` 可直接定義 |
| 5 | CRUD、交易回滾、巢狀交易(savepoint) | 通過 | |
| 6 | `OFFSET … FETCH`、`TOP` | 通過 | API 為 `.orderBy().offset(n).fetch(m)`、`.select().top(n).from()` |
| 7 | ROWVERSION 樂觀鎖 | 通過 | UPDATE 需用 `.output({ inserted: { rowVer } })` 取回新版本;衝突時回傳 0 筆 |
| 8 | migration 可重複執行、記錄已套用版本 | 通過 | 紀錄表在 schema `drizzle`(`gw_app` 無權讀取),整批 migration 在單一交易內執行 |
| 9 | 100 並行查詢(pool max 10) | 通過 | |
| 10 | 同一程式查詢 BPM(`encrypt: true`)與 LOS / PortalSolar(`encrypt: false`)唯讀 view | 通過 | 本機 BPM 為同一容器、自簽憑證(`trustServerCertificate: true`) |
