# 新增功能紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §9。

## 2026-10-01 通知(W3-5.8)、自行註冊(W3-5.8a)、忘記 / 重設密碼(W3-5.8b)
- 工作項目:W3-5.8、W3-5.8a、W3-5.8b、W3-5.9(推播)
- 內容:① **通知**:`POST /api/notify/send`(X-Api-Key 或登入者,權限 `notify.message.send`,seed 新增此權限;X-Api-Key 且無登入 Cookie 的請求不檢查 CSRF)→ 範本(`{{變數}}` 子集,Email 內文變數自動跳脫,不引入 Handlebars)→ 收件人展開(工號、AD 群組比對 `gw.user.ad_groups`、外部 Email)為「每人 × 每通道」一筆 `gw.notify_log`;查無 / 停用 / 沒有 Email 記為 `skipped`(DATABASE 新增此狀態)→ BullMQ `notify`(attempts 6、指數退避 5 秒起、priority)→ worker:Email 以 nodemailer 經公司 SMTP 中繼 `10.10.130.69:25`,站內通知寫 `gw.notify_message` 並 `PUBLISH gw:notify:user:{id}`(既有 `/ws/notify` 轉送);每次失敗 `failed` + `retry_count`,用盡 `dead` + `alert: true` error log。`idempotencyKey` 24 小時去重(`gw:idem:notify:{key}`)。**非 prod 一律改寄 `MAIL_REDIRECT_TO`**,設 `MAIL_HOST` 卻缺此值時啟動失敗(DEPLOYMENT §5.1)。CLI `apply` 新增 `notifyTemplates:`;BACKEND-GUIDE §7.7。② **自行註冊** `POST /api/auth/register { employeeNo, name, hireDate?, password? }`(`local-account.ts`):AD 任一網域有帳號 / 已註冊 / 離職 / 姓名不符 / 到職日不符 → `REGISTRATION_NOT_ALLOWED`;有 Email → 驗證連結 30 分鐘(只寄 LOS / BPM 登記的 Email,自填欄位移除)202 `VERIFICATION_SENT`;無 Email → 比對 LOS `JobDate` 後以同一請求的 `password` 直接啟用(`self_jobdate`)並通知主管(LOS `BossEMail`,其次主管的 `gw.user.email`);查無 → `pending_approval` 202 `REGISTRATION_PENDING_APPROVAL`,IT 以新 CLI `local:approve` 核准產生 72 小時啟用連結。AD 或 BPM + LOS 都無法查詢時回 500,不放行。限流 `gw:reg:ip`(10 / 小時)、`gw:reg:emp`(3 / 小時)與忘記密碼共用。③ **忘記 / 重設密碼**:`/password/forgot` 一律回 202 同一訊息(含 AD 提示),只對 `active` / `locked` 且有 Email 的本機帳號寄 30 分鐘連結;`/password/reset` 檢查政策與前 3 次、解除鎖定、撤銷所有 Refresh Token 家族;IT 重設以新 CLI `local:reset`(臨時密碼只顯示一次、`must_change_password`)。系統範本 `AUTH_REGISTER_VERIFY`、`AUTH_REGISTER_MANAGER_NOTICE`、`AUTH_PASSWORD_RESET` 由 seed 建立(只新增)。連結網址取 `PUBLIC_BASE_URL`(compose 由 `GW_PUBLIC_HOST` 帶入)。`session.ts` 抽出 `revokeUserSessions` 供 CLI 共用(行為不變)
- 檔案:`bff/src/modules/notify/plugin.ts`、`routes.ts`、`send.ts`、`template.ts`(新增)、`bff/src/workers/notify.worker.ts`(新增)、`bff/src/modules/auth/local-account.ts`(新增)、`bff/src/modules/auth/routes.ts`、`bff/src/modules/auth/plugin.ts`、`bff/src/modules/auth/session.ts`、`bff/src/plugins/queues.ts`、`bff/src/worker.ts`、`bff/src/app.ts`、`bff/src/config.ts`、`bff/src/errors.ts`、`bff/src/cli/index.ts`、`bff/src/db/seed.ts`、`db/seed/data.mts`、`bff/.env.example`、`bff/test/unit/notify-template.test.ts`(新增)、`deploy/docker-compose.yml`、`deploy/test.env.example`、`deploy/prod.env.example`、`docs/PRD.md`、`docs/DATABASE.md`、`docs/BACKEND-GUIDE.md`、`docs/DEPLOYMENT.md`、`docs/IMPL-PLAN.md`、`docs/COMPANY-ENV-PLAN.md`、`docs/TEST-DEPLOY-RUNBOOK.md`、`docs/Gherkin/auth/self-registration.feature`、`docs/Gherkin/auth/password-reset.feature`、`docs/PROJECT-MAP.md`
- 驗證:`typecheck`、`lint`、`prettier --check` 通過;`npm test` 92 項通過(新增範本、通道、Email 改寄設定 7 項)。公司開發機以 `.env`(`giganexus_gw_test`)+ 本機 Redis + 公司 SMTP 啟動 BFF 與 worker,腳本直接呼叫 BFF(未經 Nginx):**通知** 6 項符合(202 入列、同鍵 200 `DUPLICATE_REQUEST`、`line` 400、範本不存在 400、API Key 無權限 403、外部 Email 改寄);無 API Key 且無 Cookie 回 403 `CSRF_INVALID`(既有全域 CSRF 先於處理程序,與其他 `/api/*` POST 一致,非 401)。SMTP 實際寄出 3 封以上到 harryjiang@gigasolar.com.tw(`provider_msg_id` 有值,待本人確認收信);站內通知寫入並收到 Redis 推播;SMTP 改指向關閉的 port:第 1 次失敗後換正常 worker → `sent`、`retry_count` 1;持續失敗 → 5 次重試後 `dead`、`retry_count` 5、`alert: true` log。**註冊 / 重設** 以假工號 `V999901`(LOS / BPM 查無)21 項:AD 帳號 S112009 → 403;查無 → 202 待審核、狀態 `pending_approval`、再申請 403、不可登入;`local:approve` → 啟用、連結再用 `TOKEN_USED`、本機登入;忘記密碼(有帳號 / 查無 / AD)三者回應相同、查無者不寄信、重設信 `sent`;重設用舊密碼 `PASSWORD_REUSED`、重設成功、舊 Refresh Token 401 `REFRESH_TOKEN_INVALID`、連結再用 `TOKEN_USED`、新密碼登入;`local:reset` 後登入 `PASSWORD_CHANGE_REQUIRED`;第 11 次請求 429。**未驗證**:LOS / BPM 有資料的真實員工(Email 驗證連結、到職日直接啟用、姓名 / 到職日不符、離職)— 需真實的無網域員工資料,未以真實員工測試;E2E(經 Nginx)未撰寫,家中環境需加模擬 SMTP 後補。**giga-Portal 需配合**:註冊頁沒有 Email 的同仁要一併送出 `password`(目前只送 `hireDate`),依 AGENT.md §10.5 整理給入口網負責人,未修改該 repo

