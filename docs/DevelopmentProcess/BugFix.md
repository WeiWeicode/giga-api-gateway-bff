# Bug 修改紀錄

> 新紀錄加在最上方;格式見 `AGENT.md` §9。

## 2026-09-25 範例後端 build 因未設 rootDir 失敗
- 內容：TypeScript 6 在有 `outDir` 時要求明確設定 `rootDir`,`samples/node-backend` 的 `npm run build` 回 TS5011;`typecheck` 用 `--noEmit` 不受影響,只在建置(如 Docker image)時出錯。`tsconfig.build.json` 加上 `rootDir: "."`,輸出維持 `start` 所需的 `dist/src/server.js`。`sdk/node`(`rootDir: "src"`)與 `bff/`(`rootDir: ".."`)已明確設定,不受影響。
- 檔案：`samples/node-backend/tsconfig.build.json`
- 驗證：`npm run build && ls dist/src/server.js` 成功;`npm run typecheck` 通過、`npm test` 9 項通過;`sdk/node`、`bff` 的 `npm run build` 皆成功

## 2026-09-24 Agent 憑證簽發者檢查誤擋有效憑證
- 工作項目：W3-3.1
- 內容：`openssl ca` 依 policy 重排 DN,中繼 CA 的 `$ssl_client_i_dn` 為 `O=GigaNexus Dev,CN=GigaNexus Agent CA (dev)`,與 allowlist 寫的順序不同,有效憑證被回 403。修正 allowlist 並加註取得確切字串的指令。
- 檔案：`nginx/allowlists/*/agent-issuers.conf`
- 驗證：`npm run test:e2e`(06-websocket-agent)12 項通過

## 2026-09-24 YAML 的 AD 群組 DN 被逗號拆開
- 內容：`adGroups: [CN=...,OU=...]` 在 YAML flow 語法中被拆成多個值,AD 群組對應不到角色。改為區塊清單並加引號,檔頭加註。
- 檔案：`deploy/dev/config/gateway-routes.yaml`
- 驗證：S100001 登入取得 `mes-operator`、`gw-it-admin`、`it-endpoint`

## 2026-09-24 /_auth/verify 對外回 HTML 404
- 工作項目：W3-2.6
- 內容：internal location 被外部存取時 Nginx 回預設 HTML,改為 `error_page 404 = @route_not_found` 回統一 JSON。
- 檔案：`nginx/conf.d/portal.conf`、`nginx/snippets/json-errors.conf`
- 驗證：`npm run test:e2e`(01-nginx-entry)14 項通過

## 2026-09-24 SPA 深層頁面重新整理回 404
- 工作項目：W3-2.3
- 內容：`alias` 搭配 `try_files` 的回退 URI 有已知問題,`/mes/work-orders/123` 回 404。改以 named location(`root` + `try_files /index.html`)回傳該系統的 index.html。
- 檔案：`nginx/conf.d/portal.conf`
- 驗證：`curl https://localhost/mes/work-orders/123` → 200、`Cache-Control: no-cache`

## 2026-09-24 本機 Redis port 與既有服務衝突
- 內容：本機已有 Homebrew redis 佔用 `localhost:6379`,BFF 實際連到它而非容器,`/readyz` 無法反映容器狀態。開發環境 Redis 改對外 `127.0.0.1:16379`。
- 檔案：`deploy/docker-compose.dev.yml`、`bff/.env.example`
- 驗證：停止 Redis 容器後 `/readyz` 回 503,恢復後回 200

## 2026-09-24 zod 布林預設值未轉換
- 內容：`bool.default('false')` 在 zod 4 會直接回傳字串,tedious 報 `encrypt` 型別錯誤。改為 `default(false)`。
- 檔案：`bff/src/config.ts`
- 驗證：`npm run db:migrate` 成功

## 2026-09-24 初版 migration 的 FK 早於唯一索引
- 工作項目：W3-1.4
- 內容：drizzle-kit 先建 FK 再建唯一索引,參照 `gw.permission(code)` 的 FK 會失敗。人工調整為「資料表 → 索引 → FK」,並記錄於 migration 檔頭與 TECH-STACK §4.1。
- 檔案：`db/migrations/20260924114259_init/migration.sql`
- 驗證：`npm run db:migrate` 重複執行成功;`npm run test:int` 通過
