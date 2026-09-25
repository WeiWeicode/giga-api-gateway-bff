# GigaNexus 下游後端樣本 — AI 協作準則(AGENT.md)

> 本文件是 AI 程式助手在「以本樣本為基礎的 Node.js 下游後端」中的行為準則。
> 通用準則(先思考、簡單優先、外科手術式修改、失敗要明確說)同 Gateway 專案根目錄的 `AGENT.md`;本文件只列後端專屬規則。
> 後端接入規範以 Gateway 專案的 `docs/BACKEND-GUIDE.md` 為準,本文件與之不一致時先指出差異,不要自行決定。
> 複製成獨立 repo 後,與 Gateway 等專案放在**同一層目錄**;跨專案規則(相對路徑 `../giga-api-gateway-bff/`、用 BFF 路由表找 API、跨 repo 修改)見 Gateway `AGENT.md` §10。

---

## 1. 新增 API 前先查,避免重複造輪

### 規則
- **動手寫任何新 API 之前,先查 Gateway 既有路由**(含其他系統、草稿與已棄用):

  ```bash
  npm run -s gw:lookup -- <關鍵字>              # 比對 route_code、名稱、路徑、權限、標籤、說明
  npm run -s gw:lookup -- <關鍵字> --gherkin    # 一併列出行為規格
  npm run -s gw:lookup -- --system mes --json   # 某系統的全部路由(JSON)
  ```

- 查到功能相同或相近的 API 時,**先回報查詢結果並詢問**:直接呼叫既有 API(經 Gateway)、請該系統擴充,還是確實需要新增。不要默默重寫一支。
- 查詢需要 `GW_BASE_URL` 與 API Key(`.env` 的 `GW_API_KEY`)。查不到(沒有設定、連不到 Gateway)時**明確說明未查詢**,不可當作「沒有重複」。
- 程式內需要查詢時使用 SDK:`new GatewayClient(env.gatewayUrl!, env.apiKey!).lookup({ q })`。

### 範例
```
❌ 錯誤:直接新增 GET /v1/employees/{emp},自己查 BPM 人員資料
✅ 正確:「gw:lookup 員工 查到 hrm.employee.get(GET /api/hrm/employees/:emp,已發佈),
    回傳工號、姓名、部門。建議直接經 Gateway 呼叫,不另外實作。要新增的話請說明差異。」
```

---

## 2. 部署區(GW_ENV)

| 項目 | `dev`(本機開發) | `test`(測試區) | `prod`(正式區) |
| --- | --- | --- | --- |
| 自動註冊 API | 不註冊 | 啟動時註冊為 Gateway **草稿** | 啟動時註冊為 Gateway **草稿** |
| 路由生效 | — | IT 發佈後 | IT 核可發佈後 |
| API Key | `GW_API_KEY` 或 `GW_API_KEY_FILE` | `GW_API_KEY_FILE` | **只接受** `GW_API_KEY_FILE`(Docker secret) |
| `SERVICE_ADVERTISE_URL` | 不需要 | 必填 | 必填 |
| 日誌等級預設 | `debug` | `info` | `info` |

- 環境變數由 SDK `loadGatewayEnv()` 讀取與檢查,缺少必要設定時**啟動失敗**;不要加預設值繞過檢查。
- 部署區只有這三個值;不要新增 `staging`、`product` 之類的名稱。
- 測試區與正式區的 Gateway 資料庫**各自獨立、設定不互通**,兩區各自由服務啟動時註冊。
- 自動註冊**只寫草稿**,不會讓 API 立即上線;上線需 IT 設定權限授權對象並發佈。
- 註冊失敗(規格錯誤、API Key 無效)時服務仍會啟動,但以 `error` 記錄;**回報時必須說明註冊失敗與錯誤內容**,不可當作完成。

---

## 3. 每支 API 的必填欄位

