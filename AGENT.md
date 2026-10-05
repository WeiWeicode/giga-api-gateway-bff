# GigaNexus Gateway 開發手冊 (AGENT.md)

> 本文件是 AI 程式助手（如 Claude、Gemini）在本專案中的行為準則。
> 所有 AI 協作開發必須遵守以下規範。
> 本專案與 GigaItApp、giga-Portal、RustIt(Endpoint Server + Agent)等專案**放在同一層目錄、互相依賴**,跨專案的規則見 **§10 多專案工作區**;其他專案的 AGENT.md 也以 §10 為準。
> **AI 分工**:寫程式、寫測試、寫文件由 Claude 負責;Gemini 只執行測試、寫報告與做非邏輯性修改,不能動 CI/CD、Docker — 見 **§10.8**。

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
✅ 正確：「我理解你要實作 /webhook/{source} 的驗簽（W3-5.10）。
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
| 權限 / 路由代碼 | `{system}.{resource}.{action}`，例如 `mes.workorder.read`；API 權限讀 / 寫分開。畫面節點（目錄 / 選單 / Tab / 按鈕）由前端應用 `gateway-rbac.yaml` 登記並以 `includes` 綁定 API，登記後以 GigaItApp「選單管理」為準（PRD §8.3.2、FRONTEND-GUIDE §7.5） |
| 錯誤回應 | `{ code, message, requestId, details? }`；`code` 大寫蛇形，**新增代碼須先更新 PRD §8.1.1** |
| 前端 | Vue 3 Composition API（`<script setup lang="ts">`）+ Vite + vue-router（History 模式）；HTTP 一律走 `@giganexus/web-kit` |
| Nginx | 有 `add_header` 的 location 必須 `include snippets/security-headers.conf`；依部署區不同的值放 `templates/` 或 `allowlists/<區域>/` |
| 機密 | 不入版控、不寫進映像檔；以 `<NAME>_FILE` 指向 Docker secret |
| 下游後端 port | 51200–51300（`docs/BACKEND-GUIDE.md` §3） |
| 格式 | Prettier（單引號、`printWidth` 160、尾逗號）+ ESLint；送出前執行 `npm run lint`、`npm run format:check` |
| 註解語言 | 繁體中文為主，註明對應規格章節（例：`(PRD §8.2.5)`）；同一檔案內統一 |
| 目錄與分層 | 依 §10.7.2 的 TypeScript / Vue / Nginx 列；各目錄職責見 `docs/PROJECT-MAP.md`，**新功能完成後更新地圖** |

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
| **專案地圖** | `docs/PROJECT-MAP.md` | 目錄與檔案職責、分層、主要流程、「要改什麼去哪裡」;**開發新功能後必須更新**(§10.7) |
| 產品需求 | `docs/PRD.md` | 功能需求、錯誤代碼總表（§8.1.1）、待決事項 |
| 整體架構 | `docs/ARCHITECTURE.md` | 流量類型（T1–T9）與關鍵架構決策（D1–D9） |
| 資料庫設計 | `docs/DATABASE.md` | SQL Server 2012 限制、`gw.*` 資料表、Redis 鍵、同步規則、BPM / LOS |
| 技術棧 | `docs/TECH-STACK.md` | 技術選型、專案結構、ORM 注意事項與 PoC 紀錄 |
| 實作計畫 | `docs/IMPL-PLAN.md` | 工作項目（W3-x.n）、前置工作、驗收條件、完成定義 |
| 前端規範 | `docs/FRONTEND-GUIDE.md` | SPA 子路徑、web-kit、登入與權限 |
| 後端規範 | `docs/BACKEND-GUIDE.md` | 下游 port、內部 Token、OpenAPI 上架 |
| 端點 Agent 通道 | `docs/ENDPOINT-AGENT-GUIDE.md` | RustIt 的 Endpoint Server、Rust Agent、Watchdog:`:9443` HTTPS / WebSocket 通道、裝置憑證、本機具名管道 |
| 部署 | `docs/DEPLOYMENT.md` | CI/CD、各元件部署與回滾、機密 |
| 公司環境清單 | `docs/COMPANY-ENV-PLAN.md` | 部署到測試區 / 正式區需調整的檔案與前置工作 |
| 既有專案參考 | `docs/REFERENCES.md` | GeneralBackend、舊單一入口 |
| 下游後端樣本 | `samples/node-backend/AGENT.md` | Node.js 後端樣本與 SDK(`sdk/node`)的 AI 協作準則:新增 API 前先查既有路由、GW_ENV、自動註冊 |
| 驗收場景 | `docs/Gherkin/*.feature` | 各功能的驗收行為（標籤對應 IMPL-PLAN 工作項目） |

