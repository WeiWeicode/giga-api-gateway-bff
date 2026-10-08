# 後端修改紀錄

> 新紀錄加在最上方;範圍 `bff/`、`nginx/`、`db/`、`deploy/`;格式見 `AGENT.md` §9。

## 2026-10-08 附件上傳直送 file-api(giga-file-service D3 / D4-B)
- 內容:使用者測試後要求單檔 30 MB,超過 BFF 全域 10 MB。① Nginx `location = /api/file/files`:POST 以 `auth_request /_auth/verify` 取得內部 Token 後直送 `$file_api_upstream`(新環境變數 `FILE_API_UPSTREAM`,預設 `file-api:51272`;envsubst 篩選加 `FILE_`),`client_max_body_size 31m`(30 MB + multipart 表頭)、`proxy_request_buffering off`;非 POST 以 `error_page 418 = @api_via_bff` 照常轉 BFF。② BFF `/_auth/verify`:原請求方法不是 GET / HEAD / OPTIONS 時檢查 CSRF(`csrfValid`;auth_request 帶原請求標頭),因直送路徑不經 BFF 的 CSRF 檢查(Cookie 另有 SameSite=Strict)。直送的上傳不經 BFF 路由層限流與 Gateway 稽核,由 file-api `file_access_log` 記錄。`/ws/endpoint/*` 為 GET,不受影響
- 檔案:`nginx/conf.d/portal.conf`、`nginx/templates/00-env.conf.template`、`nginx/Dockerfile`、`deploy/docker-compose.yml`、`deploy/test.env.example`、`deploy/prod.env.example`、`bff/src/modules/auth/routes.ts`、`docs/BACKEND-GUIDE.md`、`AGENT.md`
- 驗證:`npx tsc --noEmit`、`vitest run test/unit` 226 項通過;`nginx -t` 由 CI check:nginx 執行;測試區實測見下一筆或 giga-file-service HANDOFF

## 2026-10-01 暫停 Nginx 限流與登入失敗暫停(PRD v0.10)
- 工作項目：W3-2.5、W3-4.3(暫停)
- 內容：測試區登入頁頻繁出現 429「請求過於頻繁」(Nginx `gw_auth`,每 IP 5 r/m、burst 4),需求方決定先取消 Nginx 限流,連同輸錯密碼的暫停一起取消。① Nginx:移除全站 `gw_ip`(50 r/s,burst 100)與登入 / 註冊 / 密碼 `gw_auth` 的 `limit_req_zone` 與 `limit_req`;`/api/auth/(login|register|password/)`、`/it/api/auth/login` 兩個 location 只為掛限流而存在,一併移除,改由 `/api/`、`/it/api/` 轉送;`GW_AUTH_RATE` 從 Dockerfile、compose、範本移除(主機上 env 檔若仍有此值不影響)。Agent `:9443` 的 `limit_conn`(每張裝置憑證 10 條同時連線)不是請求限流,保留。② BFF:移除 `LOGIN_THROTTLED`(同帳號 15 分鐘 5 次、同 IP 50 次)與 Redis `gw:login:fail:*` 計數,`LoginService` 不再需要 Redis;錯誤代碼 `LOGIN_THROTTLED` 保留在 `errors.ts`(前端仍可處理),目前不會回傳。本機帳號 10 次失敗鎖定、BFF 路由層限流、註冊與忘記密碼限流(`gw:reg:*`)不變。③ E2E:移除 `clearFails()`;`Session.request` 不再對 Nginx 429 重試(`noRetry` 移除);`03-self-service` 註冊限流測試改為單次請求。④ **風險**:輸錯密碼每次都送 AD 驗證(只輸入工號時依序試各網域),連續輸錯可能觸發 AD 帳號鎖定原則;Nginx 層沒有任何請求限流。恢復時 revert 本次 commit 即可。GigaItApp(`/it/`)自有的登入失敗鎖定(5 次、15 分鐘,另一個 repo)未修改
- 檔案：`nginx/nginx.conf`、`nginx/conf.d/portal.conf`、`nginx/templates/00-env.conf.template`、`nginx/Dockerfile`、`deploy/docker-compose.yml`、`bff/src/modules/auth/login.ts`、`bff/src/modules/auth/plugin.ts`、`bff/test/e2e/gw.ts`、`bff/test/e2e/02-auth-session.test.ts`、`bff/test/e2e/03-self-service.test.ts`、`bff/test/e2e/08-users-admin.test.ts`、`docs/PRD.md`、`docs/DEPLOYMENT.md`、`docs/DATABASE.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/TEST-DEPLOY-RUNBOOK.md`、`docs/Gherkin/auth/ad-login.feature`、`docs/Gherkin/gateway/nginx-entry.feature`
- 驗證：`npm run typecheck`、`lint`、`format:check` 通過,`npm test` 121 項通過。測試區部署 `b9e06ce` 後:nginx 容器內 `grep -rn limit_req /etc/nginx/` 無結果、`nginx -t` 通過;自 10.10.112.13 連續 12 次 `POST /api/auth/login`(假工號 `Z99E2ENONE`)全部回 401 `ACCOUNT_NOT_REGISTERED`,無 429;E2E `01-nginx-entry`、`02-auth-session`、`03-self-service`、`08-users-admin` 共 51 項通過(已移除 `clearFails()`,本機帳號錯誤密碼與 10 次鎖定正常);Redis 只剩部署前舊版寫入的 `gw:login:fail:ip:10.10.112.13`(值 2,部署後的錯誤密碼登入未再遞增,15 分鐘內自然過期)。**未驗證**:AD 帳號連續輸錯(避免鎖定真實帳號)