寫在 Fastify 路由的 `schema`,由 `@fastify/swagger` 輸出到 `/openapi.json`(BACKEND-GUIDE.md §6.1):

| 欄位 | 規則 |
| --- | --- |
| `operationId` | `{system}.{resource}.{action}`,全域唯一(例 `sample.item.get`) |
| `summary` | 中文名稱,顯示於 IT 管理介面 |
| `description` | **API 用途說明**(1000 字內):做什麼、資料範圍、主要錯誤代碼 |
| `x-permission` | 權限代碼(須列在 `src/openapi.ts` 的 `PERMISSIONS`)、`authenticated` 或 `public`(需 IT 核准) |
| `x-gherkin` | **行為規格**:至少一個 `場景:`,使用 zh-TW 關鍵字 `假如` / `當` / `那麼` / `而且`,描述可觀察的行為(HTTP 狀態、`code`) |
| `tags` | 建議,功能分類 |

- 敏感 API(薪資、個資)加 `x-audit-level: meta` 以上。
- 健康檢查等非業務端點以 `config: { gatewayAuth: false }, schema: { hide: true }` 排除,不出現在 OpenAPI。
- 修改後執行 `npm test`:會檢查每個 operation 的上述欄位,缺少即失敗。**不要刪除或放寬這項檢查**。

---

## 4. 身分、權限與錯誤

- 身分只信任 `X-Internal-Token`(`req.identity`),不信任其他標頭;**不要關閉或略過 Token 驗證**,dev 也一樣。
- API 層級權限由 Gateway 處理;**資料層級**(部門、公司)由後端依 `dept` / `cos` / `roles` 過濾,無權限回 `403 DATA_ACCESS_DENIED`。
- 錯誤一律 `throw new AppError(status, code, message, details?)`,格式 `{ code, message, requestId, details? }`。
- 自訂代碼**以系統代碼開頭**(例 `SAMPLE_ITEM_NOT_FOUND`);不可使用 `UNAUTHENTICATED`、`PERMISSION_DENIED`、`CSRF_INVALID`、`UPSTREAM_*`。
- 不回傳堆疊或 SQL;不回 `Set-Cookie`、CORS、`X-Powered-By` 標頭。
- 冪等:`GET` / `PUT` / `DELETE` 必須冪等(Gateway 只重試冪等方法)。

---

## 5. 專案慣例

| 項目 | 規範 |
| --- | --- |
| 語言 / 框架 | TypeScript(ESM、`strict`)+ Fastify 5;路由以 plugin 組織,放在 `src/routes/<資源>.ts` |
| 路徑 | 後端 `/v1/{resource}`(名詞複數、kebab-case),對外自動成為 `/api/{system}/{resource}` |
| Port | 51200–51300,開發前向 Gateway 負責人申請並登記(BACKEND-GUIDE.md §3.3) |
| Gateway 共用功能 | 一律用 `@giganexus/backend-sdk`(設定、Token 驗證、自動註冊、路由查詢、錯誤格式),不要自己重寫 |
| 機密 | 不入版控、不寫進映像檔;以 `<NAME>_FILE` 指向 Docker secret |
| 註解語言 | 繁體中文,註明對應規格章節(例 `(BACKEND-GUIDE.md §5.3)`) |

### 常用指令
| 指令 | 說明 |
| --- | --- |
| `npm run dev` | 本機開發(讀 `.env`,`GW_ENV=dev` 不註冊) |
| `npm test` | OpenAPI 自我檢查、Token 驗證、錯誤格式、部署區設定 |
| `npm run typecheck` / `npm run build` | 型別檢查 / 建置 |
| `npm run -s openapi` | 輸出 OpenAPI(不啟動服務) |
| `npm run -s gw:lookup -- <關鍵字>` | 查詢 Gateway 既有路由 |

完成時回報:執行了哪些指令、結果如何;新增的 API 是否已查過重複、自動註冊是否成功(草稿數量)。