## 2026-10-01 Webhook 驗簽(W3-5.10)與 worker 行程
- 工作項目:W3-5.10
- 內容:新增 `POST /webhook/{source}`(PRD §8.6):依 `gw.webhook_endpoint` 驗 HMAC-SHA256 簽章(需求方決定由 Gateway 定義格式:`X-Gw-Timestamp`、`X-Gw-Signature: sha256=hex(HMAC(密鑰, ts + "." + 原始 body))`、`Idempotency-Key`,BACKEND-GUIDE v0.5 §7.6)→ 時間戳 ±5 分鐘 → Redis 去重 24 小時(`gw:idem:webhook:{source}:{key}`,重送回 200 `DUPLICATE_REQUEST`)→ 每次請求都寫 `gw.webhook_log`(含拒絕原因)→ BullMQ `webhook` 佇列(5 次指數退避)→ 立即回 200。驗簽需原始 body,模組內以 Buffer 接收不解析 JSON;密鑰檔 `WEBHOOK_SECRETS_DIR/<secret_ref>`(容器內 `/run/secrets/gw/webhook/`),讀不到、Redis 或入列失敗時回 500 並釋放去重鍵讓來源重送,不略過驗簽。新增 **worker 行程**(`src/worker.ts`,compose 服務 `worker`、CI 部署 bff-2 之後更新),`workers/webhook.worker.ts` 依 `dispatch_target` 選處理程序後寫 `processed_at`。**BPM 事件格式未定義(需求方決定先不做)**:目前沒有處理程序,事件只記錄(`error_message` = `尚無處理程序:bpm`),Gherkin 該場景標 `@wip`。CLI `apply` 新增 `webhooks:`。錯誤代碼 `WEBHOOK_*` 已在 PRD §8.1.1,補進 `errors.ts`。新增相依 `bullmq`、`nodemailer`(TECH-STACK 已列;nodemailer 供 W3-5.8)
- 檔案:`bff/src/modules/webhook/routes.ts`、`bff/src/modules/webhook/signature.ts`(新增)、`bff/src/plugins/queues.ts`(新增)、`bff/src/worker.ts`(新增)、`bff/src/workers/webhook.worker.ts`(新增)、`bff/src/app.ts`、`bff/src/config.ts`、`bff/src/errors.ts`、`bff/src/cli/index.ts`、`bff/package.json`、`bff/.env.example`、`bff/Dockerfile`、`bff/test/unit/webhook-signature.test.ts`(新增)、`bff/test/e2e/11-webhook.test.ts`(新增)、`bff/test/e2e/01-nginx-entry.test.ts`、`deploy/docker-compose.yml`、`.gitlab-ci.yml`、`docs/BACKEND-GUIDE.md`、`docs/DATABASE.md`、`docs/DEPLOYMENT.md`、`docs/IMPL-PLAN.md`、`docs/Gherkin/webhook/webhook.feature`、`docs/PROJECT-MAP.md`
- 驗證:`npm run typecheck`、`lint`、`prettier --check` 通過;`npm test` 85 項通過(新增簽章 16 項)。公司開發機以 `.env`(`giganexus_gw_test`,與測試區共用)+ 本機 Redis 啟動 BFF 與 worker,CLI `apply` 建立 `bpm` 端點後以腳本直接呼叫 BFF(未經 Nginx):合法 200、同鍵重送 200 `DUPLICATE_REQUEST`、錯誤簽章 401、時間戳 -4 分 200 / -6 分 401 / +6 分 401、缺 `Idempotency-Key` 400、`/webhook/line` 404,8 項皆符合;`gw.webhook_log` 7 筆的 `verified` / `status_code` 正確,入列的 2 筆由 worker 寫入 `processed_at`。**E2E `11-webhook`(經 Nginx、模擬 BPM 主機)未執行**:公司開發機沒有本機完整環境;家中環境執行前需在 `deploy/dev/up.sh` 產生 `secrets/webhook/bpm` 並在本機 compose 加 worker。測試區尚未部署:需本人在主機 2 放 `secrets/webhook/bpm`,並於 `allowlists/test/webhook-bpm.conf` 填 BPM 主機 IP(主機 2 來源 IP 遺失問題見 DEPLOYMENT §6.1)

