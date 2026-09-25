# 後端修改紀錄

> 新紀錄加在最上方;範圍 `bff/`、`nginx/`、`db/`、`deploy/`;格式見 `AGENT.md` §9。

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