## 2026-10-01 主機 2 保留使用者來源 IP(Traefik L4 轉送 + PROXY protocol)
- 內容:主機 2 原以 `netsh portproxy` 轉送 80 / 443 到 WSL,Nginx 只看到 Docker 閘道 `172.19.0.1`(PRD Q26),登入 / 註冊限流全公司共用、Webhook 與內網白名單無法使用、「記住我」與稽核沒有真實 IP。需求方同意在主機 2 安裝 Traefik(Windows 10 不支援 WSL mirrored,方案 E 不可行)。① Nginx 新增 PROXY protocol 入口 `10080`、`10443`、`19443`,`nginx.conf` 以 `set_real_ip_from` + `real_ip_header proxy_protocol` 取出來源 IP(只影響 PROXY protocol 連線;80 / 443 / 9443 照舊給 CI 冒煙測試與同主機容器);compose 把新 port 只綁 `127.0.0.1`,區網無法直接連入偽造標頭。② 新增 `deploy/windows-l4/`(Traefik 靜態 / 動態設定、`install.ps1`、`rollback.ps1`)。③ 主機 2:下載 Traefik v3.7.13 官方 Windows 版(51 MB,SHA256 與官方 checksums 相符)到 `C:	raefik`,先以替代 port 18080 / 18443 試跑確認 `remote_addr` 改為真實來源,再執行 `install.ps1 -HostIp 10.10.130.124`:建立開機工作 `GigaNexus-Traefik`(SYSTEM、失敗自動重啟)、刪除 portproxy 80 / 443(8080、9444 不動);Traefik 只綁主機 IP,避開 WSL localhost 轉送的 `127.0.0.1` / `::1`。防火牆為 port 規則,未修改。`:9443` 原本就未對區網開放,此次不變(Agent 上線時加入口並開防火牆)。④ E2E `01-nginx-entry`:`:9443` 測試原本在連不上時直接通過,改為在主機上連 `127.0.0.1:9443` 確認回 400;新增「來源 IP」測試(Nginx `remote_addr` 與 BFF `gw.auth_log.ip` 等於本機 IP)。PRD Q26 改為已解決,DEPLOYMENT §6 / §6.1、COMPANY-ENV-PLAN、GITLAB-SETUP §3.6、TEST-DEPLOY-RUNBOOK、ENDPOINT-AGENT-GUIDE G4、PROJECT-MAP 同步
- 檔案:`nginx/nginx.conf`、`nginx/conf.d/portal.conf`、`nginx/conf.d/agent.conf`、`deploy/docker-compose.yml`、`deploy/windows-l4/`(新增)、`bff/test/e2e/01-nginx-entry.test.ts`、`docs/DEPLOYMENT.md`、`docs/PRD.md`、`docs/COMPANY-ENV-PLAN.md`、`docs/GITLAB-SETUP.md`、`docs/TEST-DEPLOY-RUNBOOK.md`、`docs/ENDPOINT-AGENT-GUIDE.md`、`docs/PROJECT-MAP.md`
- 驗證:以 nginx 映像 + 臨時憑證 `nginx -t` 通過;部署 `2a02374` 後在 WSL 以 `curl --haproxy-protocol https://127.0.0.1:10443/healthz` 得 200;切換後自 10.10.112.13 存取 `https://giganexus-test.gigasolar.com.tw/healthz` 200、`http://` 301,Nginx log `remote_addr` = `10.10.112.13`;E2E `01-nginx-entry` 14 項通過(含 BFF `auth_log.ip` = `10.10.112.13`)。切換期間 80 / 443 中斷數秒。**Webhook 白名單仍為空**:需 BPM 應用程式主機的 IP(不一定是資料庫主機 10.10.130.190)

