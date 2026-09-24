# GigaNexus Gateway 開發手冊 (AGENT.md)

> 本文件是 AI 程式助手（如 Claude、Gemini）在本專案中的行為準則。
> 所有 AI 協作開發必須遵守以下規範。

---

## 1. 先思考再動手

### 規則
- **動手之前，先說明你的理解與假設**。用 1-3 句話摘要你打算做什麼、為什麼這樣做。
- **有任何疑問，先問，不要猜**。錯誤的假設比多問一個問題代價高得多。
- 如果需求模糊或有多種解讀方式，列出你看到的選項，讓人類選擇。
- 規格以 `docs/` 為準；程式與規格不一致時，先指出差異，不要自行決定以哪一邊為準。

### 範例
```
❌ 錯誤：直接開始寫 Webhook 模組
✅ 正確：「我理解你要實作 /webhook/bpm 的驗簽（W3-5.10）。
    我假設密鑰依 gw.webhook_endpoint.secret_ref 從 Docker secret 讀取，
    事件先寫入 gw.webhook_log 再排入佇列，不在請求內同步處理。這樣對嗎？」
```

---

## 2. 簡單優先

### 規則
- **用最少的程式碼解決當前問題**，不要加用不到的功能。
- 不要「順便」引入新的套件、設計模式或抽象層，除非任務明確要求。新增套件前先確認 `docs/TECH-STACK.md` 是否已列出。
- 不要寫「未來可能用到」的程式碼。等需要的時候再加（例如 LINE 通知已暫緩，不要預先建立欄位或程式）。
- 如果一個問題能用 10 行解決，不要寫 50 行。

### 範例
```
❌ 錯誤：為了讀一個設定值，建立 ConfigProvider + Strategy Pattern
✅ 正確：在 bff/src/config.ts 的 zod schema 加一個欄位
```

---

## 3. 外科手術式修改

### 規則
- **只改必須改的地方**。不要順手「整理」、「重構」或「優化」不相關的程式碼。
- 不要改動現有的程式碼格式（縮排、空行、引號風格），除非那就是你的任務。格式一律交給 Prettier。
- 不要重新命名你沒被要求改的變數、函式、資料表或欄位。
- **不要修改已套用的 migration**（`db/migrations/*`）；資料表變更一律新增 migration。
- 每次修改都應該能用一句話解釋為什麼改。

### 範例
```
❌ 錯誤：修斷路器 bug 的同時，把 upstream.ts 的 import 重新排序、改掉變數名稱
✅ 正確：只修改造成 bug 的那幾行，其他一字不動
```

---

## 4. 目標導向執行

### 規則
- **先定義成功標準**：在開始之前，明確說出「做到什麼程度算完成」，優先對應 `docs/IMPL-PLAN.md` 的驗收條件與 `docs/Gherkin/*.feature` 場景。
- 自己迭代直到達成目標，不要每做一步就停下來問。
- 如果遇到阻塞（缺少資訊、權限不足、前置工作 P-xx 未就緒），才停下來回報。
- 完成時，簡要說明做了什麼、驗證了什麼（執行了哪些指令、結果如何）。

### 範例
```
❌ 錯誤：「我已經寫好登入 API，你要不要看一下再繼續？」
✅ 正確：「我完成了 /api/auth/password/forgot 與 /reset（W3-5.8b），
    錯誤代碼符合 PRD §8.1.1，npm run lint、typecheck、test 全部通過，
    新增的 3 個 E2E 場景對應 password-reset.feature。」
```

---

## 5. 尊重既有風格

### 規則
- **遵循現有程式碼的命名規範、寫法與慣例**，不要悄悄引入自己的風格。
- 新增程式碼前，先看同目錄下的現有檔案，學習它的風格。
- 保持一致性比「更好的寫法」更重要。

