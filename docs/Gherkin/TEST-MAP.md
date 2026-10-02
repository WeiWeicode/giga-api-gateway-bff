# Gherkin 場景 ↔ 自動化測試對照表

> 2026-10-02 決定:**不引入 Cucumber 步驟定義**。Gherkin 維持驗收規格文件,自動化以 Vitest(單元 `bff/test/unit`、測試區 E2E `bff/test/e2e`)執行,本表記錄每個場景由哪個測試涵蓋。
> 「未自動化」註明原因;新增場景或測試時同步更新本表(IMPL-PLAN §7 完成定義)。
> 縮寫:`U:檔名` = `bff/test/unit/<檔名>.test.ts`;`E:NN` = `bff/test/e2e/NN-*.test.ts`;`S` = `samples/node-backend` 的 `npm test`。

## gateway/nginx-entry.feature(W3-2)

| 場景 | 測試 |
| --- | --- |
| HTTP 一律轉址到 HTTPS | E:01 |
| 只接受 TLS 1.2 以上 | E:01 |
| SPA 子路徑在重新整理深層頁面時回傳該系統的 index.html | E:01 |
| 帶 hash 的靜態資源長期快取 | E:01 |
| 清除使用者偽造的內部身分標頭 | 未自動化(測試區無模擬上游可觀察標頭);程式審查 `router/plugin.ts`、`snippets/proxy-bff.conf` |
| 回應不洩漏伺服器資訊 | E:01 |
| 登入 API 不受 Nginx 限流 | 未自動化(PRD v0.10 暫停後的行為;以設定審查) |
| 通知 WebSocket 可長時間維持 | 未自動化(1 小時);E:05 驗證連線與推播 |
| 串流 WebSocket 透過 auth_request 驗證後直連 Endpoint Server | 未自動化(Endpoint Server 於 W6 部署) |
| 未登入者無法建立串流 WebSocket | 未自動化(同上) |

## gateway/agent-mtls.feature(W6)

全部 `@wip`:隨 W6-G0 改寫 `agent.conf` 後補 E2E;目前 E:01 只驗證無憑證連線被拒。

## auth/ad-login.feature(W3-4.2)

| 場景 | 測試 |
| --- | --- |
| 只輸入工號時依公司網域順序驗證 | 未自動化(E2E 不使用真實 AD 帳密) |
| 舊網域驗證失敗時改試新網域 | 未自動化(同上) |
| 帶網域的帳號直接到指定網域驗證 | U:auth-router(帳號格式);AD 驗證未自動化 |
| 密碼錯誤時回應不透露細節 | U:auth-router(AD 錯誤分類)、E:02(本機帳號同一代碼) |
| 連續輸錯密碼不暫停嘗試 | 未自動化 |
| 登入時同步 AD 群組並對應角色 | 未自動化(真實 AD) |
| 人事資料取自人員同步,不取自 AD | U:auth-router(人事資料合併)、U:employee-sync |
| 人員同步尚未涵蓋時即時補查 BPM / LOS | U:auth-router(合併規則);補查未自動化 |
| BPM / LOS 都無法連線時仍可登入 | 未自動化(不可停止共用來源) |

## auth/token-session.feature(W3-4.4–4.5、4.9)

| 場景 | 測試 |
| --- | --- |
| Cookie 屬性正確 | E:02 |
| 非 GET 請求缺少 CSRF 標頭時拒絕 | E:02 |
| CSRF 標頭與 Cookie 相符時放行 | E:02 起所有寫入請求 |
| Access Token 過期時以 Refresh Token 換發 | E:02 |
| 舊 Refresh Token 被重複使用時撤銷整個家族 | E:02 |
| 登出後 Access Token 立即失效 | E:02 |
| 記住我只在公司內網提供 | 未自動化(需外網來源 IP) |
| IT 變更角色後,使用者下一次請求就重新計算權限 | E:04、E:08 |
| 轉發上游時附上短效內部 Token | S(Token 驗證);經 BFF 轉發未自動化(測試區無模擬上游) |
| 下游可由 JWKS 取得公鑰 | E:02(對外不開放)、S |