## 2026-10-01 測試區套用公司憑證、文件改為 DNS 名稱
- 內容:主管決定以 `gigasolar.com.tw` 為主。網通已建 `giganexus-test.gigasolar.com.tw` → 10.10.130.124;本人於主機 2 依 RUNBOOK 4.1 置換 `pki/server.crt/key`、`test.env` 加 `GW_PUBLIC_HOST`、`itapp.env` 加 `BFF_BASE_URL`、重建 nginx。文件:`:443` 位址佔位改為 `<gateway-host>`(`:9443` 維持 `<gateway-ip>`),移除「內部沒有 DNS / 以 IP 存取」的敘述,PRD v0.8;COMPANY-ENV-PLAN §1.1 記錄主機 2 現況;RUNBOOK 4.1 補主機 2 的重建指令(CI 部署目錄為 `/srv/giganexus/shared/giga-api-gateway-bff`)。CLI 說明、onboarding 回傳的瀏覽器範例網址同步改佔位
- 檔案:`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/IMPL-PLAN.md`、`docs/FRONTEND-GUIDE.md`、`docs/ENDPOINT-AGENT-GUIDE.md`、`docs/GITLAB-SETUP.md`、`docs/COMPANY-ENV-PLAN.md`、`docs/TEST-DEPLOY-RUNBOOK.md`、`bff/src/cli/index.ts`、`bff/src/modules/admin/onboarding.ts`、`sdk/node/src/env.ts`
- 驗證:`openssl s_client -connect 10.10.130.124:443 -servername giganexus-test.gigasolar.com.tw -verify_hostname …` → `CN=*.gigasolar.com.tw`、`Verify return code: 0`;`/healthz` 200、`/api/auth/me` 401、`/` 200、`/it/` 200;本人以瀏覽器開 `https://giganexus-test.gigasolar.com.tw/it/login` 憑證受信任、頁面正常。`npm run lint`、`typecheck` 通過,`npm test` 70 項通過,修改檔案 `prettier --check` 通過

## 2026-10-01 `:443` 改用公司 SSL 憑證(*.gigasolar.com.tw)、`:9443` 憑證分開
- 內容：主管提供公司萬用憑證 `*.gigasolar.com.tw`(Sectigo DV,至 2027-01-31)。萬用憑證不能用 IP 驗證,PRD Q1 修訂為 `:443` 以 DNS 名稱存取(測試區 `giganexus-test.gigasolar.com.tw` → 10.10.130.124、正式區 `giganexus.gigasolar.com.tw` → 10.10.130.122,待網通建 A 紀錄);Agent `:9443` 仍以 IP 連線。① `snippets/ssl.conf` 移除 `ssl_certificate`,改寫在 `portal.conf`(`server.crt`)與 `agent.conf`(新檔名 `agent-server.crt`),兩個 port 可各自替換;② `gen-temp-pki.sh` 另產生 `agent-server.crt/key`,舊版 `pki/` 再執行會由 `server.*` 補上;③ compose 給 nginx 網路別名 `${GW_PUBLIC_HOST}`,同主機容器以 DNS 名稱呼叫時主機名稱符合憑證;env 範本新增 `GW_PUBLIC_HOST`;④ 文件:置換步驟(RUNBOOK 4.1)、機密表、PRD §7.1 / §7.6 / Q1。憑證與私鑰不入版控,只放在主機 `GW_SECRETS_DIR/pki/`。公司憑證附的 `ca.crt`(Sectigo 中繼鏈)與 `pki/ca.crt`(企業根 CA,驗證 Endpoint Server)不同,不可互換
- 檔案：`.gitlab-ci.yml`(部署時補 `agent-server.*`,避免主機上舊 `pki/` 讓 Nginx 起不來)、`nginx/snippets/ssl.conf`、`nginx/conf.d/portal.conf`、`nginx/conf.d/agent.conf`、`deploy/gen-temp-pki.sh`、`deploy/docker-compose.yml`、`deploy/test.env.example`、`deploy/prod.env.example`、`samples/node-backend/.env.example`、`docs/PRD.md`、`docs/COMPANY-ENV-PLAN.md`、`docs/TEST-DEPLOY-RUNBOOK.md`、`docs/DEPLOYMENT.md`、`docs/PROJECT-MAP.md`
- 驗證：公司憑證:私鑰與憑證 modulus 相同;`openssl verify -untrusted ca.crt STAR_gigasolar_com_tw.crt` OK(鏈 → USERTrust RSA 根)。Git Bash(`MSYS_NO_PATHCONV=1`)執行 `gen-temp-pki.sh`:全新產生含 `agent-server.crt/key`(與 `server.crt` 相同);舊版 `pki/`(無 `agent-server.*`)重跑會補上,第三次執行不重複處理。`prettier --check` 修改的文件通過。`docker compose config`:test.env 範本解析出 nginx 別名 `giganexus-test.gigasolar.com.tw`,未設 `GW_PUBLIC_HOST` 時為 `nginx`。**未驗證**:本機 Docker Desktop 未啟動,`nginx -t`、實際 TLS 握手未在本機執行(由 CI `check:nginx` 與部署驗證);DNS A 紀錄尚未建立;主機 2 / 3 尚未置換憑證;GigaItApp 尚未改為以 DNS 名稱呼叫(另一個 repo,未修改)

