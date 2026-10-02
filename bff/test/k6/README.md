# k6 壓力測試(IMPL-PLAN W3-5.12、§8 MVP 驗收對照)

| 腳本            | 指標(PRD §4.2)             | 門檻                                                                                                 |
| --------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `proxy.js`      | BFF 吞吐、Gateway 額外延遲 | 單實例 ≥ 1,500 RPS;p95 < 20 ms(以 mock 路由量測 BFF 本身;經上游的額外延遲以 `upstream` 情境比較直連) |
| `login.js`      | 登入延遲                   | p95 < 1 秒(本機帳號,Argon2id)                                                                        |
| `permission.js` | 權限判斷                   | 快取命中時 `gw_permission_check_seconds` p95 < 2 ms(由 `/metrics` 直方圖讀取)                        |

## 注意

- **不要對共用測試區(主機 2)直接跑高負載**:會影響其他人使用與 E2E。正式量測請先通知使用者,或在離峰時段、以單一 BFF 實例(`docker compose stop bff-2`)量測。
- 帳號一律使用假工號(`Z99K6` 開頭)的本機帳號,以 `npm run gw -- local:approve` 建立;不可使用真實員工帳密。
- mock 路由需先以管理 API 或 CLI `apply` 建立並發佈(例 `GET /api/k6/ping`,`auth_mode = authenticated`),測完停用並重新發佈。

## 執行

安裝 k6(https://grafana.com/docs/k6/latest/set-up/install-k6/)後,於 `bff/test/k6`:

```bash
k6 run -e BASE=https://giganexus-test.gigasolar.com.tw -e USER=Z99K6001 -e PASSWORD=<測試密碼> -e PATH_UNDER_TEST=/api/k6/ping proxy.js
```

```bash
k6 run -e BASE=https://giganexus-test.gigasolar.com.tw -e USER=Z99K6001 -e PASSWORD=<測試密碼> login.js
```

```bash
k6 run -e BASE=https://giganexus-test.gigasolar.com.tw -e USER=Z99K6001 -e PASSWORD=<測試密碼> -e PATH_UNDER_TEST=/api/k6/ping permission.js
```

- `RATE`(proxy.js,預設 1500)、`DURATION`(預設 1m)可調整;結果摘要與門檻是否通過由 k6 輸出,請貼到 IMPL-PLAN §8 的驗收紀錄。
- `permission.js` 結束時讀取 `/metrics`(需從內網服務白名單內的主機執行,見 `nginx/allowlists/<區域>/internal-services.conf`),計算權限判斷 p95。
