# 前端修改紀錄

> 新紀錄加在最上方;範圍 `web-kit/`、`tools/sample-spa/`;格式見 `AGENT.md` §9。

## 2026-09-25 IT 管理 demo 改為新員工上手版本
- 內容：新增架構總覽頁(`Overview.vue`)、上架演練頁(`Onboarding.vue`,範例為新服務 core-fms)、資料表說明資料(`tableDocs.ts`);資料表頁改為依分類列出並在資料上方顯示說明。
- 檔案：`tools/sample-spa/it/src/`、`tools/sample-spa/shared/style.css`
- 驗證：`npx vue-tsc --noEmit`、`npm run build` 通過;瀏覽器(Vite proxy,`http://localhost:5175/it/`)以 S100001 操作:總覽、`gw.api_route` 說明與 22 筆資料、上架演練 7 步驟(FMS 預覽新增 4 筆、加入錯誤範例顯示「錯誤 1、不可提交」、MES 規格顯示不變 / 更新:name、手動新增路徑衝突、反查 mes.workorder.read 與不存在的 fms.invoice.read、呼叫已上線路由 200 與未上架 FMS 404)。操作中發現並修正:資料表頁有說明時資料表格不顯示(`v-else-if` 接錯對象)、缺少 x-permission 的項目未列入預覽表格與錯誤計數

## 2026-09-24 新增 IT 管理介面 demo(/it/)
- 內容：`tools/sample-spa/it/`(base `/it/`,輸出至 `dist/it-admin` 對應 Nginx 的 `/srv/www/it-admin/current`),資料表清單與分頁表格,長字串截斷顯示;入口網選單加「IT 管理」連結。
- 檔案：`tools/sample-spa/it/`、`tools/sample-spa/vite.it.config.ts`、`tools/sample-spa/package.json`、`tools/sample-spa/tsconfig.json`、`tools/sample-spa/portal/src/App.vue`
- 驗證：`npx vue-tsc --noEmit`、`npm run build` 通過;瀏覽器(Vite proxy,`http://localhost:5175/it/`)以 S100001 登入:31 張資料表與筆數正確、`gw.user` 資料顯示、`gw.auth_log` 翻到第 2 / 10 頁、`gw.local_credential` 無密碼雜湊欄位;以 S112009 登入顯示 PERMISSION_DENIED

## 2026-09-24 建立 @giganexus/web-kit 與範例 SPA
- 工作項目：W3-4.13
- 內容：web-kit 提供 HTTP client(CSRF、401 自動 Refresh)、`useAuth` / `can`、路由守衛;範例 SPA 為入口網(`/`,含 `/login`、變更密碼、啟用帳號)與 MES 看板(`/mes/`)。
- 檔案：`web-kit/src/`、`tools/sample-spa/`
- 驗證：`npx vue-tsc --noEmit`、`npm run build` 通過
