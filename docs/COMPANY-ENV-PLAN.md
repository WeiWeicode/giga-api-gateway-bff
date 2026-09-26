# 上公司環境調整清單

> 目前程式在開發主機以 Docker 模擬環境(模擬 AD、模擬下游後端、SQL Server 2022 容器與模擬資料、範例網頁)開發與測試。
> 本文件列出部署到公司**測試區(主機 2)/ 正式區(主機 3)**時需要修改或補齊的檔案與設定。
> 前置工作編號(P-xx)見 [IMPL-PLAN.md](IMPL-PLAN.md) §3;部署流程見 [DEPLOYMENT.md](DEPLOYMENT.md)。
> **CI / Registry / AD CS 憑證尚未就緒時,測試區依 [TEST-DEPLOY-RUNBOOK.md](TEST-DEPLOY-RUNBOOK.md) 在主機 2 手動架設**(含臨時自簽憑證、主機上建置映像、Gateway → 員工入口網 → IT 管理系統的部署順序)。

---

## 交接:從開發主機移到公司(2026-09-25)

家中開發主機的開發到 2026-09-25 為止,之後在公司環境繼續。

**版控狀態**:交接以 `origin/main`(GitHub `WeiWeicode/giga-api-gateway-bff`)為準;離開開發主機前確認 `git status` 乾淨且已 push。公司端 clone 可取得 `bff/`、`nginx/`、`db/`、`deploy/`(共用與 test / prod)、`web-kit/`、`sdk/node/`、`samples/node-backend/`、`ci-templates/`、`docs/`。

| 項目 | 說明 |
| --- | --- |
| 公司 GitLab(主機 1) | 將 repo 推到公司 GitLab,`.gitlab-ci.yml` 在那裡執行(DEPLOYMENT.md);GitHub 遠端是否保留、是否為私有,**請主管確認**(文件含 AD 網域、主機規劃、人事欄位等內部資訊) |
| 本機測試環境(§0,不在版控) | 公司開發機若要繼續跑 E2E、IT 管理 demo(`/it/` 上架演練),需**手動帶過去**;不要帶 `deploy/dev/secrets/`(`up.sh` 會重新產生):<br>`tar --exclude node_modules --exclude dist --exclude deploy/dev/secrets -czf gw-local-env.tgz tools deploy/dev deploy/docker-compose.dev.yml deploy/dev.env` |
| 公司開發機第一天 | Node.js 22+、Docker;`cd bff && npm ci && npm run lint && npm run typecheck && npm test`(62 項);`cd samples/node-backend && npm install && npm test`(9 項,會一併建置 `sdk/node`);有帶本機環境時 `sh deploy/dev/up.sh` 後 `npm run test:e2e`(家中最後結果 124 項全部通過) |
| npm 套件來源 | 公司網路若需經 proxy 或內部 npm registry,設定 `.npmrc`(不入版控) |

**2026-09-26 補充**:兄弟專案 `../giga-Portal`(員工入口網,提供 `/`、`/login`、`/register`、`/reset-password`)M1 前端完成,**取代範例入口網,是公司環境唯一的登入頁**,必須在 Gateway 之後部署(TEST-DEPLOY-RUNBOOK 步驟 7),其權限代碼以 `../giga-Portal/deploy/gateway-rbac.yaml` 套用;`../GigaItApp` 頂列已有應用切換。家中最後測試:BFF 單元 69 項、樣本 13 項、GigaItApp 後端 46 項、giga-Portal 前端 29 項、watchdog 20 項皆通過。

交接時的狀態:W3-1 ~ W3-5(不含 §7 未實作項目)與 W3-5.7a(後端自動註冊、路由查詢、Node.js SDK 與樣本)完成;所有資料庫相關驗證只在容器 SQL Server 2022(相容層級 110)執行過,**尚未在 SQL Server 2012 複驗**(§1 M0)。

---

## 0. 不進版控的本機測試環境

以下只存在開發主機(`.gitignore`),公司環境不使用,也不需部署:

| 路徑 | 內容 |
| --- | --- |
| `tools/mock-ad/` | 模擬 AD 三網域 |
| `tools/mock-upstream/` | 模擬下游後端(go-mes、core-hrm、bpm-adapter、portal-svc、Endpoint Server);每支 API 已附 `description` 與 `x-gherkin` |
| `tools/sample-spa/` | 範例網頁:入口網、MES 看板、IT 管理 demo(架構總覽、資料表說明、API 上架演練 8 步驟含「查詢既有路由」)。**入口網(含登入頁)已由 `../giga-Portal` 取代**,公司環境不需要範例入口網 |
| `deploy/dev/` | 模擬資料庫初始化與測試資料(`mssql-init/`)、開發用憑證與密碼(`secrets/`)、本機路由與角色設定(`config/`,聚合 / mock 路由含說明與 Gherkin)、`up.sh` / `down.sh` |
| `deploy/docker-compose.dev.yml`、`deploy/dev.env` | 本機完整環境 |

