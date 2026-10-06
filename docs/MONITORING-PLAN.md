# GigaNexus — API / Nginx 監控計畫

> 甘特圖工作流 **W9「API / Nginx 監控(觀測)」**。**時程以 NexusPlan 甘特圖為準**,本文不列日期。
> 相關文件:[PRD.md](PRD.md) §7.7、§12、[BACKEND-GUIDE.md](BACKEND-GUIDE.md) §7.5、[FRONTEND-GUIDE.md](FRONTEND-GUIDE.md)、[DEPLOYMENT.md](DEPLOYMENT.md);觀測服務 `../giga-observe`(由工作區外的 DevOpsDiagram 複製,原專案只作參考、不修改)。

---

## 1. 文件資訊

| 項目 | 內容 |
| --- | --- |
| 文件版本 | v0.4(2026-10-06,實作後修正:權限代碼改為 API 權限 observe.*、SDK 子路徑只有 /fastify、架構觀測頁改輪詢、§8 實作紀錄);v0.3(2026-10-06,新增 D10–D13:移除自帶前端、舊系統留原平台、未登入可回報、錯誤 body 90 天);v0.2(2026-10-06,需求方確認 D1–D7 全部採用;D2 改為複製到工作區、自有資料庫、測試區 / 正式區隔離;保存期限定案);v0.1 初稿 |
| 範圍 | BFF、Nginx、下游後端(itapp-api、samples/node-backend 及日後所有後端)、前端(GigaItApp、員工入口網)的請求紀錄、錯誤、健康度、流量與來源 IP;GigaItApp 架構觀測頁與儀表板 |
| 不在範圍 | 主機 CPU / 記憶體指標、分散式追蹤(保留 `requestId` 串接即可)、Email / Teams 告警通知(先在畫面顯示,通知另列) |

## 2. 目標

1. **後端工程師零開發**:裝一個套件、加一行設定,就同時完成「API 自動註冊」與「API 監控」,不必自己寫 SDK。
2. **一個畫面看全局**:在 GigaItApp 看到所有服務(含 Nginx、BFF、各後端、前端)的架構圖、健康狀態、紀錄、錯誤與明細,UI 與 GigaItApp 一致。
3. **補齊儀表板**:GigaItApp 儀表板中標示「開發中」的卡片改接真實資料(今日 API 呼叫、服務可用率、平均回應時間、資安告警、今日 API 流量、系統告警、上游服務健康)。
4. **Nginx 看得到流量與來源 IP**,作為資安告警的來源。

## 3. 現況盤點

| 項目 | 現況 | 缺口 |
| --- | --- | --- |
| `@giganexus/backend-sdk`(`sdk/node`) | `autoRegister`、`createTokenVerifier`、`GatewayClient.lookup` | 沒有監控;**尚未發佈到 Registry**,GigaItApp 後端因此自行用 jose 重寫一份驗證(`GigaItApp/backend/src/gateway/plugin.ts`),也沒有自動註冊 |
| samples/node-backend | 啟動後 `autoRegister`;`/healthz`、`/readyz`、`/openapi.json` | 沒有監控 |
| BFF 自身 API(`/api/auth/*`、`/api/admin/*`) | 程式內建,路由表同名路徑一律忽略(PRD §14.1);權限代碼由 `db/seed.ts` 寫入(Gateway 概況顯示 114 個權限) | **不在路由目錄**:`/api/admin/routes/catalog`、權限查詢、誰能存取都查不到這些 API;只有 `/docs` 看得到 |
| BFF 指標 | `/metrics`(prom-client):請求數、延遲、上游結果、斷路器、佇列、登入結果 | **沒有 Prometheus 在抓**,指標沒有地方保存與查詢;沒有逐筆紀錄與錯誤明細 |
| Nginx | JSON access log 輸出到 stdout(含 `remote_addr`,經 PROXY protocol 為真實來源 IP);nginx-prometheus-exporter 讀 `stub_status` | `stub_status` 只有總連線數 / 請求數,**沒有依來源 IP、狀態碼、路徑的統計**;stdout 日誌沒有被收集 |
| 前端 | 無 | 沒有 JS 錯誤、API 失敗、載入效能的回報 |
| DevOpsDiagram(既有觀測平台) | Express + MongoDB + Redis;`devops-reporter` SDK(非同步批次、1 秒逾時、緩衝丟最舊、敏感欄位遮罩、心跳);Ingest / Query / SSE API;主動探測(prober);`topology.json` 架構圖;錯誤聚合;每日備份。已監控 MES、NotesAPP、BPM 等既有服務 | 不認識 GigaNexus 的服務;沒有流量彙總與前端事件;UI 風格與 GigaItApp 不同;未部署在 GigaNexus 測試區 |

