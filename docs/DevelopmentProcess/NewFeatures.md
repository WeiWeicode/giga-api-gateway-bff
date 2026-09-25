# 新增功能紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §9。

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