---

## 8. 技術棧速查

| 層級 | 技術 |
|:---|:---|
| 反向代理 | Nginx 1.26+（TLS、HTTP/2、WebSocket、mTLS、`auth_request`） |
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
| `npm test` / `npm run test:int` / `npm run test:e2e` | 單元 / 整合 / 端到端測試（E2E 對測試區執行，需 `ssh host2`，見 README「測試」） |
| `npm run db:generate` / `db:check-2012` / `db:migrate` | Migration 產生、2012 語法檢查、套用 |

---

## 9. 修正紀錄

Bug 修改紀錄與新增功能紀錄、前端修改紀錄、後端修改紀錄：
1. 可以使用瀏覽器驗證並測試；有前端畫面或使用者操作流程的修改，完成後應以瀏覽器實際操作確認，並在回報與紀錄中說明操作了哪些步驟、結果如何。lint、型別檢查與自動化測試仍需執行並回報結果。
   - 瀏覽器驗證以測試區 `https://giganexus-test.gigasolar.com.tw` 為準（公司憑證）；開發機的 BFF（`npm run dev`）與測試區共用資料庫 `giganexus_gw_test`。
   - 不可在瀏覽器輸入真實帳密；需要帳號時以假工號建立本機帳號（自行註冊 → CLI `local:approve`），測完刪除。
2. 每次修正都需留紀錄，新紀錄加在檔案最上方。
3. **開發新功能後，同一個變更內更新 `docs/PROJECT-MAP.md`**（§10.7），並在紀錄的「檔案」欄列出。

| 文件 | 路徑 | 說明 |
|:---|:---|:---|
| Bug修改紀錄 | `docs/DevelopmentProcess/BugFix.md` | Bug修改紀錄 |
| 新增功能紀錄 | `docs/DevelopmentProcess/NewFeatures.md` | 新增功能紀錄 |
| 前端修改紀錄 | `docs/DevelopmentProcess/FrontendCorrection.md` | 前端修改紀錄（`web-kit/`） |
| 後端修改紀錄 | `docs/DevelopmentProcess/BackendCorrection.md` | 後端修改紀錄（`bff/`、`nginx/`、`db/`、`deploy/`） |

### 紀錄格式
```
## YYYY-MM-DD 標題
- 工作項目：W3-x.n（無則省略）
- 內容：改了什麼、為什麼
- 檔案：主要修改的檔案
- 驗證：執行的指令與結果
```

---

## 10. 多專案工作區

GigaNexus 由多個獨立 repo 組成(Gateway、員工入口網、IT 管理系統、RustIt 端點管理、各系統的前端 / 後端),**各自管理自己的 repo 與 API**,但彼此相依。所有 repo 放在**同一層目錄**,從任一專案往上一層就找得到其他專案。本節是所有專案共用的規則,其他 repo 的 AGENT.md 只寫自己的部分並指向本節。

### 10.1 目錄配置

```
<工作區>/                          # 例:~/Code;公司環境由各工程師自訂,但所有專案放在同一層
├─ giga-api-gateway-bff/           # Gateway:Nginx、BFF、路由表、web-kit、Node SDK — 所有專案的上位規範
├─ giga-Portal/                    # 員工入口網(/,含 /login;應用切換的起點)
├─ GigaItApp/                      # IT 管理系統(/it/;設定各應用的選單 / Tab / 按鈕權限)
├─ RustIt/                         # 端點管理(W6,Rust):Endpoint Server、Agent、Watchdog、托盤
└─ <其他系統>/                     # 其他工程師開發的入口網功能:各自的前端 / 後端 repo
```

