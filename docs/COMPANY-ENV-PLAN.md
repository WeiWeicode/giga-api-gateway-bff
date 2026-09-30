# 上公司環境調整清單

> 目前程式在開發主機以 Docker 模擬環境(模擬 AD、模擬下游後端、SQL Server 2022 容器與模擬資料、範例網頁)開發與測試。
> 本文件列出部署到公司**測試區(主機 2)/ 正式區(主機 3)**時需要修改或補齊的檔案與設定。
> 前置工作編號(P-xx)見 [IMPL-PLAN.md](IMPL-PLAN.md) §3;部署流程見 [DEPLOYMENT.md](DEPLOYMENT.md)。
> **CI / Registry / AD CS 憑證尚未就緒時,測試區依 [TEST-DEPLOY-RUNBOOK.md](TEST-DEPLOY-RUNBOOK.md) 在主機 2 手動架設**(含臨時自簽憑證、主機上建置映像、Gateway → 員工入口網 → IT 管理系統的部署順序)。
> **GitLab(主機 1)與 Runner(主機 2)的架設步驟見 [GITLAB-SETUP.md](GITLAB-SETUP.md)。**

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

**2026-09-29 公司開發機**:公司端只取得版控內容,本機測試環境(§0)**沒有帶過來**,E2E 與模擬資料無法在公司執行。已調整:`.gitlab-ci.yml` `check:nginx` 改用 `deploy/gen-temp-pki.sh`(§4);`bff/.env.example` 改為直接連公司 SQL Server 2012 測試庫(§1 M0);env 範本、樣本 `.env.example`、CI 範本不再指向 `deploy/dev/`、`tools/`。repo 資料夾名稱必須是 `giga-api-gateway-bff`(AGENT.md §10.1),giga-Portal 建置與 GigaItApp compose 依此路徑取 web-kit 與憑證。

**Windows 電腦注意(2026-09-29)**:家中開發主機不是 Windows,以下兩項在公司才出現,已修正:
- Git for Windows 預設 `core.autocrlf=true`,檢出的檔案變成 CRLF:`.sh` 掛進 Linux 容器(TEST-DEPLOY-RUNBOOK 步驟 4、CI `check:nginx`)會執行失敗,`npm run format:check` 也全數不符。新增 `.gitattributes`(`* text=auto eol=lf`)一律以 LF 檢出。**giga-Portal、GigaItApp 的 `.sh`(`publish.sh`、`gen-secrets.sh`、`apply-gateway-rbac.sh`)在公司電腦同樣是 CRLF,需各自加上相同設定**(§10.5,由各 repo 處理)。
- `npm run db:migrate`、`db:seed`、`db:reset-test` 以 `` import.meta.url === `file://${process.argv[1]}` `` 判斷直接執行,Windows 的路徑為 `D:\...` 永遠不相等,指令**不執行就以 0 結束**;已改為 `pathToFileURL(process.argv[1]).href`。Docker 容器內(Linux)不受影響。

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
- `.gitlab-ci.yml` 的 `check:nginx` 原本使用 `deploy/dev/gen-dev-secrets.sh` 產生憑證(公司端沒有此檔),2026-09-29 已改為 `deploy/gen-temp-pki.sh`(見 §4)。
- `deploy/dev/mssql-init/01-giganexus_gw.sql`(建立資料庫、登入帳號、`gw_app_role` 權限)是交給 DBA 的腳本草稿;若要提交 DBA,需另外複製到版控內(例如 `db/dba/`)並移除 `$(變數)` 以外的開發預設密碼。

---

## 1. 資料庫(SQL Server 2012 / BPM 2019)

### 1.0 環境與資料庫帳號(2026-09-30 建立)

SQL Server 2012 主機:`10.10.130.220`(`11.00.2100`,Navicat 連線名稱「開發平台」),以 sa 建立下列資料庫、schema(`gw`、`drizzle`)、登入帳號與 `gw_app_role`。密碼不記錄於版控。

| 環境 | 執行位置 | 資料庫 | BFF 帳號 / Migration 帳號 | 設定檔 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| 開發 | 開發者電腦 | `giganexus_gw_test` | `gw_app` / `gw_migrate` | `bff/.env`(不入版控) | 已建立 |
| 測試 | 主機 2(10.10.130.124,WSL) | `giganexus_gw_test`(與開發共用同一庫與帳號) | `gw_app` / `gw_migrate` | 主機 2 WSL `/srv/giganexus/deploy/test.env` + `secrets/`(見 §1.1) | 已建立 |
| 正式 | 主機 3 | `giganexus_gw` | `gw_prod_app` / `gw_prod_migrate`(與測試區分開) | 主機 3 `D:\giganexus\deploy\prod.env` + `GW_SECRETS_DIR` | 資料庫與帳號已建立;**主機 3 部署預計 2026-12 動工** |