## 4. 決策(2026-10-06 定案)

| # | 決策 | 定案 |
| --- | --- | --- |
| D1 | 監控放在哪個 SDK | `@giganexus/backend-sdk` 內的獨立模組 + `setupGateway` 一鍵接入 |
| D2 | 資料後端 | **DevOpsDiagram 複製到工作區為 `giga-observe`(新 repo)**,原專案只作參考;自有 MongoDB / Redis,**不與既有 DevOpsDiagram 共用**;**測試區與正式區各一套,完全隔離** |
| D3 | BFF 內建 API | 列入目錄(builtin,唯讀),不註冊成草稿 |
| D4 | Nginx | access log 寫檔 + `nginx-log-agent` 每分鐘彙總 |
| D5 | 前端健康度 | web-kit 監控模組,經 BFF `/api/telemetry/web` 轉送 |
| D6 | GigaItApp | 「架構觀測」頁;API 權限 `observe.data.read` / `observe.log.body`,畫面節點 `it.gw-observe.*` |
| D7 | 套件發佈 | 公司 GitLab npm Package Registry |
| D8 | 部署 | 測試區在**主機 2 新部署一組**;正式區隨 W3-M |
| D9 | 保存期限 | 成功紀錄 **7 天**、錯誤 **永久**(沿用 DevOpsDiagram D-04)、Nginx 流量彙總 **90 天** |
| D10 | giga-observe 自帶前端 | **移除,只留 API**;畫面只在 GigaItApp,存取一律經 BFF 權限 |
| D11 | 舊系統(MES、NotesAPP、BPM…) | **留在原 DevOpsDiagram**,兩個平台各自獨立、不雙送;舊服務日後重構成 GigaNexus 新架構(新 port、新服務代碼)時,以新服務身分接 giga-observe |
| D12 | 未登入頁面的前端回報 | **允許**(登入頁、忘記密碼),依 IP 限流與大小上限,事件標示匿名 |
| D13 | 錯誤的 body | 錯誤紀錄永久;**完整 body 保留 90 天,之後裁成前 1 KB 摘要** |

以下為各決策的評估過程。

### D1 API 監控放在自動註冊的 SDK 裡,還是另開一個 SDK? → **同一個套件,獨立模組**

**建議**:放進 `@giganexus/backend-sdk`,(監控核心 `Monitor` 由主入口匯出,Fastify 整合以子路徑 `@giganexus/backend-sdk/fastify` 提供),並加一個框架整合入口 `setupGateway` 一次掛上「Token 驗證 + 自動註冊 + 監控 + healthz」。

| 比較 | 同一套件、獨立模組(建議) | 另開一個 SDK |
| --- | --- | --- |
| 工程師要做的事 | 裝一個套件、一組環境變數 | 裝兩個套件、兩組設定,版本要對齊 |
| 共用設定 | `GW_ENV`、服務代碼、`package.json gateway.project` 直接共用;監控的 serviceId 就是 Gateway 上游代碼,兩邊資料天然對得上 | 要重複讀取、容易對不上 |
| 發佈問題(§D7) | 解決一次 | 兩個套件都要解決 |
| 失敗隔離 | 模組內部各自處理:註冊是啟動時一次、失敗重試;監控是背景批次、送不出去只丟資料。互不呼叫,任一失敗不影響另一個與服務本身 | 一樣能隔離,但沒有多出的好處 |
| 不想要監控的服務 | `monitor: false` 或不 import 子路徑即可,不會載入 | — |

另開 SDK 只在「監控要給非 GigaNexus 的系統用」時才有意義;那種情境已經有 DevOpsDiagram 的 `devops-reporter`,不需要再做一個。前端監控則放在 `@giganexus/web-kit`(前端本來就裝它),不併進後端 SDK。

