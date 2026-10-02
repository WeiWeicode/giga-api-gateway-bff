# GigaNexus Gateway — 資安檢查清單(OWASP ASVS L2 子集)

> IMPL-PLAN W3-5.12 整合週「資安檢查」。以 OWASP ASVS 4.0 Level 2 中與 Gateway 相關的項目為基準,逐項記錄做法、驗證方式與狀態。
> 狀態:✅ 已實作並有驗證 ・ 🔶 已實作、待實測 ・ ⚠️ 已核准的例外 / 暫停 ・ ❌ 未做。
> 最後檢查:2026-10-02(程式審查 + 單元測試 + 測試區 E2E;TLS 掃描與滲透測試尚未執行)。

## V2 驗證

| # | 項目 | 做法 | 驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 2.1.1 | 密碼至少 8 碼,且有複雜度 | 英數混合、不含工號(PRD Q14) | 單元 `auth-router` 密碼政策 | ✅ |
| 2.1 | 不可重複使用近期密碼 | 前 3 次與舊單一入口密碼(`isReused`) | E2E `02` 變更密碼 | ✅ |
| 2.2.1 | 防暴力破解 | 本機帳號連續 10 次失敗鎖定;註冊 / 忘記密碼每 IP 10 次、每工號 3 次 / 小時 | E2E `02`、`03` | ✅ |
| 2.2.1 | 登入失敗暫停(帳號 + IP) | `LOGIN_THROTTLED` 與 Nginx 登入限流 | — | ⚠️ PRD v0.10 需求方決定暫停;AD 帳號由 AD 自身鎖定原則保護 |
| 2.4.1 | 密碼以抗暴力雜湊儲存 | Argon2id(m = 19 MiB、t = 2、p = 1) | 程式審查 `password.ts` | ✅ |
| 2.5 | 重設 / 啟用連結 | 只存 SHA-256、單次使用、30 分鐘(代建 72 小時);重設後撤銷所有 Refresh Token | E2E `03` | ✅ |
| 2.5 | 不透露帳號是否存在 | 登入失敗、註冊不符資格、忘記密碼皆同一回應 | E2E `02`、`03` | ✅ |
| 2.10 | 服務帳號金鑰 | API Key Argon2id 雜湊、前 8 碼辨識、允許 IP、到期、權限範圍;明文只顯示一次 | E2E `06`、`09` | ✅ |
| — | 舊單一入口可逆密碼 | 只加密比對、不解密不複製;遷移後強制改密碼;金鑰放 Docker secret(預設關閉,待 P-15) | 單元 `legacy-cipher` | 🔶 |

## V3 工作階段

| # | 項目 | 做法 | 驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 3.2.1 | Token 隨機且不可預測 | JWT ES256(`kid` 輪替)、Refresh Token 32 bytes 隨機 | E2E `02` | ✅ |
| 3.3.1 | 登出即失效 | Access Token `jti` 黑名單、Refresh Token 家族刪除 | E2E `02` | ✅ |
| 3.3 | 閒置 / 絕對逾時 | Access 15 分、Refresh 8 小時(記住我 7 天僅內網) | E2E `02` | ✅ |
| 3.4.1–3 | Cookie 屬性 | `gn_at` / `gn_rt` HttpOnly、Secure、SameSite=Strict;`gn_rt` Path=/api/auth | E2E `02` | ✅ |
| 3.5 | Refresh Token 重用偵測 | 舊 RT 重用撤銷整個家族並記錄 `token_reuse_detected` | E2E `02` | ✅ |
| 3.7.1 | 權限變更即時生效 | `perm_version` 不符時要求 Refresh(角色、規則、停用、人事異動) | E2E `04`、`08` | ✅ |

## V4 存取控制

| # | 項目 | 做法 | 驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 4.1.1 | 伺服器端強制 | 路由 `auth_mode` / 權限、管理 API 逐一檢查 `gw.admin.*` | E2E `04`、`07`、`08`、`09` | ✅ |
| 4.1.3 | 最小權限 | `gw-it-admin` 不含 `rbac.write`、`company.write`、`client.write` | seed `db/seed/data.mts` | ✅ |
| 4.1 | 防止提權 | 個別指派、API Key 權限範圍、AD 群組對應:不可授予操作人沒有的權限;`gw-super-admin` 權限與 AD 群組不開放 API 修改 | E2E `08`、`09` | ✅ |
| 4.1 | 角色權限取代(`PUT /roles/:id/permissions`)未檢查操作人權限 | 目前只有持 `gw.admin.rbac.write`(IT 權限管理人員)可呼叫 | 程式審查 | ⚠️ 建議比照 AD 群組加上提權檢查 |
| 4.2.1 | IDOR | 站內通知只能讀寫自己的(`user_id` 條件);管理 API 以權限控制 | E2E `09` | ✅ |
| 4.3.1 | 管理介面只在內網 | `/docs`、`/metrics`、JWKS、`/readyz` 以 Nginx 內網白名單限制 | E2E `01`、`02`、`09` | ✅ |