## 2026-09-29 移到公司環境:移除對家中本機環境的依賴、Windows 相容
- 內容：公司開發機(Windows)只有版控內容,`tools/`、`deploy/dev/` 未帶過來。① `.gitlab-ci.yml` `check:nginx` 改用 `deploy/gen-temp-pki.sh`(`GATEWAY_IPS=127.0.0.1`、`GW_ENV=ci`),不再呼叫不存在的 `deploy/dev/gen-dev-secrets.sh`;② `bff/.env.example` 改為直接連公司 SQL Server 2012 測試庫(M0),主機與密碼為佔位;註明 `test:int` 會清空 `GW_TEST_DB_NAME`,測試區上線後不可再指向 `giganexus_gw_test`;JWT 金鑰改放 `bff/secrets/jwt`(不入版控);③ `deploy/test|prod.env.example`、`samples/node-backend/.env.example`、`ci-templates/spa-deploy.yml`、`vitest.config.ts` 的說明不再指向 `deploy/dev/`、`tools/`;④ `db/seed/data.mts`:`gw-it-admin` 範圍 IT 主管已確認(維持現值),公司名稱註明必須與 LOS `CompName` 完全一致(實際值待 DBA 確認,未改);⑤ Windows:`migrate.ts`、`seed.ts`、`reset-test-db.ts` 的「直接執行」判斷在 Windows 永遠為假,指令不執行即以 0 結束,改用 `pathToFileURL`;新增 `.gitattributes`(`* text=auto eol=lf`),避免 `.sh` 以 CRLF 檢出後在 Linux 容器失敗、Prettier 全數不符;⑥ repo 資料夾由 `api-gateway-bff` 改為 `giga-api-gateway-bff`(AGENT.md §10.1,giga-Portal / GigaItApp 以此路徑取 web-kit 與憑證),`docs/TECH-STACK.md` 目錄樹同步
- 檔案：`.gitlab-ci.yml`、`.gitattributes`、`bff/.env.example`、`bff/vitest.config.ts`、`bff/src/db/migrate.ts`、`bff/src/db/seed.ts`、`bff/scripts/reset-test-db.ts`、`db/seed/data.mts`、`deploy/test.env.example`、`deploy/prod.env.example`、`samples/node-backend/.env.example`、`ci-templates/spa-deploy.yml`、`docs/COMPANY-ENV-PLAN.md`、`docs/TECH-STACK.md`
- 驗證：`npm ci` 後 `npm run lint`、`typecheck` 通過,`npm test` 70 項通過;工作目錄轉為 LF 後 `npm run format:check` 全部通過(修改前 77 個檔案因 CRLF 不符),`db/seed/data.mts` 以 `bff/.prettierrc.json` 檢查通過。Git Bash 以 CI 參數執行 `gen-temp-pki.sh`,產生 Nginx 需要的 `server.crt/key`、`agent-ca-chain.pem`、`agent.crl`、`ca.crt`,`openssl verify` 通過。無 `.env` 時 `db:migrate`、`db:seed`、`db:reset-test` 皆實際執行並以「設定錯誤」exit 1(修改前 Windows 上直接 exit 0,已以測試腳本確認舊判斷為 false、新判斷在含 `~` 與中文的路徑皆為 true)。**未驗證**:Docker Desktop 未啟動,`nginx -t`、CRLF 腳本在 alpine 容器內失敗的實際情形、`npm run test:int`(尚無公司 2012 測試庫連線資訊)皆未執行;樣本 `samples/node-backend` 測試未執行(只改 `.env.example` 註解)