受影響的項目:

- `bff/test/e2e/` 依賴上述本機環境,只能在開發主機執行;CI 只跑單元測試。
- `/it/` 已改由 GigaItApp 專案(自有登入,後端 `itapp-api:51291`,Nginx `ITAPP_API_UPSTREAM`)發佈,取代 `tools/sample-spa/it` demo;上測試區 / 正式區時需部署 itapp-api 並設定 `ITAPP_API_UPSTREAM`,其 BFF 串接目前用到 dev / test 才有的 `/api/admin/demo/*`、`/api/admin/db/*`(見 GigaItApp README「目前限制」)。原 IT 管理 demo 在 `tools/sample-spa/`,**不會隨 CI 部署**;若要在測試區提供給 IT 新人使用,需先移入版控並加入 SPA 部署流程(demo API 見 §6)。
- `samples/node-backend/`、`sdk/node/` **在版控內**,但不屬於 Gateway 部署物;樣本以 `file:../../sdk/node` 連結 SDK(`postinstall` 建置),複製成獨立專案時改用公司 npm registry 的版本(§5)。
- `.gitlab-ci.yml` 的 `check:nginx` 使用 `deploy/dev/gen-dev-secrets.sh` 產生憑證,**進版控後會找不到檔案**,需改為在 CI 內直接以 openssl 產生一次性自簽憑證(見 §4)。
- `deploy/dev/mssql-init/01-giganexus_gw.sql`(建立資料庫、登入帳號、`gw_app_role` 權限)是交給 DBA 的腳本草稿;若要提交 DBA,需另外複製到版控內(例如 `db/dba/`)並移除 `$(變數)` 以外的開發預設密碼。

---

## 1. 資料庫(SQL Server 2012 / BPM 2019)

| 檔案 / 項目 | 需要調整 | 依賴 |
| --- | --- | --- |
| DBA 建立 `giganexus_gw`、`giganexus_gw_test`、schema `gw`、`gw_app` / `gw_migrate` 帳號、`gw_app_role` | 參考 `deploy/dev/mssql-init/01-giganexus_gw.sql`(本機);定序請 DBA 確認(本機假設 `Chinese_Taiwan_Stroke_CI_AS`) | P-01 |
| **M0:Drizzle × SQL Server 2012 複驗** | `bff/.env` 指向公司 2012 測試庫(`GW_DB_HOST`、`GW_TEST_DB_NAME`)後執行 `npm run test:int`,結果記錄於 [TECH-STACK.md](TECH-STACK.md) §4.1 | P-04 |
| migration 套用 | 三個 migration(`20260924114259_init`、`20260925021314_api_route_gherkin`:`gw.api_route.gherkin NVARCHAR(MAX)`、`20260926011642_upstream_project`:`gw.upstream.project VARCHAR(100)`)需在 2012 測試庫以 `npm run db:migrate` 實際套用一次;目前只在容器驗證 | P-04 |
| `bff/src/db/external/bpm.ts` | 欄位依 BPM 負責人實際提供的唯讀 view 調整(目前依本機模擬 view `dbo.vw_gn_employee`) | P-12 |
| `bff/src/db/external/los.ts` | 欄位與型別依 DBA 提供的 LOS view 調整;確認日期欄位確實為 `d/M/yyyy` 字串 | P-12 |
| `bff/src/db/external/portal.ts` | 依 DBA 提供的 `LoginData` 唯讀 view 調整(舊帳號遷移 W3-4.16 尚未實作) | P-15 |
| `db/seed/data.mts` | `gw-it-admin` 權限範圍、預設限流數值為暫定,需 IT 主管確認;公司與 AD 網域對應(碩禾 → gsc、gsmc;鹽城碩禾 → ygdmc);新權限 `gw.admin.route.register`(後端 API Key 專用)也會給兩個管理員角色,不影響安全(註冊端點只接受 API Key) | P-08 |
| 稽核表保存排程(SQL Agent) | 尚未撰寫(W3-1.6) | — |

---

## 2. 機密(主機受保護目錄 `GW_SECRETS_DIR`,不入版控)

