# 後端修改紀錄

> 新紀錄加在最上方;範圍 `bff/`、`nginx/`、`db/`、`deploy/`;格式見 `AGENT.md` §9。

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