## auth/local-account.feature(W3-4.14–4.15)

| 場景 | 測試 |
| --- | --- |
| 已有本機帳號者以資料庫密碼驗證 | E:02 |
| 無網域公司的員工尚未註冊時引導註冊 | 未自動化(需 LOS 無網域公司的員工資料) |
| 查無此工號的所屬公司時嘗試全部網域 | 未自動化(真實 AD) |
| 兼任帳號不可單獨登入 | 未自動化(需 LOS 兼任資料);U:employee-sync(兼任帳號判斷) |
| 密碼政策 | U:auth-router |
| 不可與前 3 次密碼相同 | E:02、U:auth-router |
| 連續 10 次失敗鎖定帳號 | E:02 |
| 登入成功後失敗次數歸零 | 程式審查 `login.ts`(loginLocal) |
| 密碼只以 Argon2id 雜湊儲存 | 程式審查 `password.ts` |
| IT 代建後本人以啟用連結設定密碼 | E:03、E:08 |
| 啟用連結過期 | E:03(重設連結過期,同一機制) |

## auth/self-registration.feature(W3-5.8a)

| 場景 | 測試 |
| --- | --- |
| LOS / BPM 有 Email 時寄驗證連結 | 未自動化(E2E 使用 LOS / BPM 查無的假工號) |
| 驗證只寄到 LOS / BPM 登記的 Email | E:03(自填 Email 不被採用) |
| 沒有 Email 時比對到職日後直接啟用並通知主管 | 未自動化(同上) |
| LOS / BPM 都找不到時轉管理員審核 | E:03 |
| 不符資格時一律回覆相同訊息 | E:03 |
| 註冊請求限流 | E:03 |
| 在舊入口註冊過的員工也可以直接到新入口網註冊 | 未自動化 |

## auth/password-reset.feature(W3-5.8b)

| 場景 | 測試 |
| --- | --- |
| 有 Email 時寄送重設連結 | E:03 |
| 重設連結過期 | E:03 |
| 查無帳號時回應與成功時相同 | E:03 |
| AD 帳號不走本機忘記密碼 | E:03 |
| 沒有 Email 由 IT 重設並強制首次登入改密碼 | E:02、E:08 |
| IT 解鎖被鎖定的帳號 | E:02、E:08 |
| 已登入者變更密碼 | E:02 |

## auth/legacy-migration.feature(W3-4.16)

| 場景 | 測試 |
| --- | --- |
| 舊演算法(DES-CBC、PKCS7、MD5 金鑰)| U:legacy-cipher(與 OpenSSL des-cbc 對照) |
| 其餘場景 | 未自動化:遷移預設關閉,待 P-15 以**現行系統**建立的測試帳號確認密文一致後開啟,再補 E2E(`@wip` 保留) |

## auth/apps.feature(P2-3a)

| 場景 | 測試 |
| --- | --- |
| /api/auth/me 只回傳有權限的應用 | E:02、E:04 |
| 同時有兩個應用權限 | E:04 |
| 沒有 IT 應用權限時導回員工入口網 | 各 SPA(giga-Portal、GigaItApp)測試 |
| 未登入時先登入再回到原頁 | 各 SPA 測試 |
| 停用的應用不出現在清單 | 程式審查 `rbac/permission.ts`(appsOf) |

## employee-sync/employee-sync.feature(W3-4.6a–c)