| 檔案 | 內容 | 依賴 |
| --- | --- | --- |
| `gw_db_password`、`gw_migrate_password` | `giganexus_gw` 的 BFF 與 migration 帳號密碼 | P-01 |
| `los_db_password`、`bpm_db_password`、`portal_db_password` | 唯讀帳號密碼 | P-12、P-15 |
| `ldap_gsc_password`、`ldap_gsmc_password`、`ldap_ygdmc_password` | 三個 AD 網域的查詢服務帳號密碼 | P-07 |
| `jwt/<kid>.pem` | ES256(P-256)私鑰,**測試區與正式區各自產生**;檔名即 `kid`,排序最後者為簽章用 | — |
| `pki/server.crt`、`pki/server.key` | AD CS 簽發,SAN 含 Gateway **IP**;到位前以 `deploy/gen-temp-pki.sh` 產生臨時自簽憑證(含臨時 Agent CA / CRL 讓 Nginx 能啟動) | P-05 |
| `pki/agent-ca-chain.pem`、`pki/agent.crl` | Agent 專用中繼 CA + 根 CA、CRL(需定期更新,W3-3.4) | P-06 |
| `pki/ca.crt` | 企業根 CA(Nginx 以 grpcs 連 Endpoint Server 時驗證用) | P-05 |

產生 JWT 金鑰:`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out <kid>.pem`

---

## 3. 部署設定

| 檔案 | 需要調整 | 依賴 |
| --- | --- | --- |
| `deploy/test.env.example`、`deploy/prod.env.example` | 複製到主機受保護目錄並填入:Registry、`GW_SECRETS_DIR`、`GW_CONFIG_DIR`、SQL Server / BPM 主機、`ENDPOINT_*_UPSTREAM`、`INTERNAL_NETWORKS`(公司內網網段,「記住我」用) | P-11 |
| `${GW_CONFIG_DIR}/ldap-domains.json` | 三個網域的 `url`(過渡期 `ldap://<DC>:389`,Q12)、`baseDN`、`bindDN`、`netbios`、`upnSuffix`;格式見 [TEST-DEPLOY-RUNBOOK.md](TEST-DEPLOY-RUNBOOK.md) 步驟 3(本機的 `deploy/dev/config/` 不在版控)。列出的每個網域都必須有對應的 `ldap_<代碼>_password`,否則 BFF 啟動失敗 | P-07 |
| 角色與 AD 群組對應 | 本機以 `deploy/dev/config/gateway-routes.yaml` 套用;公司需依 IT 規劃的 `GN-*` 群組 DN 另寫一份(DN 含逗號須用區塊清單加引號),以 `gw apply` 套用。**測試區與正式區設定不互通(PRD Q3),兩區各自套用**;聚合 / mock 路由可附 `description`、`gherkin`(mock 路由只在 dev / test 生效,PRD §8.4.1) | P-08 |
| `deploy/docker-compose.test.yml`、`.prod.yml` | 目前只有 `GW_ENV` 與 log level;依主機需要補充(例如 port 衝突時改 `GW_HTTP_PORT` 等) | P-11 |
| 下游後端 API Key | 每個後端服務在測試區、正式區各建一把(`gw client:create --code <服務代碼> [--ips <主機網段>]`),明文交給該服務存入 Docker secret(`GW_API_KEY_FILE`);後端的 `GW_BASE_URL` 指向該區 Gateway,且主機網段需列入 `internal-services.conf`(取 JWKS)(BACKEND-GUIDE §7.5) | P-16 |
| 下游後端信任 Gateway 憑證 | Gateway 憑證由 AD CS 簽發(P-05);Node.js 後端以 `NODE_EXTRA_CA_CERTS` 指向企業根 CA,否則自動註冊與取 JWKS 會因憑證驗證失敗(本機以開發用根憑證 `deploy/dev/secrets/pki/ca.crt` 驗證過) | P-05 |
| Windows 主機 | `GW_SECRETS_DIR` 等路徑使用 Windows 路徑;確認 80 / 443 / 9443 未被佔用;Docker Desktop 開機自動啟動 | P-11、P-17 |
| **Windows 主機:來源 IP 驗證** | 本機 Docker Desktop 的 Nginx 看到的來源一律是 `192.168.65.1`。**部署前**依 [DEPLOYMENT.md](DEPLOYMENT.md) §6.1 在主機 2、3 以一次性容器(`-p 18080:80`)從另一台電腦連入,檢查 log 的 `remote_addr`;若遺失,Nginx 的 IP 限流(`gw_ip`、`gw_auth`)、`webhook-bpm.conf` / `internal-services.conf` 白名單、BFF「記住我」內網判定(`INTERNAL_NETWORKS`)與登入失敗 IP 計數都會失效(PRD §14.1),需依 PRD Q26 改變執行方式。結果確定前不修改這些設定(Agent `limit_conn` 已改以裝置憑證計算,不受影響) | P-11、P-17 |