### D2 監控資料存哪裡? → **以 DevOpsDiagram 為基礎複製成 `giga-observe`(自有資料庫),畫面做在 GigaItApp**

| 方案 | 評估 |
| --- | --- |
| **A. 以 DevOpsDiagram 為基礎(採用)** | 截圖中的架構圖、紀錄、錯誤、服務詳情、心跳、探測、SSE、遮罩、備份都已完成;MongoDB 適合大量紀錄。複製到工作區為 `giga-observe` 後擴充(§5.4),與既有 DevOpsDiagram 分開演進、不共用資料庫 |
| B. 寫進 BFF 的 SQL Server | SQL Server 2012 有相容限制(`sql2012-guard`),大量逐筆紀錄會拖累 BFF 主資料庫;違反「監控壞掉不能拖累被監控服務」 |
| C. 新架 Prometheus + Loki + Grafana | 長期最標準,但要新建三套服務、Grafana 畫面無法符合 GigaItApp 風格與權限;BFF 的 `/metrics` 保留,日後要接仍可接 |

做法:SDK 監控模組送 giga-observe 的 Ingest API(沿用 DevOpsDiagram 格式:`POST /api/v1/ingest/logs`、`POST /api/v1/heartbeat`);GigaItApp 的畫面經 BFF 路由讀取 giga-observe 的 Query / SSE API(遵守「找別的系統 API 先查 BFF 路由表」,不直接連)。既有 DevOpsDiagram 繼續監控 MES、NotesAPP 等舊系統,不受影響。

**隔離**:測試區與正式區各自一套 giga-observe(compose 專案名、容器名、資料目錄、MongoDB 資料庫名稱、Redis 前綴、API Key 全部分開),與 Gateway 的「各區各一套資料庫」(PRD Q3)一致;測試區的服務只能把資料送進測試區的 giga-observe。

### D3 BFF 內建 API 要不要「自動註冊」? → **列入目錄,不註冊成草稿**

BFF 自己的 API 不經動態路由表轉送(PRD §14.1),若當成一般後端註冊成草稿,會出現「IT 要發佈但發佈了也不生效」的假路由。

**建議**:BFF 啟動時以自身 OpenAPI(`app.swagger()`)產生唯讀的目錄項目(`routeType = builtin`,只在記憶體或以獨立標記存放,不進路由快照),讓路由目錄、權限查詢、誰能存取、GigaItApp「服務與路由」都看得到;權限代碼仍以 `seed.ts` 為準,啟動時比對 OpenAPI 的 `x-permissions` 與 seed,不一致就記錄警告(CI 也檢查)。

### D4 Nginx 流量與來源 IP → **access log 寫檔 + sidecar 每分鐘彙總**

- Nginx 另加一份 access log 寫到共用 volume(stdout 照舊),沿用現有 `json` 格式(已含 `remote_addr`、`status`、`bytes`、`request_time`、`upstream_addr`、`request_id`)。
- 新增 `nginx-log-agent` 容器(Node,約 200 行):tail 檔案、每分鐘彙總為「請求數、狀態碼分布、傳輸量、p95 回應時間、Top N 來源 IP、Top N 路徑、429 / 403 / 401 次數」,送到 giga-observe;並以每 30 秒心跳回報 Nginx 存活。檔案超過 50 MB 時由 agent 截斷(原始紀錄仍在 Nginx stdout / docker logs)。
- **不逐筆送**:BFF 已逐筆回報同一批請求,Nginx 只送彙總避免重複與資料量膨脹;要查單筆以 `request_id` 對到 BFF 紀錄。
- 來源 IP 的正確性依賴主機的 L4 轉送帶 PROXY protocol(DEPLOYMENT.md §6.1);沒走 PROXY protocol 的連線會是 Docker 網段 IP,彙總時標示。

### D5 前端健康度 → **web-kit 監控模組,經 BFF 轉送**