## 2026-10-01 文件對齊甘特圖:Agent 改 Rust + WebSocket、時程以甘特圖為準(PRD v0.9,只改文件)
- 內容:需求方決定 ① 端點 Agent 全面改為 **Rust + WebSocket**(RustIt;2026-09-29 甘特圖已刪除 W3-3 gRPC):PRD §2–§5、§7.6、§15 與 ARCHITECTURE、TECH-STACK、BACKEND-GUIDE(51241 改登記 `endpoint-agent`)、Gherkin `agent-mtls.feature` 改為 mTLS + HTTPS / WebSocket;`ENDPOINT-AGENT-GUIDE.md` 改寫為 v0.3(Endpoint Server = RustIt Axum、Rust Agent / Watchdog、JSON 訊息信封、`rustls-cng` 取用不可匯出私鑰);AGENT.md §10.2 以 `RustIt` 取代 `giga-endpoint`、`giga-agent-watchdog`。② **時程以 NexusPlan 甘特圖為準**:PRD §13、IMPL-PLAN §2 改為狀態表(M0 實質 Go、M1 完成、測試區 M2 2026-09-30 完成、正式區 2026-12),移除各節日期。③ 主機現況:主機 2 已用 WSL2 Docker Engine,主機 3 目前 Docker Desktop、2026-12 改 Docker Engine(DEPLOYMENT §1、§6、§6.1 主機 2 來源 IP 實測遺失、PRD Q25 / Q26、IMPL-PLAN P-11 / P-17)。④ PRD 版本號整理(檔頭、狀態、頁尾一致,修訂紀錄依版本排序)。
- 檔案:`docs/PRD.md`、`docs/IMPL-PLAN.md`、`docs/ENDPOINT-AGENT-GUIDE.md`、`docs/ARCHITECTURE.md`、`docs/TECH-STACK.md`、`docs/BACKEND-GUIDE.md`、`docs/DEPLOYMENT.md`、`docs/DATABASE.md`、`docs/COMPANY-ENV-PLAN.md`、`docs/TEST-DEPLOY-RUNBOOK.md`、`docs/PROJECT-MAP.md`、`docs/Gherkin/README.md`、`docs/Gherkin/gateway/agent-mtls.feature`、`AGENT.md`、`README.md`
- 驗證:測試區 `https://giganexus-test.gigasolar.com.tw` `/healthz` 200、`/api/auth/me` 401(2026-10-01)。**未改程式**:`nginx/conf.d/agent.conf`、E2E `06-websocket-agent`、`tools/mock-upstream/endpoint.js`、`ENDPOINT_GRPC_UPSTREAM` 仍為 gRPC 版,待 W6-1 訊息協定定版後改寫(ENDPOINT-AGENT-GUIDE §10 G0)