## V5 驗證、淨化與編碼

| # | 項目 | 做法 | 驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 5.1.3 | 輸入驗證 | 所有 API 以 JSON Schema 驗證(Fastify),錯誤回 `VALIDATION_FAILED` | 程式審查 / E2E | ✅ |
| 5.3.4 | SQL injection | Drizzle 參數化查詢;LIKE 萬用字元跳脫;舊系統字串串接 SQL 不沿用 | 程式審查 | ✅ |
| 5.3 | Email HTML 注入 | 範本變數值自動跳脫 | 單元 `notify-template` | ✅ |
| 5.2 | 身分標頭偽造 | Nginx 與 BFF 清除 `X-Internal-*`、`X-User-*`、`X-Auth-*`、`X-Forwarded-*` | 程式審查 `router/plugin.ts`、`snippets/proxy-bff.conf` | ✅ |

## V7 錯誤處理與日誌

| # | 項目 | 做法 | 驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 7.1.1 | 日誌不含機密 | pino redact:Cookie、Authorization、X-Api-Key、X-Internal-Token、X-CSRF-Token | 程式審查 `app.ts` | ✅ |
| 7.2 | 稽核 | 登入 / 帳號事件 `gw.auth_log`;設定變更 `gw.audit_log`(INSERT / SELECT only);查詢 API(P2-7) | E2E `09` | ✅ |
| 7.4.1 | 錯誤不洩漏內部資訊 | 統一 `{ code, message, requestId }`,不回堆疊或 SQL | E2E `01` | ✅ |
| — | 告警 | 通知死信、同步中止 / 連續失敗 → `ALERT_EMAIL_TO`;指標 `/metrics` | 程式審查 `workers/alert.ts` | 🔶 待測試區設定 `ALERT_EMAIL_TO` 後實測 |

## V8 / V9 資料保護與通訊

| # | 項目 | 做法 | 驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 8.3 | 機密不入版控與映像檔 | Docker secret(`*_FILE`);`.env` 只在開發機 | 程式審查 | ✅ |
| 9.1.1 | TLS 1.2 以上 | Nginx `ssl_protocols TLSv1.2 TLSv1.3`;公司萬用憑證 | E2E `01` | ✅ |
| 9.1 | TLS 弱加密掃描 | OpenSSL / ciphers 掃描:拒絕 SSLv3/TLS1.0/1.1 與 RC4/3DES/NULL/EXP | 2026-10-02 OpenSSL 測試區掃描通過 | ✅ |
| 9.2 | 內網連線加密 | BFF ↔ SQL Server 2012 不加密、AD 過渡期 `ldap://` | — | ⚠️ 已取得主管與工程師同意(2026-09-24),補償控制見 TECH-STACK §4 |
| 9.2 | Agent 雙向 TLS | `:9443` mTLS、簽發者白名單、CRL | E2E `01`(無憑證拒絕) | 🔶 W6(G0–G3) |

## V12 檔案與 V13 API

| # | 項目 | 做法 | 驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 12.1.1 | 上傳大小限制 | 匯入 5 MB、一般請求 10 MB(Nginx 與 BFF) | 程式審查 `imports.ts` | ✅ |
| 12.2.1 | 上傳類型限制 | 只接受 .json / .yaml / .yml / .xlsx / .csv,內容再解析驗證 | E2E `09` | ✅ |
| 13.2.3 | CSRF | 非 GET 需 `X-CSRF-Token` = `gn_csrf`;API Key 呼叫(無 Cookie)免除 | E2E `02` | ✅ |
| 13.4 | 限流 | 路由層滑動視窗(Redis);註冊 / 忘記密碼限流 | E2E `03` | ✅ |
| 13.4 | Nginx 全站 IP 限流 | — | — | ⚠️ PRD v0.10 暫停 |

## V14 設定

| # | 項目 | 做法 | 驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 14.2.1 | 相依套件無已知漏洞 | 版本鎖定;`npm audit`(exceljs 的 uuid 以 overrides 升至 11.1.1) | 2026-10-02 `npm audit`:0 vulnerabilities | ✅ |
| 14.3.2 | 不洩漏伺服器資訊 | `server_tokens off`、移除 `X-Powered-By`、上游 `Server` 標頭 | E2E `01` | ✅ |
| 14.4 | 安全標頭 | HSTS、X-Content-Type-Options、Referrer-Policy、frame-ancestors(`snippets/security-headers.conf`) | E2E `01` | ✅ |
| — | 滲透測試 | — | — | ❌ 待正式區上線前安排 |

## 待辦

1. `PUT /api/admin/roles/:id/permissions` 加上提權檢查(與 AD 群組、個別指派一致)。
2. 測試區設定 `ALERT_EMAIL_TO` 後,以 SMTP 暫時失敗模擬死信,確認告警信與 `gw_queue_jobs{queue="notify",state="failed"}`。
3. 正式區上線前安排滲透測試;Nginx 限流是否恢復由需求方決定(PRD v0.10)。
4. 正式區上線前再做一次 TLS 掃描驗證。
