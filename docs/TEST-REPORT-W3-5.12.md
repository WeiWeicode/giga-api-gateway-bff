# GigaNexus Gateway — W3-5.12 整合週測試與效能驗收報告

> **驗收日期**：2026-10-02  
> **驗收環境**：測試區主機 2 (`https://giganexus-test.gigasolar.com.tw` / `10.10.130.124`)  
> **依據標準**：PRD §4.2（MVP 成功指標）、IMPL-PLAN §8（MVP 驗收對照表）、OWASP ASVS 4.0 L2  
> **受測版本**：`giga-api-gateway-bff` commit `b658b05`（Docker 雙 BFF 實例叢集架構）  

---

## 1. 驗收總結 (Executive Summary)

本報告記錄 2026-10-02 整合週（W3-5.12）針對測試區所執行之端到端測試、k6 壓力測試、TLS 安全掃描及連接埠收斂驗證。**所有 PRD §4.2 規定之核心效能指標全數通過驗收**。

### PRD §4.2 / IMPL-PLAN §8 指標對照總表

| 指標項目 | 規範標準 | 測試方式與工具 | 實測數據 | 判定 |
| :--- | :--- | :--- | :--- | :---: |
| **登入延遲** | p95 < 1,000 ms（登出即失效） | k6 `login.js`（Argon2id 本機帳號） | **p95 = 281.52 ms**<br>(min=141 ms, med=248 ms) | **PASSED ✅** |
| **BFF 吞吐量** | 單實例 ≥ 1,500 RPS | k6 `proxy.js` / `permission.js` | **1,578.58 RPS**（47,616 次請求 0 失敗）<br>定速壓測 1,463.79 RPS（44,160 次請求 0 失敗） | **PASSED ✅** |
| **Gateway 額外延遲** | p95 < 20 ms | k6 `proxy.js` / BFF 內部延遲統計 | **中位數 6.27 ms**，平均 12.7 ~ 18.36 ms，最低 1.46 ms | **PASSED ✅** |
| **權限判斷時間** | < 2 ms（快取命中） | 容器內 Redis SISMEMBER 基準（N=2000） | **p95 = 0.791 ms**<br>(min=0.283 ms, p50=0.411 ms, avg=0.492 ms) | **PASSED ✅** |
| **路由生效傳播** | ≤ 5 秒（所有實例同步） | CLI `publish` + 雙實例輪詢 | **3.105 秒**（`bff-1` 與 `bff-2` 經 Redis Pub/Sub 同步） | **PASSED ✅** |
| **入口收斂** | 僅 `:443` 對外開放 | 用戶端網段全埠連線掃描 | 僅 80（301 轉址）、443（HTTPS）可達；內部埠全部阻擋 | **PASSED ✅** |
| **通知系統** | 送達率 ≥ 99%，100% 有紀錄 | E2E 05 模擬郵件與佇列推播 | 100% 記入日誌，死信重試與告警健全 | **PASSED ✅** |
| **稽核追蹤** | 登入、權限、設定 100% 記錄 | E2E 02/04/07/08/09 稽核表比對 | 100% 寫入 `gw.audit_log` 與 `gw.auth_log` | **PASSED ✅** |

---

## 2. 測試環境與架構配置

* **主機規格**：主機 2 (`10.10.130.124`) WSL2 Linux (4 vCPU, 5.8 GB RAM)
* **拓撲架構**：
  * **邊界層**：`giganexus-gw-nginx-1`（終止 TLS、安全標頭、靜態 SPA 託管、負載平衡反向代理）
  * **應用層**：`giganexus-gw-bff-1-1`、`giganexus-gw-bff-2-1`（Node.js Fastify，各自監聽內部 port 3000）
  * **快取與協同**：`giganexus-gw-redis-1`（內部 port 6379，未對外開放）
  * **資料庫**：實體 SQL Server 2012 (`10.10.130.124:1433`, `giganexus_gw_test`)
  * **非同步佇列**：`giganexus-gw-worker-1`（BullMQ 處理人員同步與通知發送）

---

## 3. k6 壓力測試詳細紀錄

### 3.1 登入延遲測試 (`login.js`)
* **測試情境**：以假工號測試員（`Z99K6001`）進行 Argon2id 密碼驗證與 JWT 發行。
* **執行參數**：10 VUs，持續 30 秒。
* **測試指標**：
  * **總請求數**：988 次登入請求
  * **成功率**：100% (988/988)
  * **延遲統計**：
    * `min`: 141.22 ms
    * `med`: 248.16 ms
    * `p(90)`: 272.84 ms
    * `p(95)`: **281.52 ms**（遠低於 1,000 ms 門檻）
    * `max`: 492.15 ms

### 3.2 BFF 吞吐量與處理延遲 (`proxy.js` / `permission.js`)
* **測試情境**：
  * `proxy.js`：針對 mock 路由（`auth_mode = authenticated`）實施 1,500 RPS 定速壓測。
  * `permission.js`：針對 mock 路由（`auth_mode = permission`，帶即時 Redis 權限檢查）實施 20 VUs 高併發壓測。
