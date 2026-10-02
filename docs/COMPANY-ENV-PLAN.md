# 上公司環境調整清單

> 開發機以 `bff/.env` 直連公司 SQL Server 2012 測試庫 `giganexus_gw_test`(與測試區共用)開發;驗證以測試區為準。
> 本文件列出部署到公司**測試區(主機 2)/ 正式區(主機 3)**時需要修改或補齊的檔案與設定。
> 前置工作編號(P-xx)見 [IMPL-PLAN.md](IMPL-PLAN.md) §3;部署流程見 [DEPLOYMENT.md](DEPLOYMENT.md)。
> **CI / Registry / AD CS 憑證尚未就緒時,測試區依 [TEST-DEPLOY-RUNBOOK.md](TEST-DEPLOY-RUNBOOK.md) 在主機 2 手動架設**(含臨時自簽憑證、主機上建置映像、Gateway → 員工入口網 → IT 管理系統的部署順序)。
> **GitLab(主機 1)與 Runner(主機 2)的架設步驟見 [GITLAB-SETUP.md](GITLAB-SETUP.md)。**

---

## Windows 開發機注意

- Git for Windows 預設 `core.autocrlf=true`,`.sh` 掛進 Linux 容器會執行失敗:repo 以 `.gitattributes`(`* text=auto eol=lf`)一律 LF 檢出;giga-Portal、GigaItApp 需各自加上相同設定。
- 直接執行的腳本以 `pathToFileURL(process.argv[1]).href` 判斷(Windows 路徑為 `D:\...`,不可用 `` `file://${process.argv[1]}` ``)。
- `npm run db:generate` 在路徑含中文的工作區找不到 schema(drizzle.config.ts 以絕對路徑給 glob),待修正。

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
| `/srv/giganexus/deploy/test.env`、`portal.env`、`itapp.env` | 非機密設定(範本:各 repo `deploy/test.env.example`);2026-10-01 加入 `GW_PUBLIC_HOST`、`BFF_BASE_URL`(`giganexus-test.gigasolar.com.tw`) | Claude 經 SSH 建立 |
| `/srv/giganexus/deploy/config/ldap-domains.json` | 只有 `gsmc` | Claude |
| `/srv/giganexus/deploy/secrets/pki/`、`jwt/test-202609.pem` | `server.crt/key`:公司 `*.gigasolar.com.tw` 憑證(2026-10-01 置換,臨時憑證備份為 `*.temp.bak`);`agent-server.*`、Agent CA / CRL、`ca.crt`:臨時自簽(SAN 含 10.10.130.124,至 2029-01);JWT 金鑰 | 臨時:Claude(`gen-temp-pki.sh`);公司憑證:**本人**(RUNBOOK 4.1) |
| `/srv/giganexus/deploy/secrets/*_password` | `gw_db`、`gw_migrate`、`los_db`、`bpm_db`、`portal_db`、`ldap_gsmc` 密碼 | **本人**:`sudo sh deploy/host2-set-secrets.sh`(隱藏輸入) |
| `/srv/giganexus/itapp-secrets/` | GigaItApp JWT 密鑰、種子帳號密碼(隨機產生,只在主機 2)、`bff_service_password`(mock 模式佔位) | Claude |
| `/srv/giganexus/shared/` | Gateway build 複製的 `web-kit/src`、`deploy/`,與已部署映像 tag `gateway-image-tag` | CI |

- **公司 SSL 憑證(2026-10-01)**:DNS `giganexus-test.gigasolar.com.tw` → 10.10.130.124 已由網通建立;`:443` 改用公司憑證,瀏覽器開 `https://giganexus-test.gigasolar.com.tw/it/login` 憑證受信任。`:9443` 仍為臨時憑證。
- Windows 端:Traefik(`C:\traefik`,工作排程器 `GigaNexus-Traefik`)`10.10.130.124:80 / 443` → PROXY protocol → `127.0.0.1:10080 / 10443`(2026-10-01 取代 `netsh portproxy`,DEPLOYMENT §6.1),防火牆規則「GigaNexus Gateway 80/443」。
- **來源 IP 實測(2026-09-30)**:自 10.10.112.13 連入,Nginx log 的 `remote_addr` 一律為 `172.19.0.1`(Docker 閘道),真實 IP 遺失。**2026-10-01 已解決**:改以 Traefik + PROXY protocol 後,`remote_addr` 與 BFF 記錄的 IP 為 `10.10.112.13`(DEPLOYMENT §6.1)。
- **上架結果(2026-09-30)**:三個專案 `develop` Pipeline 全部通過(Gateway `dd79914`、giga-Portal `f3ca9d2`、GigaItApp `83087c8`);自使用者網段驗證 `/`、`/login`、`/it/` 200,`/api/auth/me`、`/it/api/auth/me` 401,HTTP 301 轉 HTTPS。
- Docker volume `giganexus-gw_gw_www`、網路 `giganexus-gw_default` 預先建立(帶 compose 標籤),GigaItApp / Portal 可先於 Gateway 部署。
- GigaItApp 目前 `BFF_MODE=mock`:讀 BFF 的服務帳號尚未建立;建立後 `itapp.env` 改 `BFF_MODE=live`、`BFF_SERVICE_USER=<工號>`,密碼寫入 `itapp-secrets/bff_service_password`(uid 1000、400),再重跑 GigaItApp deploy-test。
- Pipeline 已知事項:`check:nginx` 以 root 容器產生的 `.ci-secrets` 必須改回 Runner 使用者擁有,否則之後所有 job 在 `git clean` 失敗(已修正);BFF 以 `up --no-deps` 更新,部署需先 `up -d --wait redis`(已修正)。
- **WSL DNS**:2026-09-30 13:39 WSL 重新產生 `/etc/resolv.conf`(→ `/mnt/wsl/resolv.conf`)後,內建 DNS 轉發 `172.30.128.1` 不再回應,拉映像 / npm 全部失敗。暫時改為 `nameserver 10.10.130.3`(公司 DNS,Windows 端同一台)+ 原轉發備用,原檔備份 `/root/resolv.conf.wsl-generated.bak`;**WSL 重啟後會還原為自動產生**。若再發生,永久做法為 `/etc/wsl.conf` 加 `[network] generateResolvConf = false` 並固定 `/etc/resolv.conf`(需 IT 同意)。