## 2026-09-26 移除測試應用「公司文件系統」(TestGigaAPP / DMS)
- 內容：TestGigaAPP 為測試用專案,需求方將刪除該 repo。Nginx `portal.conf` 移除 `/dms/` 四個 location(`/dms/` 改落入入口網 SPA,`/api/dms/*` 回 `ROUTE_NOT_FOUND`);取消 BACKEND-GUIDE §3.3 port 51290 `dms-api`、PRD §7.2.1 子路徑 `/dms/` 的登記,AGENT.md §10.2 專案登記表移除 TestGigaAPP。本機環境:CLI `client:disable --code dms-api`;因 CLI 沒有刪除指令,以單一交易(`XACT_ABORT`)刪除 `dms-api` 上游與位址、6 條路由、2 筆匯入批次與逐筆結果、角色 `dms-reader` / `dms-editor`(含權限、AD 群組、公司對應)、權限 `dms.document.read` / `write`,所有使用者 `perm_version + 1`,稽核新增一筆 `config.remove`(既有稽核紀錄保留);發佈 v41(removed 6 條)。Docker:刪除映像 `giganexus/dms-api:dev`、`giganexus/spa-dms:dev`、volume `giganexus-dms_dms_data`、`gw_www` 內的 `/srv/www/dms`(未執行中的容器)。範例文字中的 `TestGigaAPP` 改為 `giga-endpoint`。
- 檔案：`nginx/conf.d/portal.conf`、`AGENT.md`、`docs/PRD.md`、`docs/BACKEND-GUIDE.md`、`docs/DATABASE.md`、`bff/src/cli/openapi.ts`、`bff/test/unit/openapi.test.ts`
- 驗證：重建 nginx 映像與容器,`nginx -t` 通過,容器內 `portal.conf` 已無 dms;`https://localhost/dms/` 回入口網頁面、`/api/dms/categories` 回 `ROUTE_NOT_FOUND`,`/`、`/it/` 200。資料庫查詢 dms 上游 / 路由 / 角色 / 權限皆為 0。Redis `gw:pv:*` 原本即無快取。TestGigaAPP repo 本身未刪除(由需求方處理)

## 2026-09-25 Agent 通道 limit_conn 改以裝置憑證計算
- 工作項目：W3-3.3
- 內容：`:9443` 的 `limit_conn_zone` 鍵值由 `$binary_remote_addr` 改為 `$ssl_client_fingerprint`,每張裝置憑證 10 條同時串流(`agent.conf` 的 `limit_conn agent_conn 10` 不變)。原本以來源 IP 計算,Docker Desktop 轉送(所有連線來源皆為閘道 IP)或子公司 NAT 時,多台電腦共用 10 條,其餘收到 429 / gRPC `UNAVAILABLE`。選指紋而非 `$ssl_client_s_dn`:長度固定 40 字元(`limit_conn` 鍵值超過 255 bytes 會不計數),憑證更新後自然換新額度。Agent 與 Watchdog 使用同一張電腦憑證,共用 10 條(ENDPOINT-AGENT-GUIDE 估計每台 1–3 條)。無憑證 / 無效憑證的請求在 HTTP 層即回 400,不會進到 `limit_conn`。PRD §7.6、§14.1,DEPLOYMENT.md §6.1,COMPANY-ENV-PLAN §3,ENDPOINT-AGENT-GUIDE §4 / §9 G4、G5,Gherkin `agent-mtls.feature` 同步更新(新增「共用來源 IP 的不同裝置各自計算」場景)
- 檔案：`nginx/nginx.conf`、`docs/PRD.md`、`docs/DEPLOYMENT.md`、`docs/COMPANY-ENV-PLAN.md`、`docs/ENDPOINT-AGENT-GUIDE.md`、`docs/Gherkin/gateway/agent-mtls.feature`
- 驗證：以 worktree 的 `nginx/` 建置測試映像,另起容器接上本機 dev 網路(`:19443`,未動到執行中的 dev Nginx),`nginx -t` 通過。以 `@grpc/grpc-js` 腳本(同 `06-websocket-agent` 的 `Stream` 雙向串流)比較:舊設定(dev Nginx `:9443`)憑證 A 開 10 條後,A 的第 11 條與另一張有效憑證 B(PC-004,以 dev Agent CA 臨時簽發於 scratchpad)的第 1 條**都被拒**(429);新設定 A 的第 11 條被拒(429)、**B 成功**。兩者 Nginx 看到的來源皆為 `192.168.65.1`。無憑證請求仍回 400。測試容器與映像已刪除。`npm run test:e2e` 未執行(dev Nginx 仍為舊映像,需重建後執行)

