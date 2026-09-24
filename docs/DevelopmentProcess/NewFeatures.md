# 新增功能紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §9。

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