### 本專案慣例
| 項目 | 規範 |
|:---|:---|
| BFF 語言 / 框架 | TypeScript（ESM、`strict`）+ Fastify 5；功能以 plugin 組織（`fastify-plugin`），放在 `bff/src/modules/<模組>/` |
| TS 命名 | 變數 / 函式 `camelCase`，型別 / 類別 `PascalCase`，常數 `UPPER_SNAKE_CASE`，檔名 `kebab-case.ts` |
| 資料庫 | SQL Server 2012，schema `gw`，資料表與欄位 `snake_case`；Drizzle schema 屬性用 `camelCase` 對應 |
| SQL 相容性 | 只用 2012 支援的語法（`docs/DATABASE.md` §0）；不可用 JSON 函式、`CREATE OR ALTER`、`DROP … IF EXISTS`、`STRING_AGG`、`TRIM` 等 |
| Migration | `npm run db:generate` 產生後**人工審查**並執行 `npm run db:check-2012`；禁止 `drizzle-kit push` |
| 設定與同步 | 先提交資料庫、再更新 Redis（`docs/DATABASE.md` §7）；Redis 鍵一律 `gw:` 開頭並登記於 §6 |
| API 路徑 | 對外 `/api/{system_code}/{resource}`，資源名詞複數、kebab-case；`/api/auth/*`、`/api/admin/*` 為 BFF 內建 |
| 權限 / 路由代碼 | `{system}.{resource}.{action}`，例如 `mes.workorder.read` |
| 錯誤回應 | `{ code, message, requestId, details? }`；`code` 大寫蛇形，**新增代碼須先更新 PRD §8.1.1** |
| 前端 | Vue 3 Composition API（`<script setup lang="ts">`）+ Vite + vue-router（History 模式）；HTTP 一律走 `@giganexus/web-kit` |
| Nginx | 有 `add_header` 的 location 必須 `include snippets/security-headers.conf`；依部署區不同的值放 `templates/` 或 `allowlists/<區域>/` |
| 機密 | 不入版控、不寫進映像檔；以 `<NAME>_FILE` 指向 Docker secret |
| 下游後端 port | 51200–51300（`docs/BACKEND-GUIDE.md` §3） |
| 格式 | Prettier（單引號、`printWidth` 160、尾逗號）+ ESLint；送出前執行 `npm run lint`、`npm run format:check` |
| 註解語言 | 繁體中文為主，註明對應規格章節（例：`(PRD §8.2.5)`）；同一檔案內統一 |

### 範例
```
❌ 錯誤：現有程式碼用 camelCase，你卻寫 snake_case 的 TS 變數
❌ 錯誤：在 SQL 用 JSON_VALUE 查 gw.api_route.request_headers_add
✅ 正確：看到 buildSnapshotContent() 就寫 buildReleaseDiff()，JSON 在應用層解析
```

---

## 6. 失敗要明確說

### 規則
- **失敗就說失敗**，不能把「靜默跳過」包裝成「任務完成」。
- 如果某個步驟做不到、某個 API 回傳錯誤、某段程式碼無法通過測試，必須明確告知並附上錯誤訊息。
- 不要用空的 `catch {}` 吞掉錯誤；確實要降級時（例如 Redis 不可用）必須記錄 log，並在程式註解說明依據的規格。
- 不要刪掉或放寬失敗的測試案例來讓測試「通過」。
- 只在容器 SQL Server（2022）驗證過的項目，不可宣稱「已在 SQL Server 2012 驗證」。

### 範例
```
❌ 錯誤：「已完成部署」（實際上 bff-2 的 /readyz 一直回 503 但沒提）
❌ 錯誤：LDAP 連線失敗時回傳空群組，讓登入看起來成功
✅ 正確：「npm run test:e2e 共 99 項，1 項失敗：斷路器測試預期 503 但得到 200，
    原因是該路由有 30 秒 GET 快取，請求沒有打到上游。已改用不快取的路由驗證。」
```

---

## 7. 專案參考文件

開發前請先閱讀以下文件，確保理解專案全貌：

| 文件 | 路徑 | 說明 |
|:---|:---|:---|
| 產品需求 | `docs/PRD.md` | 功能需求、錯誤代碼總表（§8.1.1）、待決事項 |
| 整體架構 | `docs/ARCHITECTURE.md` | 流量類型（T1–T9）與關鍵架構決策（D1–D8） |
| 資料庫設計 | `docs/DATABASE.md` | SQL Server 2012 限制、`gw.*` 資料表、Redis 鍵、同步規則、BPM / LOS |
| 技術棧 | `docs/TECH-STACK.md` | 技術選型、專案結構、ORM 注意事項與 PoC 紀錄 |
| 實作計畫 | `docs/IMPL-PLAN.md` | 工作項目（W3-x.n）、前置工作、驗收條件、完成定義 |
| 前端規範 | `docs/FRONTEND-GUIDE.md` | SPA 子路徑、web-kit、登入與權限 |
| 後端規範 | `docs/BACKEND-GUIDE.md` | 下游 port、內部 Token、OpenAPI 上架 |
| 部署 | `docs/DEPLOYMENT.md` | CI/CD、各元件部署與回滾、機密 |
| 上公司環境清單 | `docs/COMPANY-ENV-PLAN.md` | 從本機測試環境部署到測試區 / 正式區需調整的檔案 |
| 既有專案參考 | `docs/REFERENCES.md` | GeneralBackend、舊單一入口 |
| 驗收場景 | `docs/Gherkin/*.feature` | 各功能的驗收行為（標籤對應 IMPL-PLAN 工作項目） |