| 檔案 / 項目 | 需要調整 | 依賴 |
| --- | --- | --- |
| ~~DBA 建立 `giganexus_gw`、`giganexus_gw_test`、schema `gw`、`gw_app` / `gw_migrate` 帳號、`gw_app_role`~~ **已完成(2026-09-30,見 §1.0)** | — | P-01 |
| ~~M0:Drizzle × SQL Server 2012 複驗~~ | ✅ 2026-10-02 完成:DBA 另建整合測試專用庫 `giganexus_gw_poc_test`(`db/dba/05-poc-test-db.sql`),`test:int` 15 項全數通過([TECH-STACK.md](TECH-STACK.md) §4.1)。`bff/.env` 的 `GW_TEST_DB_NAME` 一律指向此庫,**不可指向 `giganexus_gw_test`**(會清空測試區) | P-04 |
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
| `pki/server.crt`、`pki/server.key` | `:443` 用:公司 `*.gigasolar.com.tw` 萬用憑證(Sectigo,至 2027-01-31;測試區與正式區共用同一張)。`server.crt` = `STAR_gigasolar_com_tw.crt` + `ca.crt`(中繼鏈),`server.key` = `ssl.key`;置換步驟見 [TEST-DEPLOY-RUNBOOK.md](TEST-DEPLOY-RUNBOOK.md) 步驟 4。需網通先建 DNS A 紀錄(PRD Q1) | 測試區已套用 2026-10-01;正式區待 DNS |
| `pki/agent-server.crt`、`pki/agent-server.key` | `:9443` 用:AD CS 簽發,SAN 含 Gateway **IP**;到位前以 `deploy/gen-temp-pki.sh` 產生臨時自簽憑證(含臨時 Agent CA / CRL 讓 Nginx 能啟動) | P-05 |
| `pki/agent-ca-chain.pem`、`pki/agent.crl` | Agent 專用中繼 CA + 根 CA、CRL(需定期更新,ENDPOINT-AGENT-GUIDE §10 G1) | P-06 |
| `pki/ca.crt` | 企業根 CA(Nginx 以 TLS 連 Endpoint Server 時驗證用)。**不是**公司憑證附的 Sectigo `ca.crt`,兩者不可互換 | P-05 |

產生 JWT 金鑰:`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out <kid>.pem`

---

## 3. 部署設定