- `@giganexus/web-kit` 新增 `installMonitor({ app: 'itapp' })`:收集 `window.onerror`、`unhandledrejection`、Vue `errorHandler`、API 呼叫失敗(含 `requestId`)、Web Vitals(LCP、INP、CLS)、頁面載入時間、每 60 秒在前景時的心跳。
- 瀏覽器不能持有 API Key,改送 BFF 新端點 `POST /api/telemetry/web`(以 `navigator.sendBeacon` 批次送出;登入前的頁面也能送(D12),依 IP 限流、限制單次大小,未登入事件標示匿名),BFF 補上使用者、部門後轉送 giga-observe。
- 前端在架構圖上為獨立節點(例如 `itapp-web`),狀態依錯誤率與心跳判斷。

### D6 GigaItApp 架構觀測頁 → **新頁面,UI 依 GigaItApp UI-GUIDE**

- 選單掛在「API Gateway 管理」下(截圖箭頭位置),名稱「架構觀測」;子頁以 Tab 呈現:架構圖 / 紀錄 / 錯誤 / 總覽;點節點開服務詳情抽屜(概況、紀錄、錯誤、相依)。
- 權限:API 權限由 giga-observe 的 OpenAPI 宣告(系統代碼 `observe`):`observe.data.read`(狀態、統計、紀錄摘要)、`observe.log.body`(含 body 的明細,可能含個資);畫面節點 `it.gw-observe.read`(選單)、`.map` / `.logs` / `.errors` / `.traffic`(Tab)、`.body`(按鈕)以 includes 綁定;依畫面權限模型登記在 `deploy/gateway-rbac.yaml`。
- 即時更新:架構圖每 15 秒輪詢、流量頁每 60 秒(分頁在背景時暫停)。不經 BFF 轉送 SSE:動態路由有逾時(x-timeout-ms),長連線會被切斷。
- 架構圖節點與連線:以 `GigaNexusAIPlan/architecture/workspace.json` + BFF 上游清單產生 giga-observe 的拓樸,不再手寫第二份。

### D7 套件發佈 → **發佈到公司 GitLab npm Package Registry**

現在 GigaItApp 以 alias 指向兄弟 repo 原始碼(web-kit)或自己重寫(backend-sdk),CI 建置要特別處理。發佈到 GitLab(主機 1)的 npm registry 後,各專案 `npm install @giganexus/backend-sdk` 即可,「以後工程師不用另外開發」才成立。發佈由 `giga-api-gateway-bff` 的 CI 在 tag 時執行。

## 5. 設計

### 5.1 資料流

```text
瀏覽器 ──(web-kit monitor, sendBeacon)──▶ Nginx ─▶ BFF /api/telemetry/web ─┐
                                                                          │
下游後端(itapp-api、node-backend…)──(backend-sdk monitor)───────────────┤
BFF 自身(請求、上游、登入結果)──────(backend-sdk monitor)───────────────┤──▶ giga-observe Ingest ─▶ MongoDB(各區獨立)
Nginx access log ─▶ nginx-log-agent(每分鐘彙總、心跳)──────────────────┘          │
giga-observe prober(主動打 /healthz)                                               │
                                                                                     ▼
GigaItApp 架構觀測頁 / 儀表板 ─▶ Nginx ─▶ BFF(observe.data.read)─▶ giga-observe Query(輪詢)
```

### 5.2 backend-sdk 監控模組(W9-2)

```ts
// Fastify(BFF、itapp-api、samples/node-backend)
import { setupGateway } from '@giganexus/backend-sdk/fastify';
await app.register(setupGateway, {
  env: loadGatewayEnv(),                 // GW_ENV、服務代碼、gateway.project、MONITOR_URL、MONITOR_API_KEY
  readyz: async () => db.ping(),         // 選填;同時提供 /healthz、/readyz、/openapi.json
  monitor: { ignorePaths: ['/healthz', '/readyz', '/metrics'] }, // 選填;false 關閉
});
// listen 之後自動執行 autoRegister(dev 不註冊;失敗只記錄,不停止服務)

```