**唯讀來源帳號(2026-09-30 建立並驗證,腳本 `db/dba/01-los-portal-readers.sql`、`02-bpm-reader.sql`;三環境共用)**

| 來源 | 主機 / 資料庫 | 帳號 | 只授權 SELECT | 驗證結果 |
| --- | --- | --- | --- | --- |
| LOS | `10.10.130.220` / `LOS`(2012,不加密) | `los_reader` | `dbo.vw_gn_employee` | 8,431 筆(兼任 2,003);`JobDate` / `LeaveDate` 實際為 `date`,view 以 `CONVERT(varchar(10), …, 103)` 轉字串後 BFF 解析全數成功 |
| BPM | `10.10.130.190` / `NaNa`(2019,加密;自簽憑證需 `BPM_DB_TRUST_SERVER_CERT=true`) | `bpm_reader` | `dbo.vw_gn_employee` | 7,259 筆(在職 1,133),無一人多筆 `isMain`;在職者 33 人查無主管,待 BPM 負責人確認 |
| 舊單一入口 | `10.10.130.220` / `PortalSolar`(2012,不加密) | `portal_reader` | `dbo.vw_gn_login_data` | 1,522 筆 |

三個帳號皆無法讀取基底資料表;以 BFF `lookupEmployee` / `mergeProfile` 實測 LOS 在職與離職各一人,`profile_source = bpm+los`、在職狀態判定正確。