| 檔案 | 需要調整 | 依賴 |
| --- | --- | --- |
| `deploy/test.env.example`、`deploy/prod.env.example` | 複製到主機受保護目錄並填入:Registry、`GW_SECRETS_DIR`、`GW_CONFIG_DIR`、SQL Server / BPM 主機、`ENDPOINT_*_UPSTREAM`、`INTERNAL_NETWORKS`(公司內網網段,「記住我」用) | P-11 |
| `${GW_CONFIG_DIR}/ldap-domains.json` | 三個網域的 `url`(過渡期 `ldap://<DC>:389`,Q12)、`baseDN`、`bindDN`、`netbios`、`upnSuffix`;格式見 [TEST-DEPLOY-RUNBOOK.md](TEST-DEPLOY-RUNBOOK.md) 步驟 3。列出的每個網域都必須有對應的 `ldap_<代碼>_password`,否則 BFF 啟動失敗 | P-07 |
| 角色與 AD 群組對應 | 依 IT 規劃的 `GN-*` 群組 DN 撰寫(DN 含逗號須用區塊清單加引號),以 `gw apply` 套用。**測試區與正式區設定不互通(PRD Q3),兩區各自套用**;聚合 / mock 路由可附 `description`、`gherkin`(mock 路由只在 dev / test 生效,PRD §8.4.1) | P-08 |
| `deploy/docker-compose.test.yml`、`.prod.yml` | 目前只有 `GW_ENV` 與 log level;依主機需要補充(例如 port 衝突時改 `GW_HTTP_PORT` 等) | P-11 |
| 下游後端 API Key | 每個後端服務在測試區、正式區各建一把(`gw client:create --code <服務代碼> [--ips <主機網段>]`),明文交給該服務存入 Docker secret(`GW_API_KEY_FILE`);後端的 `GW_BASE_URL` 指向該區 Gateway,且主機網段需列入 `internal-services.conf`(取 JWKS)(BACKEND-GUIDE §7.5) | P-16 |
| 下游後端信任 Gateway 憑證 | Gateway 憑證由 AD CS 簽發(P-05);Node.js 後端以 `NODE_EXTRA_CA_CERTS` 指向企業根 CA,否則自動註冊與取 JWKS 會因憑證驗證失敗 | P-05 |
| Windows 主機 | `GW_SECRETS_DIR` 等路徑使用 Windows 路徑;確認 80 / 443 / 9443 未被佔用;WSL2 Docker Engine 與 Runner 開機自動啟動(主機 2 已完成;主機 3 於 2026-12 由 Docker Desktop 改用) | P-11 |
| **Windows 主機:來源 IP** | 主機 2 已以 Traefik L4 轉送 + PROXY protocol 解決(2026-10-01,DEPLOYMENT §6.1);主機 3 改 Docker Engine 後執行 `deploy/windows-l4/install.ps1`(`-HostIp 10.10.130.122`),並以 DEPLOYMENT §6.1 驗證步驟確認 | P-11 |

---

## 4. Nginx

| 檔案 | 需要調整 | 依賴 |
| --- | --- | --- |
| `nginx/allowlists/test\|prod/webhook-sources.conf` | 外部系統的 Webhook 來源 IP;目前沒有來源(BPM 不送 Webhook),維持空白 = 全部拒絕 | — |
| `nginx/allowlists/test\|prod/internal-services.conf` | 下游後端與監控主機網段(可取 JWKS、`/readyz`) | P-16 |
| `nginx/allowlists/test\|prod/agent-issuers.conf` | AD CS「GigaNexus Agent」中繼 CA 的 Subject DN(`openssl x509 -noout -subject -nameopt RFC2253`,RDN 順序須完全一致) | P-06 |
| `nginx/conf.d/portal.conf` | `stub_status` 的 `allow` 網段改為監控主機;新系統上線時登記 SPA 子路徑 | — |
| `.gitlab-ci.yml` `check:nginx` | **已改**(2026-09-29):以 `deploy/gen-temp-pki.sh` 產生一次性臨時自簽憑證;已在主機 2 Runner 執行 | — |

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
| Agent 無效憑證 | Nginx 於 TLS 握手後回 HTTP 400(不會到達 Endpoint Server),與舊版驗收字面「TLS 層被拒」不同,2026-10-01 需求方確認接受(ENDPOINT-AGENT-GUIDE §10 G2);Agent 通道 2026-10-01 改為 HTTPS / WebSocket,`agent.conf` 待改寫(G0) |
| 斷路器 | 各 BFF 實例於記憶體維護,未使用 `gw:cb:*` |
| CLI 權限變更 | 以全體使用者遞增 `perm_version`,管理 API(P2-3)時改為只遞增受影響者 |

---

## 7. 尚未實作(上線前需完成)

| 工作項目 | 依賴 |
| --- | --- |
| W3-4.6b 人員排程同步 Worker | ✅ 2026-10-02 測試區完成(首次同步 BPM 7,264 / LOS 8,434 筆,建立 1,043、更新 267 人;507 個兼任帳號找不到本人,兼任帳號不用於登入,不追查) |
| ~~W3-4.16 舊單一入口帳號遷移~~ | **不實施**(2026-10-02 需求方決定:正式區由使用者自行重新申請帳號);`LEGACY_MIGRATION_ENABLED` 維持關閉,P-15 不需要 |
| W3-5.8 通知 Worker(Email + 站內)、W3-5.8a/b 自行註冊與忘記密碼 | P-09(✅ 2026-10-01 已實作;SMTP `10.10.130.69:25`,測試區需在 `test.env` 設 `MAIL_HOST`、`MAIL_REDIRECT_TO`) |
| W3-5.10 Webhook 驗簽 | — |
| W3-1.6 稽核表保存排程(✅ 2026-10-02 兩區 SQL Agent 作業已建立)、W3-2.8 nginx-prometheus-exporter(已加入 Compose)、CRL 更新排程(ENDPOINT-AGENT-GUIDE §10 G1,隨 W6) | DBA、W6 |
| P2-5 路由的 `api_key` 驗證模式、API Key 管理 API | ✅ 2026-10-02 測試區完成(E2E 09) |