| 場景 | 測試 |
| --- | --- |
| 同一欄位 BPM 有值用 BPM,否則用 LOS | U:auth-router |
| 只更新有變更的人 | 程式審查 `auth/employee-sync.ts`(profile_hash);整合測試待 P-04 |
| 部門變更時遞增權限版本 | 程式審查 `auth/profile.ts`(applyProfile) |
| 公司歸屬取自 LOS 的 CompName | U:auth-router |
| 遇到新公司時自動建立並通知 IT | 程式審查;告警 `workers/employee-sync.worker.ts` |
| 兼任帳號併入本人 | U:auth-router、U:employee-sync |
| 兼任帳號找不到本人時告警 | U:employee-sync(orphans) |
| 不同工號不歸戶 | U:employee-sync |
| 離職只標記並通知 IT,不自動停用 | 程式審查;告警 `workers/employee-sync.worker.ts` |
| 個資欄位不讀取也不儲存 | 唯讀 view 不含個資欄位(`db/dba/01-los-portal-readers.sql`) |
| 來源筆數異常時中止同步 | U:employee-sync(checkSourceCount) |
| 單一來源停機時只用另一來源更新,不清空欄位 | 程式審查(applyProfile keepExisting);整合測試待 P-04 |
| 連續 3 次同步失敗發出告警 | 程式審查(consecutiveSourceFailures) |
| 多個 BFF 實例下同一時間只執行一次同步 | BullMQ 排程(worker concurrency 1) |
| 手動觸發與同步紀錄 | E:09 |

## rbac/permission.feature(W3-4.6–4.8)

| 場景 | 測試 |
| --- | --- |
| 依 auth_mode 決定是否需要登入與權限 | E:04(authenticated / permission)、E:09(api_key) |
| 無權限時回應統一格式 | E:04 |
| AD 群組自動對應角色 | 未自動化(真實 AD);對應設定 API:E:09 |
| 公司預設角色適用本機帳號 | E:08 |
| 兼任公司的角色併入本人 | U:rbac-rules |
| 個別指派可設定到期日 | 程式審查 `rbac/permission.ts`(validTo) |
| 權限快取命中時判斷在 2 毫秒內完成 | k6 `bff/test/k6/permission.js` + `/metrics`(gw_permission_check_seconds) |
| 角色權限變更後遞增權限版本 | E:04 |
| 反查誰可以呼叫某支 API | E:09 |

## rbac/role-rules.feature(P2-3a)

| 場景 | 測試 |
| --- | --- |
| 規則比對人事欄位 | U:rbac-rules |
| 規則內多個條件須同時符合 | U:rbac-rules |
| 人事異動後權限自動調整 | 程式審查(人員同步遞增 perm_version,W3-4.6b) |
| 指派規則變更立即生效 | E:04 |
| 權限試算與實際登入結果一致 | E:04 |
| 按鈕權限等於 API 權限 | 規格(同一權限代碼),無獨立測試 |
| 權限以樹狀回傳供設定畫面使用 | E:04 |

## router/dynamic-routing.feature(W3-5.1–5.5)

| 場景 | 測試 |
| --- | --- |
| 依路由表轉發並改寫路徑 | U:auth-router(路徑改寫);轉發未自動化(測試區無模擬上游) |
| 沒有對應路由時回 404 | E:01 |
| 明確路徑優先於萬用字元 | U:auth-router(記憶體路由樹) |
| 清理上游回應標頭、路由層限流、GET 回應快取、上游逾時 504、冪等重試、斷路器、上游回 401 | 未自動化(測試區無模擬上游;IMPL-PLAN §6) |
| 聚合路由(4 個場景) | U:auth-router(路徑範本);其餘未自動化(同上);路由試打可人工驗證(E:09 驗證 mock) |

## router/release-publish.feature(W3-5.6–5.7、P2-2)

| 場景 | 測試 |
| --- | --- |
| 編輯草稿不影響線上 | E:07 |
| 發佈後 5 秒內所有實例生效 | E:07(發佈後生效;5 秒量測未自動化) |
| 先提交資料庫,再更新 Redis | 程式審查 `db/sync/release.ts` |
| Redis 更新失敗時由補償機制修正 | 未自動化(不可干擾共用測試區) |
| Redis 不可用時既有路由仍可服務 | 未自動化(同上) |
| BFF 重啟時 Redis 與資料庫皆不可用 | 未自動化(同上) |
| 亂序或重複的版本通知不會造成回退 | U:auth-router(版本只前進) |
| 回滾到歷史版本 | E:07 |
| 認證與管理 API 不受路由表影響 | U:auth-router(保留路徑略過) |
| 測試區驗證過的版本推送到正式區 | 已取消(PRD Q3 v0.5:兩區設定不互通) |

## router/route-admin.feature(P2-1)