- 開發與測試共用 `giganexus_gw_test`:開發機 `db:migrate` / `db:seed` 寫入的資料測試區看得到;`npm run test:int` 不可指向此庫(會清空 schema `gw`),需另建含 `_test` 的專用庫。
- 正式區(2026-12 動工時):
  - 主機 3 設定檔**檔名必須是 `prod.env`**(CI 以 `--env-file $GW_DEPLOY_DIR/$GW_ENV.env` 讀取),建議放 `D:\giganexus\deploy\prod.env`,GitLab 變數 `GW_DEPLOY_DIR` 指向該目錄;內容自 `deploy/prod.env.example` 複製,須設定 `GW_DB_USER=gw_prod_app`、`GW_MIGRATE_USER=gw_prod_migrate`(未設定時 compose 預設用測試區的 `gw_app` / `gw_migrate`)。
  - 密碼以檔案放 `D:\giganexus\secrets\`:`gw_db_password`(`gw_prod_app`)、`gw_migrate_password`(`gw_prod_migrate`),檔案內容只有密碼一行。
  - `ldap-domains.json` 放 `D:\giganexus\config\`(`GW_CONFIG_DIR`)。
  - migration 於正式區部署時由 migration 容器套用,建庫後不需手動執行。

### 1.1 測試區部署(主機 2,2026-09-30 經 CI 上架)

三個專案皆以 `develop` 分支自動部署(Runner `host2-test`,WSL shell executor):Gateway(`nginx`、`bff ×2`、`redis`、migrate + seed)→ giga-Portal(`/`、`/login`,套用 `gateway-rbac.yaml`)→ GigaItApp(`itapp-api`、`/it/`)。

| 主機 2 WSL 路徑 | 內容 | 建立方式 |
| --- | --- | --- |
| `/srv/giganexus/deploy/test.env`、`portal.env`、`itapp.env` | 非機密設定(範本:各 repo `deploy/test.env.example`) | Claude 經 SSH 建立 |
| `/srv/giganexus/deploy/config/ldap-domains.json` | 只有 `gsmc` | Claude |
| `/srv/giganexus/deploy/secrets/pki/`、`jwt/test-202609.pem` | 臨時自簽憑證(SAN 含 10.10.130.124,至 2029-01)與 JWT 金鑰;於主機上產生 | Claude(`gen-temp-pki.sh`) |
| `/srv/giganexus/deploy/secrets/*_password` | `gw_db`、`gw_migrate`、`los_db`、`bpm_db`、`portal_db`、`ldap_gsmc` 密碼 | **本人**:`sudo sh deploy/host2-set-secrets.sh`(隱藏輸入) |
| `/srv/giganexus/itapp-secrets/` | GigaItApp JWT 密鑰、種子帳號密碼(隨機產生,只在主機 2)、`bff_service_password`(mock 模式佔位) | Claude |
| `/srv/giganexus/shared/` | Gateway build 複製的 `web-kit/src`、`deploy/`,與已部署映像 tag `gateway-image-tag` | CI |

- Windows 端:`netsh portproxy` 0.0.0.0:80 / 443 → `::1`(WSL localhost 轉發),防火牆規則「GigaNexus Gateway 80/443」。來源 IP 經轉發後一律是主機本身(GITLAB-SETUP §3 已知限制,PRD Q26 未解決)。
- Docker volume `giganexus-gw_gw_www`、網路 `giganexus-gw_default` 預先建立(帶 compose 標籤),GigaItApp / Portal 可先於 Gateway 部署。
- GigaItApp 目前 `BFF_MODE=mock`:讀 BFF 的服務帳號尚未建立;建立後 `itapp.env` 改 `BFF_MODE=live`、`BFF_SERVICE_USER=<工號>`,密碼寫入 `itapp-secrets/bff_service_password`(uid 1000、400),再重跑 GigaItApp deploy-test。
- Pipeline 已知事項:`check:nginx` 以 root 容器產生的 `.ci-secrets` 必須改回 Runner 使用者擁有,否則之後所有 job 在 `git clean` 失敗(已修正)。

| 檔案 / 項目 | 需要調整 | 依賴 |
| --- | --- | --- |
| ~~DBA 建立 `giganexus_gw`、`giganexus_gw_test`、schema `gw`、`gw_app` / `gw_migrate` 帳號、`gw_app_role`~~ **已完成(2026-09-30,見 §1.0)** | 參考 `deploy/dev/mssql-init/01-giganexus_gw.sql`(本機);定序請 DBA 確認(本機假設 `Chinese_Taiwan_Stroke_CI_AS`) | P-01 |
| **M0:Drizzle × SQL Server 2012 複驗** | 複製 `bff/.env.example` 為 `bff/.env`,填入公司 2012 測試庫(`GW_DB_HOST`、密碼、`GW_TEST_DB_NAME`)後執行 `npm run test:int`,結果記錄於 [TECH-STACK.md](TECH-STACK.md) §4.1。**`test:int` 會清空 `GW_TEST_DB_NAME` 的 schema `gw` 再重建**:測試區(主機 2)使用 `giganexus_gw_test`,上線後整合測試必須改用 DBA 另建的專用庫(名稱須含 `_test`),或在測試區上線前完成 M0 | P-04 |
| migration 套用 | 三個 migration(`20260924114259_init`、`20260925021314_api_route_gherkin`:`gw.api_route.gherkin NVARCHAR(MAX)`、`20260926011642_upstream_project`:`gw.upstream.project VARCHAR(100)`)需在 2012 測試庫以 `npm run db:migrate` 實際套用一次。**已完成(2026-09-30)**:以 `gw_migrate` 套用至 `10.10.130.220` `giganexus_gw_test`,schema `gw` 共 31 張表,`drizzle.__drizzle_migrations` 3 筆;`gw_app` 對 `audit_log` / `auth_log` / `api_access_log` 僅有 SELECT、INSERT(DENY 生效) | P-04 |
| `bff/src/db/external/bpm.ts` | 欄位依 BPM 負責人實際提供的唯讀 view 調整(目前依本機模擬 view `dbo.vw_gn_employee`) | P-12 |
| `bff/src/db/external/los.ts` | 欄位與型別依 DBA 提供的 LOS view 調整;確認日期欄位確實為 `d/M/yyyy` 字串 | P-12 |
| `bff/src/db/external/portal.ts` | 依 DBA 提供的 `LoginData` 唯讀 view 調整(舊帳號遷移 W3-4.16 尚未實作) | P-15 |
| `db/seed/data.mts` | `gw-it-admin` 權限範圍 IT 主管已確認(2026-09-29,維持不含 `rbac.write`、`company.write`、`client.write`);預設限流數值仍為暫定;公司與 AD 網域對應(碩禾 → gsc、gsmc;鹽城碩禾 → ygdmc)的**公司名稱必須與 LOS `CompName`(無 LOS 資料時為 BPM `Organization`)完全一致**,否則登入時另建無網域的公司、該員工下次登入回 `ACCOUNT_NOT_REGISTERED`,實際值待 DBA 確認;新權限 `gw.admin.route.register`(後端 API Key 專用)也會給兩個管理員角色,不影響安全(註冊端點只接受 API Key) | P-08 |
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
| `.gitlab-ci.yml` `check:nginx` | **已改**(2026-09-29):以 `deploy/gen-temp-pki.sh` 產生一次性臨時自簽憑證,不再呼叫 `deploy/dev/gen-dev-secrets.sh`;尚未在實際 Runner 上執行 | — |

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