## 2026-09-25 Docker Desktop 來源 IP 遺失:風險評估與驗證步驟(未修改設定)
- 內容：本機 Nginx access log 的 `remote_addr` 一律是 `192.168.65.1`(Docker Desktop VM 閘道)。查證 Docker Desktop 的 published port 由主機上的 `com.docker.backend` 接受連線後在 VM 內另建連線,來源 IP 不會帶進容器;Windows(WSL2)機制相同,Docker Desktop 的 host networking 與 WSL mirrored 模式都無法解決,WSL2 內自行安裝 Docker Engine(mirrored 模式,需 Windows 11 22H2+)、Hyper-V Linux VM、Linux L4 轉送 + PROXY protocol 可以保留。盤點受影響項目:Nginx `gw_ip` / `gw_auth` 限流、`:9443` `limit_conn agent_conn`、Webhook 與內網服務白名單、BFF「記住我」內網判定、登入失敗 IP 計數、API Key `allowed_ips`、稽核來源 IP。DEPLOYMENT.md 新增 §6.1(影響、方案比較、Windows 主機驗證步驟)與上線前檢查項目;PRD §14.1 新增風險、新增 Q26;COMPANY-ENV-PLAN §3 新增驗證項目。**Nginx 與 BFF 設定未修改**,待主機驗證與 Q26 決定
- 檔案：`docs/DEPLOYMENT.md`、`docs/PRD.md`、`docs/COMPANY-ENV-PLAN.md`
- 驗證：本機 Docker Desktop 4.92(engine 29.8.0)以一次性 `nginx:alpine` 容器(`-p 18080:80`)分別從本機區網 IP(`192.168.0.142`)與 `127.0.0.1` 連入,log 的來源皆為 `192.168.65.1`,容器已停止。Windows 主機 2、3 **尚未驗證**

## 2026-09-25 Agent 通道:長串流累計 10 MB 被切斷;補雙向串流 E2E
- 工作項目：W3-3
- 內容：`:9443` 沿用全域 `client_max_body_size 10m`,HTTP/2 串流的 body 是整條串流累計,Agent 長連線上傳滿 10 MB 即被 Nginx 以 RST_STREAM 切斷(error log `client intended to send too large chunked body`,用戶端收到 `INTERNAL`)。`agent.conf` 改為 `client_max_body_size 0`,單則訊息大小改由 Endpoint Server 的 `MaxRecvMsgSize` 限制。E2E 補上雙向串流(一問一答 3 輪、同連線兩條串流、11 MB 累計)、偽造 `x-client-cert-*` 標頭會被覆寫、無效憑證無法建立串流;Gherkin `agent-mtls.feature` 新增對應場景。
- 檔案：`nginx/conf.d/agent.conf`、`bff/test/e2e/06-websocket-agent.test.ts`、`docs/Gherkin/gateway/agent-mtls.feature`
- 驗證：修正前以腳本在單一串流送 25 MB,送到 10.1 MB 時被切斷;重建 nginx 映像後同一腳本 25 MB 正常結束。`06-websocket-agent` 20 項通過(新增 8 項),`npm run test:e2e` 共 132 項全部通過;`eslint`、`prettier --check` 通過。另以 Go(grpc-go 1.84)client / server 經本機 Nginx 實測單次呼叫、雙向串流、`WatchdogService` 路徑轉送、無效憑證(`INTERNAL` + HTTP 400)、上游停止(`UNAVAILABLE` + 502);測試後 Nginx 已還原為轉送 mock-endpoint。觀察到本機所有連線來源 IP 皆為 `192.168.65.1`(Docker Desktop),`limit_conn` 以來源 IP 計算,已列入 ENDPOINT-AGENT-GUIDE §9 G4,待 Windows 主機驗證