- 只提供 Fastify 整合(GigaNexus 後端一律依 samples/node-backend);舊系統依 D11 繼續用原 `devops-reporter`,Express 介面等新架構真的有 Express 服務時再加。
- 移植 DevOpsDiagram `devops-reporter` 的核心並改寫為 TypeScript:非同步記憶體佇列、每 5 秒或 50 筆批次、1 秒逾時、緩衝 500 筆滿了丟最舊、敏感欄位與 `X-Internal-Token` 遮罩、成功只存摘要 / 錯誤存完整 body(32 KB 截斷)、30 秒心跳(帶版本、相依服務狀態)。
- 每筆紀錄帶 `requestId`(沿用 Gateway 的 `X-Request-Id`)、`routeCode`、使用者工號(取自內部 Token,不存姓名以外個資)。
- `dev` 預設關閉監控(與自動註冊一致),可用 `MONITOR_ENABLED=true` 開啟。
- 監控送不出去是**唯一允許靜默失敗**的地方(只 `warn`),絕不影響請求。

### 5.3 BFF(W9-5、W9-6)

- 內建 API 列入目錄(D3);`/api/admin/routes/catalog`、權限查詢、誰能存取同時回傳 builtin 項目並標示「BFF 內建」。
- BFF 以 `setupGateway` 的 monitor 部分回報:內建 API 與動態路由的每筆請求(動態路由帶 `routeCode`、`upstream`、上游狀態與耗時),讓「上游服務健康」卡片可依上游彙總;登入失敗、`PERMISSION_DENIED`、斷路器開啟視為資安 / 系統事件。
- `/metrics` 保留(日後接 Prometheus)。
- 新增 `POST /api/telemetry/web`(D5),以及 giga-observe 的上游登記與 `/api/observe/*` 路由(匯入 giga-observe 的 /openapi.json)。

### 5.4 giga-observe 擴充(W9-8)

| 擴充 | 說明 |
| --- | --- |
| `POST /api/v1/ingest/traffic` | Nginx 每分鐘彙總(§D4),存 `traffic_minutely`,保留 90 天 |
| `POST /api/v1/ingest/web-events` | 前端事件(§D5),錯誤進錯誤聚合,Web Vitals 存彙總 |
| 查詢 API | 流量時序、Top 來源 IP、依服務的可用率 / p95、告警清單(規則:服務失聯、5 分鐘錯誤率 > 5%、429 / 401 / 403 突增、單一 IP 請求異常) |
| 拓樸 | 由 `workspace.json` + BFF 上游清單產生 GigaNexus 的節點,與既有服務並存 |
| 部署 | 測試區在主機 2 新部署一組;正式區另一組。容器名改 `gno-*` 並以 compose 專案名區分部署區(主機 2 若同時跑既有 DevOpsDiagram 也不衝突);Mongo / Redis 只在內部網路(沿用 D-02) |
| 保存期限 | 成功紀錄 7 天(`LOG_TTL_DAYS=7`,沿用)、錯誤永久(沿用)、流量彙總 90 天(新增 TTL 索引);每日排程把 90 天前錯誤的完整 body 裁成前 1 KB 摘要(D13) |
| 移除前端 | 刪除 `frontend/` 與 compose 的前端服務、5131 port(D10);Query / SSE 只開放 BFF 所在網段 |
| 改名 | 服務代碼、Redis 前綴、文件中的 DevOpsDiagram / dvd 改為 giga-observe / gno;保留出處說明 |

告警只「計算並顯示」;Email 通知沿用 BFF 既有 `workers/alert.ts` / notify 機制,另列工作項目。

### 5.5 GigaItApp(W9-10、W9-11)

- 架構觀測頁(§D6)與儀表板卡片接資料,對照:

| 儀表板卡片 | 資料來源 |
| --- | --- |
| 今日 API 呼叫 | BFF 紀錄彙總(今日請求數、與昨日比較) |
| 服務可用率 | 心跳 + prober 計算的各服務可用率 |
| 平均回應時間 | BFF 紀錄 p50 / p95 |
| 待處理工單 | 不在本計畫(工單系統未定) |
| 資安告警 | Nginx 彙總(429 / 403 突增、異常 IP)+ BFF 登入失敗 |
| 今日 API 流量 | 每小時請求數與錯誤數 |
| 系統告警 | 服務失聯、錯誤率超標、斷路器開啟、佇列死信 |
| 上游服務健康(Gateway 概況) | 依 `upstream` 的 p95 與可用率 |

- itapp-api 改用 `@giganexus/backend-sdk`(移除自行實作的 Token 驗證),同時取得自動註冊與監控;前端呼叫 `installMonitor`。

## 6. 工作項目與驗收