| 場景 | 測試 |
| --- | --- |
| 修改只寫資料庫,下次發佈才生效 | E:07 |
| 樂觀鎖防止覆蓋他人的修改 | E:07 |
| 新增路由的檢查 | E:07、U:routing-rules |
| 上游位址的 port 限制 | E:07、U:routing-rules |
| 仍被使用的上游不可停用 | E:07 |
| 仍被路由參照的限流政策不可刪除 | E:07 |
| 聚合步驟整組取代 | E:07(非聚合路由不可設定步驟) |
| 健康檢查 | E:07 |
| 路由試打(`POST /api/admin/routes/:id/test`) | E:09 |

## router/api-import.feature(W3-5.7、P2-4)

| 場景 | 測試 |
| --- | --- |
| 每個 operation 轉成一條路由 | U:auth-router、U:openapi |
| 匯入 API 用途說明與行為規格 | U:openapi |
| 說明超過 1000 字時列為錯誤 | U:openapi |
| 以 x-gateway-path 指定對外路徑 | U:auth-router |
| 缺少 x-permission 的 operation 列為錯誤 | U:auth-router |
| x-permission 對應 auth_mode | U:auth-router |
| 權限代碼不存在時可一併建立 | E:09(表格 createPermissions);OpenAPI 由 x-permissions 建立:E:06 |
| 重新匯入時標示修改與不變 | U:route-table(routeAction)、E:06 |
| 路徑衝突時列為錯誤 | E:07(管理 API);匯入程式審查 `route-import.ts` |
| 上游 port 不在規定區間時拒絕 | U:auth-router、E:06、E:09 |
| 匯入批次留存紀錄 | E:09(預覽 / 提交批次) |
| Excel / CSV 範本與逐列檢查 | U:route-table、E:09 |

## router/service-registration.feature(W3-5.7a)

全部場景:E:06;依部署區自動註冊:S。

## notify/notification.feature(W3-5.8–5.9)

| 場景 | 測試 |
| --- | --- |
| 發送 API 只負責入列 | E:05 |
| 依範本與資料組成 Email | U:notify-template |
| 站內通知即時推播 | E:05;收件匣 API:E:09 |
| 以 AD 群組指定收件人 | 未自動化(需登入過的 AD 使用者) |
| 相同 idempotencyKey 不重複發送 | E:05 |
| 發送失敗以指數退避重試,最終進入死信 | 未自動化(需模擬 SMTP 失敗);死信告警程式審查 `workers/alert.ts` |
| 暫時失敗後重試成功 | 未自動化(同上) |
| 查無或沒有 Email 的收件人只記錄不寄送 | E:05 |
| 測試區的 Email 一律改寄測試信箱 | U:notify-template |
| 要求 LINE 通道時回應不支援 | E:05 |
| 沒有權限的呼叫端無法發送 | E:05 |
| 範本管理與發送紀錄查詢(P2-7) | E:09 |

## admin/user-admin.feature(P2-3)

| 場景 | 測試 |
| --- | --- |
| 個別指派角色後已登入者須換發 Token | E:08 |
| 不可授予自己沒有的權限 | E:08、E:09(API Key) |
| 停用使用者與強制登出 | E:08 |
| 樂觀鎖 | E:08 |
| 公司網域與預設角色 | E:08 |
| 本機帳號審核、代建、重設、解鎖、停用 | E:08 |
| 角色 / 權限 / AD 群組管理、稽核查詢 | E:09 |

## webhook/webhook.feature(W3-5.10)

| 場景 | 測試 |
| --- | --- |
| 合法請求立即回 200 並排入處理 | E:05 |
| 非允許來源 IP 在 Nginx 即被拒絕 | E:01 |
| 簽章錯誤 | E:05、U:webhook-signature |
| 時間戳超出 ±5 分鐘視為重放 | E:05、U:webhook-signature |
| 相同 Idempotency-Key 在 24 小時內只處理一次 | E:05 |
| 未設定的來源 | E:05 |
| 分派到上游路由(dispatch_type = route) | 未自動化(目前沒有外部來源與模擬上游);程式審查 `workers/webhook.worker.ts` |