## 2026-09-25 /it/ 改由 GigaItApp 提供(自有登入):Nginx /it/api/、port 51291
- 內容：IT 管理頁面改為獨立專案 GigaItApp(`../GigaItApp`),不共用單一入口登入。Nginx 新增 `/it/api/`(一般)與 `= /it/api/auth/login`(套用 `gw_auth` 登入限流)兩個 location,以變數 `$itapp_api_upstream` 轉給 `itapp-api`(未部署時 Nginx 仍可啟動,請求回 502);`00-env.conf.template` 新增 map,`nginx/Dockerfile` 預設 `ITAPP_API_UPSTREAM=itapp-api:51291` 並把 `ITAPP_` 加入 `NGINX_ENVSUBST_FILTER`(否則變數不會被替換,/it/api 回 500);`deploy/docker-compose.yml` 與 test / prod env 範例加入 `ITAPP_API_UPSTREAM`。本機 `docker-compose.dev.yml` 的 `spa-it` 改以 GigaItApp `frontend/` 建置,取代 `tools/sample-spa/it`(原始碼保留未刪)。BACKEND-GUIDE §3.3 登記 51291、PRD §7.2.1 更新 `/it/` 說明。BFF 程式未修改;GigaItApp 以服務帳號讀取既有 `/api/admin/demo/*`、`/api/admin/db/*`、`/api/admin/routes/catalog`。
- 檔案：`nginx/conf.d/portal.conf`、`nginx/templates/00-env.conf.template`、`nginx/Dockerfile`、`deploy/docker-compose.yml`、`deploy/test.env.example`、`deploy/prod.env.example`、`deploy/docker-compose.dev.yml`(不入版控)、`docs/BACKEND-GUIDE.md`、`docs/PRD.md`、`docs/COMPANY-ENV-PLAN.md`、`README.md`
- 驗證：重建 nginx 映像並重建容器,`nginx -t` 通過,`00-env.conf` 內 `$itapp_api_upstream` 為 `itapp-api:51291`;`/it/api/healthz` 200、`/it/api/auth/me` 未登入 401(含安全標頭、X-Request-Id 只有一個);既有 `/api/auth/me` 401、入口網 `/` 200 不受影響;GigaItApp 發佈到 `it-admin` 後 `/it/`、`/it/gateway/rbac/graph` 200(History 模式)。未執行 BFF 的 `npm test` / E2E(BFF 程式未變更)

## 2026-09-25 登記公司文件系統(DMS):子路徑 /dms/、port 51290
- 內容：新系統「公司文件系統」上架本機 Gateway(視同測試區)。Nginx 新增 `/dms/` SPA location(`/docs` 為保留路徑,改用 `/dms/`);BACKEND-GUIDE §3.3 登記 port 51290 / `dms-api`、PRD §7.2.1 登記子路徑。以 CLI 建立 API Key `dms-api`,後端(`GW_ENV=test`)啟動時自動註冊 6 條草稿路由與權限 `dms.document.read` / `write`;以 `apply` 新增角色 `dms-reader`(公司 碩禾)、`dms-editor`(GN-IT-Admins)後發佈 v32、v33。後端與前端原始碼在獨立專案(`TestGigaAPP/dms-backend`、`dms-frontend`)。
- 檔案：`nginx/conf.d/portal.conf`、`docs/BACKEND-GUIDE.md`、`docs/PRD.md`
- 驗證：新映像 `nginx -t` 通過後重建 nginx 容器;`/dms` 301、`/dms/`、`/dms/documents/1` 200(History 模式);經 Gateway 以 S100001 / S112009 / Y110001 聯測:無權限 403 `PERMISSION_DENIED`、他部門文件 403 `DATA_ACCESS_DENIED`、缺 CSRF 403、版本衝突 409、重複 DELETE 204、`/api/dms/categories` 第二次 `x-cache: HIT`。權限授權對象為暫定,需系統負責人確認

## 2026-09-25 本機路由補上說明與行為規格;CLI apply 支援 description / gherkin
- 工作項目：W3-5.7a
- 內容：CLI `apply` 的 routes 新增 `description`、`gherkin` 欄位。本機模擬後端(`tools/mock-upstream/services.js`)17 支 operation 補上 `description` 與 `x-gherkin`(依實際回應行為撰寫),`deploy/dev/config/gateway-routes.yaml` 的聚合、mock、萬用路由也補上;重建後 20 條已發佈路由皆有說明與行為規格。E2E 09 的 MES 重新匯入範例改為從線上路由取得說明,維持「不變」判斷。
- 檔案：`bff/src/cli/index.ts`、`bff/test/e2e/09-admin-onboarding.test.ts`、`tools/mock-upstream/services.js`、`deploy/dev/config/gateway-routes.yaml`(後兩者為本機環境,不進版控)
- 驗證：`npm run lint`、`typecheck`、`format:check` 通過;`deploy/dev/up.sh` 重建後匯入結果為更新 17 筆、apply 3 筆,發佈 v26;資料庫 published 20 筆的 description / gherkin 皆非空;`npm run test:e2e` 124 項全部通過

