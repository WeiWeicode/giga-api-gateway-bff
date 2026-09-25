# 後端修改紀錄

> 新紀錄加在最上方;範圍 `bff/`、`nginx/`、`db/`、`deploy/`;格式見 `AGENT.md` §9。

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
