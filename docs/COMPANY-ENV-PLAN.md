# 上公司環境調整清單

> 目前程式在開發主機以 Docker 模擬環境(模擬 AD、模擬下游後端、SQL Server 2022 容器與模擬資料、範例網頁)開發與測試。
> 本文件列出部署到公司**測試區(主機 2)/ 正式區(主機 3)**時需要修改或補齊的檔案與設定。
> 前置工作編號(P-xx)見 [IMPL-PLAN.md](IMPL-PLAN.md) §3;部署流程見 [DEPLOYMENT.md](DEPLOYMENT.md)。

---

## 0. 不進版控的本機測試環境

以下只存在開發主機(`.gitignore`),公司環境不使用,也不需部署:

| 路徑 | 內容 |
| --- | --- |
| `tools/mock-ad/` | 模擬 AD 三網域 |
| `tools/mock-upstream/` | 模擬下游後端(go-mes、core-hrm、bpm-adapter、portal-svc、Endpoint Server) |
| `tools/sample-spa/` | 範例網頁:入口網、MES 看板、IT 管理 demo |
| `deploy/dev/` | 模擬資料庫初始化與測試資料(`mssql-init/`)、開發用憑證與密碼(`secrets/`)、本機路由與角色設定(`config/`)、`up.sh` / `down.sh` |
| `deploy/docker-compose.dev.yml`、`deploy/dev.env` | 本機完整環境 |

受影響的項目:

- `bff/test/e2e/` 依賴上述本機環境,只能在開發主機執行;CI 只跑單元測試。
- `.gitlab-ci.yml` 的 `check:nginx` 使用 `deploy/dev/gen-dev-secrets.sh` 產生憑證,**進版控後會找不到檔案**,需改為在 CI 內直接以 openssl 產生一次性自簽憑證(見 §4)。
- `deploy/dev/mssql-init/01-giganexus_gw.sql`(建立資料庫、登入帳號、`gw_app_role` 權限)是交給 DBA 的腳本草稿;若要提交 DBA,需另外複製到版控內(例如 `db/dba/`)並移除 `$(變數)` 以外的開發預設密碼。

---

## 1. 資料庫(SQL Server 2012 / BPM 2019)

| 檔案 / 項目 | 需要調整 | 依賴 |
| --- | --- | --- |
| DBA 建立 `giganexus_gw`、`giganexus_gw_test`、schema `gw`、`gw_app` / `gw_migrate` 帳號、`gw_app_role` | 參考 `deploy/dev/mssql-init/01-giganexus_gw.sql`(本機);定序請 DBA 確認(本機假設 `Chinese_Taiwan_Stroke_CI_AS`) | P-01 |
| **M0:Drizzle × SQL Server 2012 複驗** | `bff/.env` 指向公司 2012 測試庫(`GW_DB_HOST`、`GW_TEST_DB_NAME`)後執行 `npm run test:int`,結果記錄於 [TECH-STACK.md](TECH-STACK.md) §4.1 | P-04 |
| `bff/src/db/external/bpm.ts` | 欄位依 BPM 負責人實際提供的唯讀 view 調整(目前依本機模擬 view `dbo.vw_gn_employee`) | P-12 |
| `bff/src/db/external/los.ts` | 欄位與型別依 DBA 提供的 LOS view 調整;確認日期欄位確實為 `d/M/yyyy` 字串 | P-12 |
| `bff/src/db/external/portal.ts` | 依 DBA 提供的 `LoginData` 唯讀 view 調整(舊帳號遷移 W3-4.16 尚未實作) | P-15 |
| `db/seed/data.mts` | `gw-it-admin` 權限範圍、預設限流數值為暫定,需 IT 主管確認;公司與 AD 網域對應(碩禾 → gsc、gsmc;鹽城碩禾 → ygdmc) | P-08 |
| 稽核表保存排程(SQL Agent) | 尚未撰寫(W3-1.6) | — |

---

## 2. 機密(主機受保護目錄 `GW_SECRETS_DIR`,不入版控)

| 檔案 | 內容 | 依賴 |
| --- | --- | --- |
| `gw_db_password`、`gw_migrate_password` | `giganexus_gw` 的 BFF 與 migration 帳號密碼 | P-01 |
| `los_db_password`、`bpm_db_password`、`portal_db_password` | 唯讀帳號密碼 | P-12、P-15 |
| `ldap_gsc_password`、`ldap_gsmc_password`、`ldap_ygdmc_password` | 三個 AD 網域的查詢服務帳號密碼 | P-07 |
| `jwt/<kid>.pem` | ES256(P-256)私鑰,**測試區與正式區各自產生**;檔名即 `kid`,排序最後者為簽章用 | — |
| `pki/server.crt`、`pki/server.key` | AD CS 簽發,SAN 含 Gateway **IP** | P-05 |
| `pki/agent-ca-chain.pem`、`pki/agent.crl` | Agent 專用中繼 CA + 根 CA、CRL(需定期更新,W3-3.4) | P-06 |
| `pki/ca.crt` | 企業根 CA(Nginx 以 grpcs 連 Endpoint Server 時驗證用) | P-05 |

產生 JWT 金鑰:`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out <kid>.pem`

---

## 3. 部署設定

| 檔案 | 需要調整 | 依賴 |
| --- | --- | --- |
| `deploy/test.env.example`、`deploy/prod.env.example` | 複製到主機受保護目錄並填入:Registry、`GW_SECRETS_DIR`、`GW_CONFIG_DIR`、SQL Server / BPM 主機、`ENDPOINT_*_UPSTREAM`、`INTERNAL_NETWORKS`(公司內網網段,「記住我」用) | P-11 |
| `${GW_CONFIG_DIR}/ldap-domains.json` | 三個網域的 `url`(過渡期 `ldap://<DC>:389`,Q12)、`baseDN`、`bindDN`、`netbios`、`upnSuffix`;格式同本機的 `deploy/dev/config/ldap-domains.json` | P-07 |
| 角色與 AD 群組對應 | 本機以 `deploy/dev/config/gateway-routes.yaml` 套用;公司需依 IT 規劃的 `GN-*` 群組 DN 另寫一份(DN 含逗號須用區塊清單加引號),以 `gw apply` 套用 | P-08 |
| `deploy/docker-compose.test.yml`、`.prod.yml` | 目前只有 `GW_ENV` 與 log level;依主機需要補充(例如 port 衝突時改 `GW_HTTP_PORT` 等) | P-11 |
| Windows 主機 | `GW_SECRETS_DIR` 等路徑使用 Windows 路徑;確認 80 / 443 / 9443 未被佔用;Docker Desktop 開機自動啟動 | P-11、P-17 |

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

---

## 6. 程式行為需確認

| 項目 | 說明 |
| --- | --- |
| `bff/src/modules/admin/db-viewer.ts`(IT 管理 demo 的資料庫檢視 API) | 目前在 `GW_ENV` 不是 `prod` 時註冊,**測試區也會開啟**;測試區以唯讀帳號讀取正式人事資料(DEPLOYMENT.md §5.1),建議改為只在 `dev` 註冊,或上測試區前移除 |
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