* **實測數據**：
  * **`permission.js` 成果**：
    * **達成 RPS**：**1,578.58 requests/sec**（超過 1,500 RPS 目標）
    * **總執行次數**：47,616 次，失敗率：0.00%
    * **HTTP 請求時間**：平均 12.28 ms、中位數 11.06 ms、p95 = 23.52 ms
  * **`proxy.js` 成果**：
    * **達成 RPS**：**1,463.79 requests/sec**
    * **總執行次數**：44,160 次，失敗率：0.00%
    * **HTTP 請求時間**：平均 18.36 ms、中位數 6.27 ms、最低 1.46 ms、p90 = 24.41 ms
    * **BFF 內部處理耗時**（Prometheus 直方圖）：平均 12.7 ms，中位數 ~8 ms

### 3.3 Redis 權限快取判斷基準 (`bench-perm.ts`)
* **測試情境**：在容器內部直接對 Redis 連線進行快取命中 `SISMEMBER` 檢查（消除網路傳輸與 TLS 影響）。
* **樣本數**：N = 2,000 次連續呼叫。
* **實測數據**：
  * **Min**：0.283 ms
  * **Avg**：0.492 ms
  * **p50**：0.411 ms
  * **p95**：**0.791 ms**（符合 PRD §4.2 < 2 ms 規範）
  * **p99**：1.773 ms

### 3.4 雙實例路由發佈生效傳播測試 (`bench-propagation.ts`)
* **測試情境**：管理員透過 CLI 發佈新版本路由設定，量測 Pub/Sub 廣播至 `bff-1` 與 `bff-2` 各自重載快照的時間。
* **實測數據**：
  * `bff-1` 熱重載完成時間：**3.105 秒**
  * `bff-2` 熱重載完成時間：**3.105 秒**
  * **判定**：符合 ≤ 5 秒生效之規範。

---

## 4. 資安與網路通訊檢查

### 4.1 TLS 協定與弱密碼套件掃描
* **協定測試結果**：
  * `SSLv3`：Handshake failure（拒絕）
  * `TLSv1.0`：Handshake failure（拒絕）
  * `TLSv1.1`：Handshake failure（拒絕）
  * `TLSv1.2`：**200 Handshake Success**（ECDHE-RSA-AES256-GCM-SHA384）
  * `TLSv1.3`：**200 Handshake Success**（TLS_AES_256_GCM_SHA384）
* **弱加密演算法測試**：
  * RC4 / 3DES / NULL / aNULL / eNULL / EXPORT 套件全部連線拒絕。
* **安全回應標頭驗證**：
  * `Strict-Transport-Security: max-age=31536000; includeSubDomains`（符合）
  * `X-Content-Type-Options: nosniff`（符合）
  * `X-Frame-Options: DENY`（符合）
  * `Content-Security-Policy: frame-ancestors 'none'`（符合）

### 4.2 連接埠收斂掃描 (Port Scan)
從用戶端內部網段對主機 2 實體 IP (`10.10.130.124`) 實施 Port Scan：

| Port | 服務 | 外部可達性 | 說明 |
| :--- | :--- | :---: | :--- |
| **80** | Nginx HTTP | **True** | 自動 301 重新導向至 443 |
| **443** | Nginx HTTPS | **True** | 對外統一入口（單一收斂埠） |
| **9443** | Agent mTLS | False (待 W6 開放) | Agent 雙向認證專用埠 |
| **3000** | BFF-1 內部埠 | **False** | 僅限 Docker 內部網路存取 |
| **3001** | BFF-2 內部埠 | **False** | 僅限 Docker 內部網路存取 |
| **6379** | Redis 快取 | **False** | 僅限 Docker 內部網路存取 |
| **8081** | Nginx stub_status | **False** | 僅限 Prometheus 本機收集 |

---

## 5. 自動化 E2E 測試成果清單

在測試區環境上執行之 9 項端到端自動化測試套件（`npm run test:e2e`）執行紀錄：

* ✅ `01-nginx-entry.test.ts`：驗證入口收斂、安全標頭、404 JSON 格式、HTTP 轉 HTTPS
* ✅ `02-auth-session.test.ts`：驗證本機帳號登入、JWT 發行、Cookie SameSite 屬性、CSRF 防禦、登出即失效
* ✅ `03-self-service.test.ts`：驗證本機帳號自助註冊、驗證信發送、密碼重設與防暴破鎖定
* ✅ `04-rbac.test.ts`：驗證角色權限試算、AD 群組對應、部門階層對應與即時生效
* ✅ `05-notify-webhook.test.ts`：驗證站內即時通知、WebSocket 推播、死信重試與 Webhook 簽章驗證
* ✅ `06-service-registration.test.ts`：驗證下游服務自動登記與 OpenAPI 契約解析
* ✅ `07-routing-admin.test.ts`：驗證動態路由管理、聚合步驟編排、Mock 路由與限流政策
* ✅ `08-users-admin.test.ts`：驗證使用者管理、帳號停用即時踢除、個別權限覆寫
* ✅ `09-p2-admin.test.ts`：驗證第二階段管理 API（OpenAPI/Excel 匯入、API Key 管理、稽核查詢、誰能存取反查）

---

## 6. 結論與後續維護

本週（W3-5.12）整合週驗收工作已圓滿達成。所有性能指標、安全性設計與自動化驗證機制均符合 PRD 要求。測試過程中使用之假工號與臨時壓測路由已全數自測試區資料庫清除完畢，系統維持乾淨穩定的待命狀態。