| 甘特圖 | 工作 | 交付物 | 驗收 |
| --- | --- | --- | --- |
| W9-1 | 評估與計畫 | 本文件 | D1–D7 經需求方確認 |
| W9-2 | SDK 監控模組 + `setupGateway` | `sdk/node/src/monitor/*`、`fastify.ts`、`express.ts`;單元測試 | 監控端點斷線、逾時、回 500 時,被監控服務延遲增加 < 1 ms 且無錯誤;遮罩測試通過 |
| W9-3 | 發佈到 GitLab npm Registry | CI 發佈 job、`.npmrc` 範本、文件 | 新專案 `npm install` 可用;GigaItApp 移除 alias |
| W9-4 | 樣本後端接入 + 文件 | samples/node-backend 改用 `setupGateway`;BACKEND-GUIDE 新增「監控」章節 | 樣本在測試區啟動後,架構圖出現節點且有紀錄 |
| W9-5 | BFF 內建 API 列入目錄 | builtin 目錄項目、權限比對檢查 | 權限查詢 / 誰能存取查得到 `/api/admin/*`;seed 與 OpenAPI 不一致時 CI 失敗 |
| W9-6 | BFF 接監控 + 前端遙測端點 | monitor 掛載、`/api/telemetry/web` | BFF 每筆請求可依 `requestId` 查到;上游錯誤可依 upstream 篩選 |
| W9-7 | Nginx 流量彙總 | access log 檔、`nginx-log-agent` 容器、compose | 每分鐘可查到 Top 來源 IP 與狀態碼分布;agent 停掉不影響 Nginx |
| W9-8 | giga-observe 擴充與部署 | §5.4;測試區部署;BFF 上游登記 | GigaItApp 經 BFF 可讀 Query / SSE |
| W9-9 | web-kit 前端監控 | `installMonitor`;GigaItApp、入口網接入 | 前端丟錯後 1 分鐘內出現在錯誤頁,含 `requestId` 可對到後端 |
| W9-10 | 架構觀測頁 | 頁面、Tab、抽屜、選單 / 權限登記 | 對照截圖功能齊全;無 `observe.log.body` 看不到 body |
| W9-11 | 儀表板接資料 | §5.5 對照表各卡片 | 不再顯示「開發中」(待處理工單除外) |
| W9-M | ◆ 測試區監控可用 | — | 以上全部在測試區驗收 |

## 7. 風險與注意事項

1. **原 DevOpsDiagram 只作參考**:不修改原專案;兩邊日後各自演進,原專案若修了 SDK 或遮罩的 bug,需要人工判斷是否帶過來。
2. **個資**:紀錄含工號、來源 IP、錯誤時的完整 body;錯誤**永久保存**但完整 body 只留 90 天(D13),看 body 需 `observe.log.body`(預設只給 Gateway 超級管理員、Gateway IT 管理員),並在 giga-observe 寫入時沿用遮罩規則(密碼、Token、API Key)。錯誤資料量需定期檢視(每日備份保留 30 份)。
3. **資料量**:以目前規模(單一服務每小時數百筆)無虞;若全公司前端都接,前端事件需抽樣(預設錯誤全收、Web Vitals 抽 10%)。
4. **正式區**:本計畫只做到測試區;正式區隨 W3-M(正式區 Gateway + BFF)一併部署,資料庫與測試區完全分開。

## 8. 實作紀錄(2026-10-06,本機完成,待部署測試區)