---

## 4. Nginx

| 檔案 | 需要調整 | 依賴 |
| --- | --- | --- |
| `nginx/allowlists/test\|prod/webhook-bpm.conf` | 填入 BPM 主機 IP(目前為 TODO,等同全部拒絕) | P-14 |
| `nginx/allowlists/test\|prod/internal-services.conf` | 下游後端與監控主機網段(可取 JWKS、`/readyz`) | P-16 |
| `nginx/allowlists/test\|prod/agent-issuers.conf` | AD CS「GigaNexus Agent」中繼 CA 的 Subject DN(`openssl x509 -noout -subject -nameopt RFC2253`,RDN 順序須完全一致) | P-06 |
| `nginx/conf.d/portal.conf` | `stub_status` 的 `allow` 網段改為監控主機;新系統上線時登記 SPA 子路徑 | — |
| `.gitlab-ci.yml` `check:nginx` | 改為 CI 內以 openssl 產生一次性自簽憑證,不再呼叫 `deploy/dev/gen-dev-secrets.sh` | — |

---

## 5. CI/CD

| 檔案 | 需要調整 |
| --- | --- |
| `.gitlab-ci.yml` | **尚未在實際 Runner 上執行過**。確認 Runner 執行器(Windows shell 無 `sh` 時需 docker executor 或 Git Bash)、tag(`windows-runner`、`prod-deploy` Protected)、Registry 位址;`deploy-*` 需要主機上的 `<區域>.env` 路徑變數 `GW_DEPLOY_DIR` |
| `ci-templates/spa-deploy.yml` | 同上;`GW_WWW_VOLUME` 需與實際 Compose 專案名稱一致(`giganexus-gw_gw_www`) |
| `deploy/wait-healthy.sh`、`deploy/smoke-test.sh` | 在 Windows Runner 上的執行方式 |
| `sdk/node/`、`samples/node-backend/` | 目前 CI 不檢查;建議新增 job:SDK `npm ci && npm run typecheck`、樣本 `npm install && npm test`。SDK 需發佈到公司 npm registry(例:GitLab Package Registry,`@giganexus` scope)供各後端專案安裝,發佈方式待定 |

---

## 6. 程式行為需確認

| 項目 | 說明 |
| --- | --- |
| `bff/src/modules/admin/db-viewer.ts`、`onboarding.ts`(IT 管理 demo 的資料庫檢視、上架演練預覽 API) | 在 `GW_ENV` 不是 `prod` 時註冊,測試區也會開啟(測試區以唯讀帳號讀取正式人事資料,DEPLOYMENT.md §5.1)。**2026-09-26 需求方決定:測試區保留(GigaItApp live 讀取需要)、正式區關閉**,維持現行程式 |
| 自動註冊與發佈 | `POST /api/admin/registrations` 在正式區也開放(PRD v0.5);CLI `publish` 會**一併發佈所有草稿**,含其他服務剛自動註冊的草稿。正式區發佈前務必檢視差異,發佈流程由 IT 確認 |
| Agent 無效憑證 | Nginx 於 TLS 握手後回 HTTP 400(不會到達 Endpoint Server),與 IMPL-PLAN W3-3 驗收字面「TLS 層被拒」不同,需確認 |
| 斷路器 | 各 BFF 實例於記憶體維護,未使用 `gw:cb:*` |
| CLI 權限變更 | 以全體使用者遞增 `perm_version`,管理 API(P2-3)時改為只遞增受影響者 |

---

## 7. 尚未實作(上線前需完成)

| 工作項目 | 依賴 |
| --- | --- |
| W3-4.6b 人員排程同步 Worker | P-12 |
| W3-4.16 舊單一入口帳號遷移(DES 比對、`gw:pwchg` 流程已完成) | P-15 |
| W3-5.8 通知 Worker(Email + 站內)、W3-5.8a/b 自行註冊與忘記密碼 | P-09 |
| W3-5.10 Webhook 驗簽 | — |
| W3-1.6 稽核表保存排程、W3-2.8 nginx-prometheus-exporter、W3-3.4 CRL 更新排程 | — |
| P2-5 路由的 `api_key` 驗證模式、API Key 管理 API(目前 API Key 只用於自動註冊與路由查詢,以 CLI `client:create` / `client:disable` 管理) | — |