## 2026-09-29 GitLab 與 GitLab Runner 架設手冊(只改文件)
- 內容:需求方開始架設主機 1(Ubuntu,已裝 Docker)與主機 2(Windows)。新增 `docs/GITLAB-SETUP.md`:SSH 金鑰準備、主機 1 以 Docker Compose 安裝 GitLab CE(HTTP、Registry `:5050`、Git SSH `:2222`、資料在 `/srv/gitlab`、備份)、主機 2 以 shell executor + Git Bash 安裝 Runner(`windows-runner`,Windows 服務)、推送專案與第一條 Pipeline 預期調整項目、驗收清單。涉及密碼與 Token 的步驟標示由需求方執行。`COMPANY-ENV-PLAN.md`、`PROJECT-MAP.md` 加上連結。
- 檔案:`docs/GITLAB-SETUP.md`(新增)、`docs/COMPANY-ENV-PLAN.md`、`docs/PROJECT-MAP.md`
- 驗證:主機 1(10.10.130.123,Ubuntu 22.04,4 核 / 7.8 GB)已依 §2.1、§2.3 以 `gitlab/gitlab-ce:19.4.1-ce.0` 啟動,約 90 秒後 `/users/sign_in` 回 200(開發機亦可連線)、Registry `/v2/` 回 401(需認證,正常),啟動後記憶體使用約 4.5 GB。之後需求方要求重建(舊資料改名保留為 `/srv/gitlab/*.old-20260929-1439`),重建後預設分支改 `main`、建立 `giganexus` 下 `giga-api-gateway-bff`、`giga-Portal`、`GigaItApp`、`RustIt` 專案,四個 repo 與工作區文件專案 `giganexusai` 以 `S112009`(claude-ops 金鑰,經 `:2222`)推送,`git ls-remote` 與本機 commit 一致(推送加 `-o ci.skip`,尚無 Runner);§2.5 備份:`backup_keep_time` 7 天、crontab 02:00 資料 / 02:30 設定檔,手動執行一次成功。自行註冊依需求方決定維持開啟;§2.2 防火牆未確認。主機 2(10.10.130.124,Windows 10 專業版 19045,VMware VM,2 核 / 12 GB)需求方決定**不用 Docker Desktop**,§3 改為 WSL2 內的 Docker Engine + Linux 版 Runner;目前巢狀虛擬化未開啟、Docker / Git / Node 皆未安裝,§3 尚未執行

## 2026-09-26 公司測試區手動架設手冊與臨時憑證腳本
- 內容:公司 GitLab / CI / Registry 與 AD CS 憑證尚未就緒,需求方要求先以架設為主。新增 `docs/TEST-DEPLOY-RUNBOOK.md`:在主機 2 以 Git Bash 手動架設 Gateway(主機上 `docker build` 映像、`REGISTRY=giganexus` 本機 tag)→ 員工入口網(`/`、`/login`,沒有它無法登入)→ IT 管理系統,含前置條件、機密檔與 `ldap-domains.json` 格式(原本參照不在版控的 `deploy/dev/config/`)、驗收與常見狀況。新增 `deploy/gen-temp-pki.sh`:產生臨時根 CA、SAN 含主機 IP 的伺服器憑證、臨時 Agent CA 與 CRL(Nginx `:9443` 需要檔案才能啟動)、JWT 金鑰;不覆寫既有檔案。`COMPANY-ENV-PLAN.md` 補 09-26 狀態(giga-Portal 為唯一登入頁、部署順序)、ldap 格式與臨時憑證指向手冊、§6 demo API 決策(測試區保留、正式區關閉);`DEPLOYMENT.md` PRD 版本改 v0.7 並指向手冊。
- 檔案:`docs/TEST-DEPLOY-RUNBOOK.md`(新增)、`deploy/gen-temp-pki.sh`(新增)、`docs/COMPANY-ENV-PLAN.md`、`docs/DEPLOYMENT.md`、`docs/PROJECT-MAP.md`
- 驗證:`gen-temp-pki.sh` 以 `alpine:3.20` 執行產生憑證,`openssl verify` 通過、SAN 含指定 IP;以目前 `nginx/` 建置的映像掛載臨時 `pki/` 執行 `nginx -t`(`GW_ENV=test`)通過。`docker compose --env-file <假 test.env> -f docker-compose.yml -f docker-compose.test.yml --profile tools config` 解析正確(`giganexus/gateway/bff:<tag>`)。手冊步驟未在 Windows 主機實際執行(Git Bash 路徑處理 `pwd -W`、`MSYS_NO_PATHCONV` 依 Git for Windows 行為撰寫)。

## 2026-09-26 專案登記狀態更新:giga-Portal M1、GigaItApp 應用切換(只改文件)
- 內容:`AGENT.md` §10.2 專案登記對齊兄弟專案現況:giga-Portal 前端已建立並發佈到本機 Nginx `/`(取代範例入口網的 `current`,範例的 `releases/dev` 保留可回滾);GigaItApp 頂列已有應用切換。本 repo 程式與設定皆未修改;入口網的本機權限代碼改存於 `../giga-Portal/deploy/gateway-dev-rbac.yaml`(本 repo `deploy/dev/` 不納入版控)。待 Gateway 決定:應用層守衛導回入口網的提示參數,giga-Portal 提議 `/?denied=<應用代碼>`(見 `../giga-Portal/docs/API.md` §2.1),尚未寫入 FRONTEND-GUIDE §7.4。
- 檔案:`AGENT.md`
- 驗證:文件

