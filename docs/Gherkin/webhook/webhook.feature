# language: zh-TW
@mvp @W3-5.10 @security
功能: 外部系統 Webhook 接收
  為了讓外部系統事件發生時能安全地通知 Gateway
  身為 Gateway
  我只接受來源 IP 正確、簽章有效、未重放且未重複的 Webhook

  # 目前沒有外部來源:2026-10-01 需求方決定 BPM 不送 Webhook(BPM 簽核通知暫不處理);LINE Webhook 暫緩(PRD Q7)。
  # 以下以來源 "partner" 表示任一外部系統;簽章標頭 X-Gw-Timestamp、X-Gw-Signature、Idempotency-Key(BACKEND-GUIDE §7.6)。

  背景:
    假如 Webhook 端點 "partner" 的驗簽方式為 "hmac_sha256",來源 IP 已列入 webhook-sources.conf
    而且 分派目標為佇列

  場景: 合法請求立即回 200 並排入處理
    當 來源主機以正確簽章與目前時間送出 "POST /webhook/partner"
    那麼 回應狀態為 200
    而且 "gw.webhook_log" 新增 verified 為 1 的紀錄
    而且 事件排入處理佇列
    而且 worker 處理後 "gw.webhook_log" 的 processed_at 有值

  場景: 非允許來源 IP 在 Nginx 即被拒絕
    當 其他主機送出 "POST /webhook/partner"
    那麼 回應狀態為 403
    而且 回應 code 為 "IP_NOT_ALLOWED"
    而且 BFF 沒有收到請求

  場景: 簽章錯誤
    當 來源主機以錯誤簽章送出 "POST /webhook/partner"
    那麼 回應狀態為 401
    而且 回應 code 為 "WEBHOOK_SIGNATURE_INVALID"
    而且 "gw.webhook_log" 新增 verified 為 0 的紀錄
    而且 事件不會被處理

  場景大綱: 時間戳超出 ±5 分鐘視為重放
    當 來源主機以正確簽章、時間戳為 <時間> 送出 "POST /webhook/partner"
    那麼 回應狀態為 <狀態>

    例子:
      | 時間        | 狀態 |
      | 4 分鐘前    | 200  |
      | 6 分鐘前    | 401  |
      | 6 分鐘後    | 401  |

  場景: 相同 Idempotency-Key 在 24 小時內只處理一次
    假如 已處理 Idempotency-Key 為 "evt-001" 的事件
    當 來源主機以相同 Idempotency-Key 再次送出
    那麼 回應狀態為 200
    而且 回應 code 為 "DUPLICATE_REQUEST"
    而且 事件不會被重複處理

  場景: 未設定的來源
    當 用戶端送出 "POST /webhook/line"
    那麼 回應狀態為 404
    而且 回應 code 為 "WEBHOOK_SOURCE_NOT_FOUND"