- 參照其他專案一律用「**上一層 + 資料夾名稱**」的相對路徑,例如 `../giga-api-gateway-bff/docs/BACKEND-GUIDE.md`、`../GigaItApp/AGENT.md`;不寫絕對路徑,也不假設工作區在哪個磁碟或使用者目錄。
- clone 時使用 §10.2 登記的**資料夾名稱**,否則相對路徑(文件連結、compose 掛載的憑證、SDK 的 `file:` 相依)會失效。
- 需要讀的兄弟專案不在工作區時(沒有 clone),**明確說明「未讀取」**,不要猜內容,也不要自行 clone。

### 10.2 專案登記

| 資料夾 | 內容 | 對外 / port | 負責 | AGENT.md |
| --- | --- | --- | --- | --- |
| `giga-api-gateway-bff` | Gateway:Nginx、BFF、路由表、web-kit、Node SDK 與後端樣本 | `:443`、`:9443`;BFF `/api/*` | Gateway 負責人 | 本文件 |
| `giga-Portal` | 員工入口網:單一入口登入頁、首頁、個人服務、簽核、公告;應用切換起點(M1:前端已建立並發佈本機 Nginx;portal-api 規劃中) | `/`(含 `/login`、`/register`、`/reset-password`)、`portal-api`(51271,`/api/portal/*` 經 BFF) | 入口網負責人 | `../giga-Portal/AGENT.md` |
| `GigaItApp` | IT 管理系統:權限查詢(唯讀)、**選單管理**(各應用目錄 / 選單 / Tab / 按鈕與綁定的 API)、**權限設定**(角色 / 部門 / 個人);端點管理經 BFF;單一入口(web-kit),也是畫面權限模型的範本 | `/it/`、`/api/it/*`(itapp-api 51291,經 BFF) | IT 管理系統負責人 | `../GigaItApp/AGENT.md` |
| `RustIt` | 端點管理(Rust,2026-10-01 取代原規劃的 Go `giga-endpoint` 與 C# `giga-agent-watchdog`):Endpoint Server(Axum)、Agent 與 Watchdog(Windows 服務)、托盤程式;Agent 以 HTTPS 回報、WebSocket 接收指令([docs/ENDPOINT-AGENT-GUIDE.md](docs/ENDPOINT-AGENT-GUIDE.md)) | `endpoint-api`(51240)、`endpoint-agent`(51241,HTTPS / WebSocket);Agent 經 `:9443` | W6 負責人 | `../RustIt/README.md`、`../RustIt/docs/PROJECT-MAP.md` |

新增 repo 時,先向 Gateway 負責人登記 port、服務代碼、系統代碼與 SPA 子路徑(BACKEND-GUIDE §3.3、PRD §7.2.1),再把資料夾名稱加到上表。

### 10.3 相依關係

| 專案 | 依賴 Gateway 的部分 | 與其他專案 |
| --- | --- | --- |
| giga-Portal | Nginx `/`(SPA 發佈到 `gw_www/portal`);BFF `/api/auth/*`(登入、`me.apps`)、`/api/portal/*` → `portal-api`(內部 Token、自動註冊);各系統經 BFF 的 API(HRM、BPM…) | 應用切換連到 GigaItApp 等其他應用(整頁導向);權限由 GigaItApp 設定、存在 BFF(PRD §8.3.2) |
| GigaItApp | Nginx `/it/`、`/it/api/`;BFF 管理 API(目前服務帳號;改單一入口後以使用者身分呼叫,含 v0.7 權限寫入);端點 API `/api/endpoint/*`(使用者的 Gateway 登入);測試區 compose 加入 Gateway 的 Docker 網路 | 不直接呼叫 Endpoint Server;端點功能經 BFF(PRD Q27);提供員工入口網等應用的權限設定畫面;沒有 IT 應用權限時導回員工入口網 |
| RustIt(Endpoint Server / Agent / Watchdog) | `:9443` 通道(HTTPS / WebSocket)、BFF 路由註冊、內部 Token(`docs/ENDPOINT-AGENT-GUIDE.md`) | 被 IT 管理系統經 BFF 呼叫;Agent 與 Watchdog、托盤以本機具名管道溝通 |
| 其他系統 | SPA 子路徑、BFF 路由、內部 Token(FRONTEND-GUIDE、BACKEND-GUIDE) | **一律經 BFF** 呼叫其他系統(§10.4) |

- **Gateway 的 `docs/` 是上位規範**。各 repo 自己的文件與之不一致時,先指出差異,不要自行決定以哪一邊為準。
- 介面變更(路由、權限代碼、proto、錯誤代碼、port)**先改 Gateway 的規格**,再改實作的 repo。

### 10.4 用 BFF 路由表找 API

跨專案要用別的系統的功能時,**先查 BFF 路由表**,不要先去讀對方 repo 的程式碼,也不要直接連對方的主機、port 或資料庫。路由表是「現在有哪些 API」的唯一來源,包含路徑、方法、權限、說明、Gherkin 行為規格與狀態(草稿 / 已發佈 / 已棄用)。

| 方式 | 用法 |
| --- | --- |
| 指令(任何專案) | 先建置一次 SDK:`cd ../giga-api-gateway-bff/sdk/node && npm ci && npm run build`;之後在自己的專案執行 `node ../giga-api-gateway-bff/sdk/node/dist/lookup-cli.js <關鍵字> [--system <系統代碼>] [--gherkin] [--json]`(環境變數 `GW_BASE_URL`、`GW_API_KEY` 或 `GW_API_KEY_FILE`) |
| 指令(以 Node 樣本建立的後端) | `npm run -s gw:lookup -- <關鍵字>`(`samples/node-backend/AGENT.md` §1) |
| API | `GET /api/admin/routes/catalog?q=&system=&status=`(API Key 或登入者,需 `gw.admin.route.read`) |

- **查到了**:經 Gateway 呼叫。前端 `/api/{system}/...`(使用者的 Cookie);後端 `/api/{system}/...` 加 `X-Api-Key`(系統對系統,ARCHITECTURE T9)。不直接呼叫對方的 `host:port`。
- **查到相近的**:先回報查詢結果並詢問:直接用、請該系統擴充,還是確實需要新增。不要默默重寫一支。
- **查不到**:回報後由負責人決定;需要新 API 時由該系統的 repo 實作並註冊,不要在自己的 repo 代寫別人的 API。
- **查詢失敗**(沒有 API Key、連不到 Gateway):明確說明「未查詢」,不可當作「沒有這支 API」。
- 路由表的說明不足、需要讀對方 repo 時:**只讀不改**,以對方的 OpenAPI 與 `docs/` 為準。

### 10.5 跨 repo 修改

- 只改本次任務所屬的 repo。需要改其他 repo(包含 Gateway)時,先說明要改什麼、為什麼,取得同意後再改;**其他工程師負責的 repo 不直接修改**,改為整理需求交給負責人。
- 在哪個 repo 改,就在**那個 repo** 的 `docs/DevelopmentProcess/` 留紀錄。
- 每個 repo 各自 commit、push;commit 訊息註明配合的另一個 repo 與 commit(例:`配合 giga-api-gateway-bff cc13cd0`)。
- 驗證跨專案功能時,以**測試區**(`https://giganexus-test.gigasolar.com.tw`)為共同基礎;各 repo 推送 `develop` 由 CI 部署後驗證。

### 10.6 新專案的 AGENT.md

每個 repo 的 AGENT.md 開頭都要有:

1. **專案定位**:系統代碼、SPA 子路徑、服務代碼與 port(已在 §10.2 登記)、登入方式。
2. **工作區**:「跨專案規則見 `../giga-api-gateway-bff/AGENT.md` §10」,以及本專案依賴哪些兄弟專案(§10.3)。
3. **上位規範**:依類型列出 Gateway 文件 — 前端 FRONTEND-GUIDE;後端 BACKEND-GUIDE;端點 ENDPOINT-AGENT-GUIDE。
4. **專案地圖路徑**:`docs/PROJECT-MAP.md`,以及「開發新功能後必須更新」(§10.7)。
5. **核心設計原則的套用方式**:本專案使用的語言對應 §10.7.2 的哪一列、與原則不同之處。

範本:Node.js 後端複製 `samples/node-backend/`(含 AGENT.md);**複製後 AI 必須先請工程師命名專案**(repo 資料夾名稱,寫入 `package.json` 的 `gateway.project`,SDK 自動註冊時帶入 `x-gateway.project`;樣本 AGENT.md §0),不可沿用樣本值或自行取名。SDK 以 `npm pack` 產生 tgz 放進自己 repo 的 `vendor/`,相依寫成 `file:vendor/giganexus-backend-sdk-<版本>.tgz`(Docker 建置不需要兄弟專案;公司 Package Registry 上線後改為一般套件);Go Endpoint Server / Agent 依 `docs/ENDPOINT-AGENT-GUIDE.md` 與 BACKEND-GUIDE 撰寫;前端依 FRONTEND-GUIDE。

### 10.7 專案地圖與核心設計原則(所有專案共用)

#### 10.7.1 專案地圖(`docs/PROJECT-MAP.md`)

每個 repo 都要有 `docs/PROJECT-MAP.md`,讓人與 AI 不必讀完程式就知道「什麼東西在哪裡、誰負責什麼」。

| 規則 | 說明 |
| --- | --- |
| 何時更新 | **開發新功能後一定要更新**;新增 / 刪除 / 搬移目錄或主要檔案、模組職責改變、新增進入點或對外介面時也要更新。與程式放在**同一個變更**(同一個 commit) |
| 不必更新 | 不影響結構與職責的 bug 修正、文字修改 |
| 最後更新 | 地圖開頭記錄最後更新日期與對應的功能 |
| 修正紀錄 | 有更新地圖時,在 `docs/DevelopmentProcess/` 紀錄的「檔案」欄列出 `docs/PROJECT-MAP.md` |
| 內容 | 1. 一句話定位 2. 目錄樹(每個目錄 / 主要檔案一句話職責)3. 分層:哪些是核心邏輯、介面層、基礎設施、工具 4. 主要流程(請求或資料從哪裡進、經過哪些檔案)5. 「要改 X → 看哪裡」索引 6. 測試地圖 7. 與 §10.7.2 原則不同之處(已知差異) |
| 寫法 | 只寫結構與職責,不複製程式碼或規格內容;細節連到 `docs/` 對應章節 |

#### 10.7.2 核心設計原則(依程式語言)

三個共同原則,**依各語言的慣例落實**;語言慣例與原則衝突時以語言慣例為準,並在專案地圖註明。

| 原則 | 目的 |
| --- | --- |
| **職責分離**(Separation of Concerns) | 商業邏輯(核心)、介面處理(HTTP / gRPC / UI / CLI)、基礎設施(資料庫、外部系統、作業系統)、工具函式分開;核心邏輯不直接依賴框架與 I/O,以介面或參數注入,降低耦合、可單獨測試 |
| **原始碼放在固定根目錄** | 原始碼集中在語言慣例的根目錄(多數是 `src/`),建置 / 打包只從這裡取檔,避免本機可執行、打包後 import 路徑錯誤;設定、腳本、文件不混在原始碼裡 |
| **集中測試管理** | 測試與原始碼**平行**、不打包進正式產物;單元 / 整合 / 端到端分開,測試只經公開介面(或語言允許的方式)存取程式 |

| 語言 / 類型 | 原始碼 | 職責分離的目錄慣例 | 測試位置 | 備註 |
| --- | --- | --- | --- | --- |
| TypeScript / Node.js 後端(Fastify) | `src/`;建置輸出 `dist/`(不進版控),`tsconfig.build.json` 只編 `src/` | `routes/` 或 `modules/<功能>/routes.ts`(介面:參數驗證、回應);模組內 service / 純函式(核心);`db/`、`store/`、`plugins/`(基礎設施);`src/utils/`(無狀態、無 I/O 的共用函式,**需要時才建**) | `test/`(與 `src/` 平行;`unit/`、`integration/`、`e2e/` 分開) | 以 `npm run build` 後的產物執行與部署,確認不依賴只在開發時存在的路徑 |
| Vue 3 前端(Vite) | `src/` | `pages/`(畫面組合,不寫共用樣式)、`ui/` 或 `components/`(無業務的共用元件)、`composables/`(狀態與邏輯)、`api/`(HTTP,頁面不直接 `fetch`) | `test/`(與 `src/` 平行,Vitest;元件測試可用 `*.test.ts` 放 `test/` 對應路徑) | 資源路徑用 `import.meta.env.BASE_URL` |
| Go | **不使用 `src/`**(Go 模組以 `go.mod` 為根,這是 Go 慣例);`cmd/<程式>/`(進入點,只組裝)、`internal/<套件>/`(不可被其他模組 import) | 以套件分責:領域邏輯套件不 import gRPC / HTTP / Windows API;平台相依以 `_windows.go` / build tag 分檔;產生碼放 `gen/` | 單元測試 `_test.go` **與程式同目錄**(Go 工具鏈的規定,才能測試未匯出的函式);跨程式整合 / 端到端放根目錄 `test/` | `go vet`、`GOOS=windows go vet` 都要過 |
| C# / .NET | `src/<專案>/`(.NET 慣例) | 核心邏輯只依賴介面(DI 注入);外部系統(SCM、具名管道、gRPC、憑證)各自包成 adapter;設定以 Options 綁定並驗證 | `tests/<專案>.Tests/`(與 `src/` 平行,xUnit) | 一個檔案一個主要型別 |
| Rust(RustIt) | `src/`(cargo 慣例):`lib.rs` 放邏輯、`main.rs` 只組裝 | 以模組分責;平台相依 `#[cfg(windows)]` | 單元測試 `#[cfg(test)] mod tests` 同檔;整合測試 `tests/`(cargo 慣例,只能用公開 API) | — |
| Nginx / 部署設定 / 腳本 | `nginx/`、`deploy/`、`scripts/` | 依部署區不同的值放 `templates/`、`allowlists/<區域>/` 或 env 檔 | 煙霧測試腳本(例 `deploy/smoke-test.sh`)或 E2E | 不放在 `src/` |

- **新程式碼**必須符合本節。**既有程式**與原則不同時,不要為了符合原則而大規模搬移(§3 外科手術式修改);在專案地圖的「已知差異」列出,另開任務處理。
- 新增目錄慣例(例如第一次建立 `utils/`)時,同步更新專案地圖。

### 10.8 AI 分工(Claude / Gemini)

所有專案共用;各 repo 的 AGENT.md 收錄同一份內容,有出入時以本節為準。

寫程式、寫測試、寫文件由 **Claude** 負責;**Gemini** 只負責執行測試、撰寫測試報告,以及非邏輯性的修改。Gemini 開始動手前,先確認工作在下表 Gemini 欄是 ✅。

| 工作 | Claude | Gemini |
| --- | --- | --- |
| 寫程式(新功能、業務邏輯、API、權限、資料存取、狀態管理、修 bug、重構) | ✅ | ❌ |
| 寫測試(單元 / 整合 / E2E 測試碼、測試用 fixture 的邏輯) | ✅ | ❌ |
| 寫文件(`AGENT.md`、`README.md`、`docs/`、`PROJECT-MAP.md`、架構 JSON、修正紀錄) | ✅ | ❌(測試報告除外) |
| 執行測試(既有的 `npm test`、`test:int`、E2E、`cargo test` 等)並撰寫測試報告 | ✅ | ✅ |
| 非邏輯性修改:前端 mock / 假資料、版面與樣式(CSS、間距、顏色、排版)、畫面文案錯字 | ✅ | ✅ |
| CI/CD 與容器、部署設定 | ✅ | ❌ **禁止** |

**Gemini 禁止修改**(即使只改一行):

- CI/CD:`.gitlab-ci.yml`、`ci-templates/`、Runner 設定。
- 容器與部署:`Dockerfile*`、`docker-compose*`、`.dockerignore`、`deploy/`、`nginx/`、部署腳本、`.env*`、`Web.config` / 發佈設定。
- 相依與建置設定:`package.json`(含 scripts)、lock 檔、`Cargo.toml`、`tsconfig*.json`、`vite.config.*`。
- 資料庫:schema、migration、seed。
- 測試程式碼:測試失敗時**不得**為了讓測試通過而修改測試或程式、跳過測試、調整門檻;把失敗寫進報告,交給 Claude 處理。

**測試報告**(Gemini 執行測試後必寫):

- 位置:該 repo 的 `docs/test-reports/YYYY-MM-DD-<主題>.md`。
- 內容:1. 環境(分支 / commit、部署區、執行的指令)2. 結果(通過 / 失敗 / 略過數量)3. 失敗項目(測試名稱、錯誤訊息摘錄)4. **可能問題**:推測原因、相關檔案與行號、重現步驟、影響範圍 5. 建議交給 Claude 處理的項目。
- 測試全部通過也要寫,並列出觀察到的潛在風險(警告訊息、偶發失敗、執行過慢等)。

**判斷不了是否屬於「非邏輯性」時,一律視為邏輯修改**:不動程式,寫進報告交給 Claude。