## 2026-09-26 規格 v0.7:員工入口網(giga-Portal)、依部門與職位指派角色、應用切換
- 內容:**只改規格,尚未實作**(工作項目 P2-3a)。需求方決定員工入口網與 GigaItApp 都用單一入口、畫面權限以 BFF 為唯一來源並由 GigaItApp 設定,職位以職級為主、部門含下層。PRD v0.7(文件版本原停在 v0.5,一併更正):§7.2.1 `/` 由 giga-Portal 發佈(含 `/login` 等)、`/it/` 規劃改單一入口與 `/api/it/*` 經 BFF;§8.2.4 `/api/auth/me` 回傳 `apps`;§8.3.1 角色來源新增指派規則(公司 / 部門含下層 / 職級 / 職稱,AND / OR);新增 §8.3.2 權限分類 `kind`(app / menu / tab / button / api,按鈕 = API 權限)、§8.3.3 應用登記與應用切換;§8.7 新增指派規則、部門樹、應用、權限試算 API,GigaItApp 改以使用者身分呼叫;Q28(已決定)、Q29(職級比較方式)。DATABASE §3.2 新增 `gw.role_rule`、`gw.department`、`gw.app`,`gw.permission` 新增 `kind` / `parent_code` / `sort`,人員同步加入部門樹與職級變更遞增 `pv`。BACKEND-GUIDE v0.4:`x-permissions` 擴充、登記 `portal-api` 51271、`itapp-api` 規劃改經 BFF。FRONTEND-GUIDE v0.2:`me.apps`、§7.4 應用切換與應用層守衛、§7.5 選單 / Tab / 按鈕。IMPL-PLAN 新增 P2-3a;Gherkin 新增 `rbac/role-rules.feature`、`auth/apps.feature`(`@wip`)。AGENT.md §10.1–§10.3 登記 `giga-Portal`,Go Endpoint Server 的資料夾更正為 `giga-endpoint`。
- 檔案:`AGENT.md`、`docs/PRD.md`、`docs/DATABASE.md`、`docs/BACKEND-GUIDE.md`、`docs/FRONTEND-GUIDE.md`、`docs/IMPL-PLAN.md`、`docs/Gherkin/README.md`、`docs/Gherkin/rbac/role-rules.feature`、`docs/Gherkin/auth/apps.feature`
- 驗證:文件;新增 feature 以 `@cucumber/gherkin`(zh-TW)解析通過。migration、BFF 程式、CLI `apps:` 皆未實作

## 2026-09-26 自動註冊自動寫入開發專案;樣本複製後先請工程師命名
- 內容:開發專案改以 `package.json` 的 `"gateway": { "project": "<repo 資料夾名稱>" }` 為唯一來源。Node SDK 0.2.0:`loadGatewayEnv` 讀取 `gateway.project`(新增 `readProject`,缺少或格式錯誤時啟動失敗,**不相容變更**,既有服務升級 SDK 時需補上此欄位)、`autoRegister` 送出前以 `withProject` 自動寫入 `x-gateway.project`(OpenAPI 已手寫且不一致時拒絕)。後端樣本:`package.json` 新增 `gateway.project`、`src/openapi.ts` 移除 `PROJECT` 常數改由設定帶入(`/openapi.json` 也含開發專案,CLI 匯入同樣帶得到)、`src/config.ts` 在 test / prod 仍為樣本值 `node-backend` 時啟動失敗;樣本 `AGENT.md` 新增 §0「複製樣本後的第一步:請工程師命名專案(AI 必須先問)」、README 同步。AGENT.md §10.6、BACKEND-GUIDE §6.1 / §7.5、ENDPOINT-AGENT-GUIDE §8(Go 自行註冊時須帶 `x-gateway.project: giga-endpoint`)同步更新。GigaItApp(`/it/api` 不經 BFF 路由表)、giga-agent-watchdog(不呼叫 BFF HTTP API)沒有自動註冊,未修改;giga-endpoint 尚未實作註冊,未修改。
- 檔案:`sdk/node/src/env.ts`、`sdk/node/src/register.ts`、`sdk/node/src/index.ts`、`sdk/node/package.json`、`samples/node-backend/package.json`、`samples/node-backend/src/config.ts`、`samples/node-backend/src/openapi.ts`、`samples/node-backend/src/app.ts`、`samples/node-backend/test/app.test.ts`、`samples/node-backend/AGENT.md`、`samples/node-backend/README.md`、`AGENT.md`、`docs/BACKEND-GUIDE.md`、`docs/ENDPOINT-AGENT-GUIDE.md`
- 驗證:SDK `tsc --noEmit`、建置通過;樣本 `typecheck` 通過、`npm test` 13 項通過(新增 4 項:讀取 package.json、缺少 / 格式錯誤時啟動失敗、test / prod 沿用樣本值時啟動失敗、以模擬 Gateway 確認註冊內容含 `x-gateway.project` 且手寫不一致時拒絕)。TestGigaAPP 仍使用 vendor 的 SDK 0.1.0,未升級(非本 repo 負責範圍)