| 元件 | 位置 | 重點 | 測試 |
| --- | --- | --- | --- |
| backend-sdk 0.3.0 | `sdk/node/src/monitor.ts`、`fastify.ts` | `Monitor`、`loadMonitorEnv`;`setupGateway` = 監控 + `req.monitor` + 開始服務後背景自動註冊(健康檢查、Token 驗證仍由服務自己提供) | 12 項 |
| 樣本後端 | `samples/node-backend` | 改用 `setupGateway`,示範 `req.monitor.action()` | 13 項 |
| BFF 內建 API 目錄 | `bff/scripts/gen-builtin-routes.ts` → `modules/admin/builtin-routes.generated.json` | 109 支(權限 94、登入即可 7、免登入 8);新增內建 API 後執行 `npm run gen:builtin`,否則單元測試失敗 | BFF 共 199 項 |
| BFF 監控 | `bff/src/plugins/observe.ts`、`modules/telemetry/routes.ts` | SDK 以原始碼編入(`tsconfig` paths、Dockerfile 複製 `sdk/node/src`,W9-3 發佈後改相依);`MONITOR_URL`、`MONITOR_API_KEY_FILE`、`MONITOR_WEB_API_KEY_FILE` 未設定即停用 | 同上 |
| nginx-log-agent | `nginx/log-agent/` | `access_log /var/log/nginx-gw/access.json`(volume `nginx_logs`);`MONITOR_NGINX_API_KEY_FILE` | 5 項 |
| web-kit 0.2.0 | `web-kit/src/monitor.ts`、`monitor-core.ts`、`http.ts` | `installMonitor()`、`setApiFailureHook` | 4 項 |
| giga-observe | `../giga-observe`(GitLab `giganexus/giga-observe`) | port 51202 / 服務代碼 `observe-api` / 系統代碼 `observe`;`/openapi.json` 13 條 `/api/observe/*`;本機示範 `npm run dev:local`(記憶體 MongoDB,本機 Windows 保留 51202,改 PORT=15202) | 110 項 |
| GigaItApp | `frontend/src/pages/observe/*`、`components/observe/*`、儀表板 | 本機 `OBSERVE_LOCAL` 開發模式;`deploy/gateway-rbac.yaml` 新增 `it.gw-observe.*` | 型別檢查、建置、本機畫面實測 |

### 8.1 測試區上線步驟(需在測試區寫入,執行前確認)

1. 推送 giga-observe 到 GitLab;主機 2 `backend/.env.test`、`deploy/test.env` 就位後 `docker compose --env-file deploy/test.env up -d --build`
2. 建立 Key(明文只顯示一次,存入 Gateway 機密目錄):`gw-bff`(ingest)、`gw-bff-web`(ingest-web)、`gw-nginx`(ingest)、`itapp-api`(ingest)
3. Gateway `test.env` 設定 `MONITOR_URL=http://observe-api:51202` 與三個 `MONITOR_*_API_KEY_FILE`,推送 BFF(develop)部署
4. 新增上游 `observe-api`(`http://observe-api:51202`),匯入 `http://observe-api:51202/openapi.json` 並發佈;giga-observe 設 `GW_JWKS_URL`
5. 套用 GigaItApp `deploy/gateway-rbac.yaml`(需先有 `observe.*` 權限),推送 GigaItApp(develop)部署

### 8.2 測試區部署紀錄(2026-10-06)

- giga-observe:主機 2 `/srv/giganexus/giga-observe`(compose 專案 `giga-observe-test`,`backend/.env.test` 隨機密碼);備份排程已設定回報 Key
- Gateway 機密目錄:`monitor_api_key`(gw-bff)、`monitor_web_api_key`(gw-bff-web,ingest-web)、`monitor_nginx_api_key`(gw-nginx);`test.env` 加入 `MONITOR_*`(備份 `test.env.bak-20261006-monitor`)
- 上游 `observe-api` 與 13 條 `/api/observe/*` 已發佈(版本 37);GigaItApp 權限已由 CI rbac-test 套用

### 8.3 正式區(注記,隨 W3-M 於主機 3 建置)

1. giga-observe 另起一套:`OBSERVE_ENV=prod`、`backend/.env.prod`(新密碼,不可沿用測試區)、`deploy/prod.env`,資料目錄 `data/prod/`;**不可**讓正式區服務送到測試區,反之亦然
2. Key 重新建立(正式區只接受 `*_FILE`):`monitor_api_key`、`monitor_web_api_key`、`monitor_nginx_api_key`,`prod.env` 設定 `MONITOR_*`
3. 正式區 Gateway 匯入 `http://observe-api:51202/openapi.json` 並發佈;GigaItApp `gateway-rbac.yaml` 以 prod 套用
4. 拓樸:`backend/config/topology.json` 的 healthUrl 為測試區網址;主機 3 部署後改成正式區位址(該目錄以 volume 掛載,改完呼叫 `POST /api/v1/admin/topology/reload` 即生效)
5. 告警 Email 通知、Web Vitals 抽樣比例依正式流量再調整