## 2026-09-25 後端自動註冊與路由查詢 API;OpenAPI 匯入邏輯共用
- 工作項目：W3-5.7a
- 內容：
  - migration `20260925021314_api_route_gherkin`:`gw.api_route` 新增 `gherkin NVARCHAR(MAX) NULL`(`db:check-2012` 通過)。
  - OpenAPI 解析新增 `description`(≤ 1000 字)、`x-gherkin`;匯入寫入 `description`、`gherkin`,不進路由快照。onboarding 預覽比對欄位同步加入兩者。
  - CLI `import-openapi` 的寫入邏輯移到 `modules/admin/route-import.ts`,與自動註冊共用;另新增對外路徑衝突檢查(原本會在唯一索引失敗)。自動註冊限定 API Key 代碼 = `x-gateway.upstream`、不可搶用其他上游的 `route_code`,上游位址以「補上」方式登記。
  - API Key 驗證(`X-Api-Key`,Argon2id、啟用 / 到期 / 允許 IP、`gw:client:{keyPrefix}` 快取 5 分,Redis 不可用時退回資料庫並記 log);CLI `client:create`(再次執行為換發)、`client:disable`(提交後 DEL 快取)。`/api/admin/registrations` 只接受 API Key,不檢查 CSRF。
  - `errors.ts` 補上 PRD §8.1.1 已定義的 `IMPORT_HAS_ERRORS`、`UPSTREAM_PORT_OUT_OF_RANGE`;seed 新增權限 `gw.admin.route.register`。
- 檔案：`bff/src/modules/admin/registration.ts`、`bff/src/modules/admin/route-import.ts`、`bff/src/modules/auth/api-key.ts`、`bff/src/cli/`、`bff/src/modules/auth/plugin.ts`、`bff/src/app.ts`、`bff/src/errors.ts`、`bff/src/db/schema/api.ts`、`db/migrations/20260925021314_api_route_gherkin/`、`db/seed/data.mts`
- 驗證：`npm run lint`、`typecheck`、`format:check` 通過;`npm test` 62 項、`test:int` 15 項、`test:e2e` 124 項全部通過。migration 只在容器 SQL Server 驗證,尚未在 SQL Server 2012 複驗

## 2026-09-25 新增上架演練預覽 API(demo)
- 內容：`GET /api/admin/demo/catalog`、`POST /api/admin/demo/openapi-preview`(沿用 CLI 的 OpenAPI 解析規則,另檢查路徑衝突、限流政策、上游 port;缺少必填欄位的 operation 列為 error 列)、`POST /api/admin/demo/route-preview`、`GET /api/admin/demo/who-can-access`。只讀不寫,與 db-viewer 相同僅 `GW_ENV` 非 prod 時註冊。
- 檔案：`bff/src/modules/admin/onboarding.ts`、`bff/src/app.ts`、`bff/test/e2e/09-admin-onboarding.test.ts`
- 驗證：`npm run typecheck`、`lint`、`format:check` 通過;E2E 6 項通過

## 2026-09-24 本機測試環境不進版控;新增上公司環境調整清單
- 內容：`.gitignore` 排除 `tools/`、`deploy/dev/`、`deploy/dev.env`、`deploy/docker-compose.dev.yml`(模擬 AD / 後端、範例網頁、模擬資料庫與開發用憑證),本機檔案、容器與資料庫保留;新增 `docs/COMPANY-ENV-PLAN.md` 列出部署到測試區 / 正式區需調整的檔案。
- 檔案：`.gitignore`、`docs/COMPANY-ENV-PLAN.md`、`README.md`、`AGENT.md`
- 驗證：`git check-ignore` 確認上述路徑已排除;本機 11 個容器仍在執行

## 2026-09-24 新增資料庫檢視 API(demo)
- 內容：`GET /api/admin/db/tables`、`GET /api/admin/db/tables/:table?page&pageSize`(pageSize 上限 100),依主鍵由新到舊排序,ROWVERSION 以 hex 回傳;`app.ts` 在 `GW_ENV` 非 prod 時才註冊。Compose 新增 `spa-it` 發佈服務,`deploy/dev/up.sh` 一併發佈 `/it/`。
- 檔案：`bff/src/modules/admin/db-viewer.ts`、`bff/src/app.ts`、`deploy/docker-compose.dev.yml`、`deploy/dev/up.sh`
- 驗證：`npm run typecheck`、`lint`、`format:check` 通過;E2E 08-admin-db-viewer 4 項通過

## 2026-09-24 依 TECH-STACK §2 重整目錄
- 內容：Node 專案設定檔移入 `bff/`;seed 資料留在 `db/seed/data.mts`,執行程式移至 `bff/src/db/seed.ts`;本機資料庫初始化移至 `deploy/dev/mssql-init/`;`drizzle.config.ts` 留在根目錄,由 `bff/` 以 `--config ../drizzle.config.ts` 執行。
- 驗證：`npm run typecheck`、`npm test`、`npm run test:int` 通過