## 2026-09-26 上游新增「開發專案」(gw.upstream.project)
- 內容：GigaItApp 的 API 路由頁需要顯示每條路由由哪個下游專案開發,BFF 原本只有 `upstream`(服務代碼)與 `owner`(負責人)。`gw.upstream` 新增 `project VARCHAR(100) NULL`(repo 資料夾名稱,AGENT.md §10.2),migration `20260926011642_upstream_project`。OpenAPI 根層新增選用的 `x-gateway.project`(英數與 `. _ -`,100 字內,格式錯誤列為 `IMPORT_HAS_ERRORS`),匯入 / 自動註冊時寫入上游,未提供時保留既有值;CLI `apply` 的 `upstreams[].project` 同樣可設定。`GET /api/admin/routes/catalog` 回傳 `project`,關鍵字也比對開發專案。`project` 不進路由快照(發佈差異 `upstreamsChanged` 不受影響)。Node SDK `CatalogRoute.project`、`gw-lookup` 顯示「專案」;後端樣本 `src/openapi.ts` 新增 `PROJECT`。PRD v0.6(§8.4.4、§8.7)、DATABASE.md、BACKEND-GUIDE.md v0.3(§6.1、§7.5)、COMPANY-ENV-PLAN、Gherkin `service-registration.feature`(新增 2 個場景)同步更新。GigaItApp 端見該 repo 紀錄。
- 檔案：`bff/src/db/schema/api.ts`、`db/migrations/20260926011642_upstream_project/`、`bff/src/cli/openapi.ts`、`bff/src/cli/index.ts`、`bff/src/modules/admin/route-import.ts`、`bff/src/modules/admin/registration.ts`、`bff/test/unit/openapi.test.ts`、`bff/test/e2e/10-service-registration.test.ts`、`sdk/node/src/client.ts`、`sdk/node/src/lookup-cli.ts`、`samples/node-backend/src/openapi.ts`、`samples/node-backend/test/app.test.ts`、`samples/node-backend/AGENT.md`、`docs/PRD.md`、`docs/DATABASE.md`、`docs/BACKEND-GUIDE.md`、`docs/COMPANY-ENV-PLAN.md`、`docs/Gherkin/router/service-registration.feature`;本機環境(不進版控):`tools/mock-upstream/services.js`(4 個模擬服務 `project: giga-api-gateway-bff`)、`deploy/dev/config/gateway-base.yaml`(`endpoint-api` → `giga-endpoint`)
- 驗證：`npm run db:check-2012` 通過(3 個檔案);`npm test` 69 項、E2E `09-admin-onboarding` + `10-service-registration` 16 項通過(新增:catalog 回傳與比對 `project`、格式錯誤整批拒絕);`typecheck`、`lint`、`prettier --check` 通過;樣本 `npm test` 9 項通過。以 `deploy/dev` 重建映像並執行 `gw-setup`(未重新發佈 SPA),migration 已套用、發佈 v40 的 `upstreamsChanged` 為 false。**未在 SQL Server 2012 實際套用**(同 COMPANY-ENV-PLAN 的 migration 項目)。`dms-api` 由 TestGigaAPP 註冊,該 repo 未加 `x-gateway.project`(非本次負責範圍,不修改),目前顯示為未登記