---

## 8. 技術棧速查

| 層級 | 技術 |
|:---|:---|
| 反向代理 | Nginx 1.26+（TLS、HTTP/2、gRPC、mTLS、`auth_request`） |
| BFF | Node.js 22 LTS + TypeScript + Fastify 5 |
| 主要套件 | `drizzle-orm` + `mssql`、`ioredis`、`jose`、`ldapts`、`undici`、`find-my-way`、`@node-rs/argon2`、`zod`、`pino` |
| 應用資料庫 | SQL Server 2012 Standard（`giganexus_gw`，內網不加密） |
| 外部人事資料 | BPM（SQL Server 2019，唯讀、加密）、LOS / PortalSolar（SQL Server 2012，唯讀） |
| 快取 / 佇列 | Redis 7 |
| 前端 | Vue 3 + Vite + vue-router + `@giganexus/web-kit` |
| 測試 | Vitest（單元 / 整合 / E2E）、k6（壓測） |
| 部署 | Docker Compose、GitLab CI/CD、Docker Desktop（Windows 主機） |

### 常用指令（在 `bff/` 下執行）
| 指令 | 說明 |
|:---|:---|
| `npm run lint` / `typecheck` / `format:check` | 程式檢查 |
| `npm test` / `npm run test:int` / `npm run test:e2e` | 單元 / 整合 / 端到端測試（E2E 需先 `sh deploy/dev/up.sh`） |
| `npm run db:generate` / `db:check-2012` / `db:migrate` | Migration 產生、2012 語法檢查、套用 |

---

## 9. 修正紀錄

Bug 修改紀錄與新增功能紀錄、前端修改紀錄、後端修改紀錄：
1. 可以使用瀏覽器驗證並測試；有前端畫面或使用者操作流程的修改，完成後應以瀏覽器實際操作確認，並在回報與紀錄中說明操作了哪些步驟、結果如何。lint、型別檢查與自動化測試仍需執行並回報結果。
   - 本機測試環境（`tools/`、`deploy/dev/` 等）只存在開發主機、不進版控，不可將其內容加入 git。
   - 本機環境使用開發用自簽憑證，瀏覽器若無法直接開啟 `https://localhost`，改以 Vite dev server 經 proxy 連 Gateway（FRONTEND-GUIDE.md §8），例如 `cd tools/sample-spa && npx vite -c vite.it.config.ts` 後開啟 `http://localhost:5175/it/`。
   - 測試帳號見 `README.md`（密碼 `Passw0rd!`，皆為虛構資料）；不可在瀏覽器輸入真實帳密。
2. 每次修正都需留紀錄，新紀錄加在檔案最上方。

| 文件 | 路徑 | 說明 |
|:---|:---|:---|
| Bug修改紀錄 | `docs/DevelopmentProcess/BugFix.md` | Bug修改紀錄 |
| 新增功能紀錄 | `docs/DevelopmentProcess/NewFeatures.md` | 新增功能紀錄 |
| 前端修改紀錄 | `docs/DevelopmentProcess/FrontendCorrection.md` | 前端修改紀錄（`web-kit/`、`tools/sample-spa/`） |
| 後端修改紀錄 | `docs/DevelopmentProcess/BackendCorrection.md` | 後端修改紀錄（`bff/`、`nginx/`、`db/`、`deploy/`） |

### 紀錄格式
```
## YYYY-MM-DD 標題
- 工作項目：W3-x.n（無則省略）
- 內容：改了什麼、為什麼
- 檔案：主要修改的檔案
- 驗證：執行的指令與結果
```