## 2026-09-26 專案地圖與核心設計原則
- 內容：AGENT.md 新增 §10.7(所有專案共用):每個 repo 都要有 `docs/PROJECT-MAP.md`,**開發新功能後在同一個變更內更新**(內容:定位、目錄職責、分層、主要流程、「要改什麼看哪裡」、測試地圖、已知差異);核心設計原則(職責分離、原始碼固定根目錄、集中測試管理)依語言分類落實(TypeScript / Node.js、Vue、Go、C#、Rust、Nginx 與腳本),語言慣例優先(例:Go 不用 `src/`、`_test.go` 與程式同目錄),既有程式不為符合原則大規模搬移。§7 參考文件、§5 慣例、§9 修正紀錄、§10.6 新專案 AGENT.md 必備項目同步加入專案地圖。新增本 repo 的 `docs/PROJECT-MAP.md`。GigaItApp、giga-agent-watchdog、giga-endpoint 的地圖見各 repo 紀錄。
- 檔案：`AGENT.md`、`docs/PROJECT-MAP.md`
- 驗證：文件;地圖目錄與 `git ls-files` 對照

## 2026-09-25 多專案工作區規則;端點 API 本機打通
- 內容：AGENT.md 新增 §10「多專案工作區」:Gateway、GigaItApp、Go Endpoint Server、其他系統的 repo 放在同一層目錄,以 `../<資料夾>/` 相對路徑互相參照;專案登記表、相依關係、**用 BFF 路由表找 API**(lookup CLI / `GET /api/admin/routes/catalog`,不直接讀對方程式碼或連對方主機)、跨 repo 修改規則、新專案 AGENT.md 必備內容;後端樣本 AGENT.md 加上指向 §10。本機環境打通 IT 頁面取得 Agent 基本資料:模擬 Endpoint Server 記錄經 :9443 連線的 Agent 並提供 `GET /v1/devices`,dev 設定新增權限 `endpoint.device.read`(角色 it-endpoint)與路由 `endpoint.device.list`(`GET /api/endpoint/devices`);E2E 新增 2 項。GigaItApp 端的修改見該 repo 的紀錄。
- 檔案：`AGENT.md`、`samples/node-backend/AGENT.md`、`bff/test/e2e/06-websocket-agent.test.ts`;`tools/mock-upstream/endpoint.js`、`deploy/dev/config/gateway-base.yaml`、`deploy/dev/config/gateway-routes.yaml`(本機環境,不進版控)
- 驗證：重建 mock-upstream 映像並重跑 gw-setup(發佈);`06-websocket-agent` 22 項通過(S100001 取得 PC-001 且在線、S112009 403);`lookup-cli.js` 可由上一層相對路徑執行;以登入者呼叫 `/api/admin/routes/catalog?q=endpoint` 查得 `endpoint.device.list`(published)

## 2026-09-25 端點管理以 BFF 為準;指令派送設計
- 內容：決定 IT 管理系統(GigaItApp)的端點管理功能以 **BFF 權限為準**(PRD Q27、ARCHITECTURE D9):IT 前端經 `/api/endpoint/*` → BFF → Go Endpoint Server,itapp-api(Node.js)只負責 IT 應用的選單、Tab、按鈕顯示權限,不轉送端點 API;Go 與 Node.js 兩個後端並行。ENDPOINT-AGENT-GUIDE 新增 §8(v0.2):分工、權限代碼 `endpoint.device.read` / `endpoint.command.basic` / `endpoint.command.admin`(依風險拆路徑,BFF 一條路由只檢查一個權限)、API 草案、指令類型、指令狀態與派送規則(先寫入再推送、有效期限、至少送達一次 + `commandId` 去重、結果先輪詢)、Agent 串流訊息草案、稽核欄位、GigaItApp 前端規則(web-kit、Gateway 登入者與 itapp 登入者同一工號、按鈕顯示取兩邊權限交集);新增待決事項 E6(資料範圍)、E7(指令類型)。原 §8–§10 順延為 §9–§11。
- 檔案：`docs/ENDPOINT-AGENT-GUIDE.md`、`docs/PRD.md`、`docs/ARCHITECTURE.md`、`AGENT.md`
- 驗證：文件變更,未修改程式;GigaItApp 專案(`../GigaItApp`)的文件與前端尚未依此調整

## 2026-09-25 Go Endpoint Server 與端點 Agent 開發手冊
- 工作項目：W3-3(通道);W6 開發規範
- 內容：新增 `docs/ENDPOINT-AGENT-GUIDE.md`:`:9443` 通道規格(轉送標頭、逾時、串流數上限、被拒時的 gRPC 狀態碼)、裝置憑證(網域電腦自動註冊、非網域電腦 `certreq` 流程、以完整 DN 識別裝置)、Go Endpoint Server 與 Go Agent 規範(應用層心跳、撤銷、訊息大小、proto 相容性)。新增 **C# Watchdog** 通道設計:與 Agent 以具名管道 gRPC 溝通(ACL 限 SYSTEM / Administrators、比對伺服端 PID),並以同一張電腦憑證經 `:9443` 自行上報(`giganexus.watchdog.v1`,Nginx 不需調整);建議的升級流程。列出 Gateway 未完成項目(CRL 更新、來源 IP、壓測)與待決事項 E1–E5。PRD §7.6、ARCHITECTURE T8、BACKEND-GUIDE、AGENT.md、README 加上連結。
- 檔案：`docs/ENDPOINT-AGENT-GUIDE.md`、`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/BACKEND-GUIDE.md`、`AGENT.md`、`README.md`
- 驗證：§5、§6 的 Go 寫法已經本機 Nginx 實測(見後端修改紀錄同日項目);C# 與 Windows 憑證存放區的寫法未實測(本機無 .NET / Windows),文件內已標示

## 2026-09-25 IT 管理系統(GigaItApp)取代範例 IT 頁面
- 內容：`/it/` 改由獨立專案 GigaItApp 提供:自有登入(不共用單一入口)、職級 × 部門按鈕權限、儀表板、BFF 服務 / 路由 / 發佈版本與 BFF 角色權限的視覺化與設定(BFF 尚無寫入 API 的部分明確回「尚未開放」)。Gateway 端只新增 Nginx `/it/api/` 轉送與部署設定,細節見後端修改紀錄同日項目與 GigaItApp `README.md`。
- 檔案：`nginx/`、`deploy/`、`docs/`;GigaItApp `backend/`、`frontend/`、`deploy/`
- 驗證：見後端修改紀錄同日項目與 GigaItApp `docs/DevelopmentProcess/NewFeatures.md`

## 2026-09-25 後端自動註冊、路由查詢、Node.js SDK 與樣本
- 工作項目：W3-5.7a
- 內容：`gw.api_route` 新增 `gherkin`(行為規格),`description` 作為 API 用途說明,兩者由 OpenAPI 的 `description`、`x-gherkin` 匯入;後端以 API Key 呼叫 `POST /api/admin/registrations`,在 test / prod 啟動時自動註冊為草稿(不自動發佈,只能註冊自己的服務);`GET /api/admin/routes/catalog` 查詢既有路由避免重複開發;新增 `@giganexus/backend-sdk`(`sdk/node`:`GW_ENV=dev|test|prod` 設定、Token 驗證、自動註冊、`gw-lookup`)與 Node.js 後端樣本(`samples/node-backend`,含專用 AGENT.md)。規格同步修訂:PRD v0.5(Q3 改為兩區設定不互通,取消匯出 / 匯入)、BACKEND-GUIDE §7.5。
- 檔案：`bff/src/modules/admin/registration.ts`、`bff/src/modules/admin/route-import.ts`、`bff/src/modules/auth/api-key.ts`、`sdk/node/`、`samples/node-backend/`、`docs/`
- 驗證：BFF `npm test` 62 項、`test:int` 15 項、`test:e2e` 124 項全部通過(新增 10-service-registration 9 項);樣本 `npm test` 9 項通過;本機以 `GW_ENV=test` 啟動樣本 → 自動註冊 4 筆草稿 → `gw-lookup` 查得說明與 Gherkin → CLI 發佈 → 經 Gateway 以 S112009 呼叫 `/api/sample/me` 回 200(內部 Token 驗證成功)、`/api/sample/items` 回 403(未授權)→ 重啟後註冊為「不變」;驗證資料已刪除並重新發佈。無前端畫面變更,未做瀏覽器操作

## 2026-09-25 IT 管理 demo:新員工上手導覽
- 內容：`/it/` 改為 IT 新員工上手版本:架構總覽(一個請求怎麼走、資料放在哪裡)、31 張資料表依 5 類說明用途 / 重要欄位 / 誰寫入 / 誰使用並可看實際資料、API 上架演練 7 步驟(流程與分工、登記上游、OpenAPI 匯入預覽、手動新增預覽、權限反查、發佈說明、實際呼叫驗證)。全部為預覽,不寫入資料庫。
- 檔案：`bff/src/modules/admin/onboarding.ts`、`tools/sample-spa/it/`
- 驗證：E2E 189 項通過(新增 09-admin-onboarding 6 項,含「預覽後 gw.api_route、gw.upstream 無新增資料」);瀏覽器操作 7 個步驟皆正常

## 2026-09-24 IT 管理介面 demo:資料庫檢視
- 內容：新增 `/it/` 範例 SPA,唯讀瀏覽 `giganexus_gw` 各資料表(左側資料表與筆數、右側分頁資料);後端 `/api/admin/db/*` 依表對應 `gw.admin.*.read` 權限,不回傳密碼 / Token / API Key 雜湊。demo 用途,非 PRD §8.7 正式管理 API,僅 dev / test 註冊。
- 檔案：`bff/src/modules/admin/db-viewer.ts`、`tools/sample-spa/it/`
- 驗證：`npm test`、`npm run test:e2e` 全部 183 項通過(新增 08-admin-db-viewer 4 項)

## 2026-09-24 本機完整環境與 E2E 測試
- 內容：`deploy/dev/up.sh` 一鍵啟動 Nginx、BFF ×2、Redis、SQL Server(含 LOS / BPM / PortalSolar 模擬資料)、模擬 AD、模擬下游後端與範例 SPA;E2E 測試經 Nginx 驗證 Gherkin 場景。
- 檔案：`deploy/`、`tools/`、`bff/test/e2e/`
- 驗證：刪除資料後重建並執行全部測試,179 項通過

## 2026-09-24 W3-5 動態路由、聚合與發佈同步
- 工作項目：W3-5.1–5.7
- 內容：路由快照三層載入(Redis → SQL Server → 本地檔)、find-my-way 路由樹原子替換、proxy / aggregate / mock、路由限流、GET 快取、逾時、冪等重試、斷路器;發佈 / 回滾 / 60 秒補償;CLI 由 OpenAPI 匯入路由。
- 檔案：`bff/src/modules/router/`、`bff/src/db/sync/release.ts`、`bff/src/cli/`

## 2026-09-24 W3-4 身分驗證與 RBAC
- 工作項目：W3-4.2–4.12、4.14、4.15、4.6c
- 內容：AD 三網域登入(公司網域順序、巢狀群組、AD 錯誤碼)、本機帳號(Argon2id、10 次鎖定、IT 代建啟用連結、限定變更密碼憑證)、JWT Cookie、Refresh Rotation 與重用偵測、CSRF、權限計算與快取、內部 Token / JWKS、登入補查 BPM / LOS。
- 檔案：`bff/src/modules/auth/`、`bff/src/modules/rbac/`

## 2026-09-24 W3-2 / W3-3 Nginx
- 工作項目：W3-2.1–2.7、W3-3.1–3.3
- 內容：`:80` 轉址、`:443` TLS 1.2/1.3、SPA 子路徑、`/api`、WebSocket、`auth_request`、Webhook 白名單、統一 JSON 錯誤、登入限流;`:9443` Agent mTLS + CRL + gRPC。
- 檔案：`nginx/`

## 2026-09-24 W3-1 專案骨架與 Drizzle PoC
- 工作項目：W3-1.1–1.5
- 內容：`gw.*` Drizzle schema、初版 migration、seed、SQL Server 2012 語法檢查(靜態 + 執行期)、PoC 整合測試。
- 檔案：`bff/src/db/`、`db/`
- 驗證：容器 SQL Server 2022(相容層級 110)預驗通過;待 SQL Server 2012 複驗(M0)
