# language: zh-TW
@mvp @W3-5.10 @security
功能: BPM Webhook 接收
  為了讓 BPM 簽核完成時能安全地通知 Gateway
  身為 Gateway
  我只接受來源 IP 正確、簽章有效、未重放且未重複的 Webhook

  # 本階段只接 /webhook/bpm;LINE Webhook 暫緩(PRD Q7)

  背景:
    假如 Webhook 端點 "bpm" 的驗簽方式為 "hmac_sha256",允許來源 IP 為 BPM 主機
    而且 分派目標為佇列

  場景: 合法請求立即回 200 並排入處理
    當 BPM 主機以正確簽章與目前時間送出 "POST /webhook/bpm"
    那麼 回應狀態為 200
    而且 "gw.webhook_log" 新增 verified 為 1 的紀錄
    而且 事件排入處理佇列
    而且 worker 處理後 "gw.webhook_log" 的 processed_at 有值

  場景: 非允許來源 IP 在 Nginx 即被拒絕
    當 其他主機送出 "POST /webhook/bpm"
    那麼 回應狀態為 403
    而且 回應 code 為 "IP_NOT_ALLOWED"
    而且 BFF 沒有收到請求

  場景: 簽章錯誤
    當 BPM 主機以錯誤簽章送出 "POST /webhook/bpm"
    那麼 回應狀態為 401
    而且 回應 code 為 "WEBHOOK_SIGNATURE_INVALID"
    而且 "gw.webhook_log" 新增 verified 為 0 的紀錄
    而且 事件不會被處理

  場景大綱: 時間戳超出 ±5 分鐘視為重放
    當 BPM 主機以正確簽章、時間戳為 <時間> 送出 "POST /webhook/bpm"
    那麼 回應狀態為 <狀態>

    例子:
      | 時間        | 狀態 |
      | 4 分鐘前    | 200  |
      | 6 分鐘前    | 401  |
      | 6 分鐘後    | 401  |

  場景: 相同 Idempotency-Key 在 24 小時內只處理一次
    假如 已處理 Idempotency-Key 為 "bpm-evt-001" 的事件
    當 BPM 主機以相同 Idempotency-Key 再次送出
    那麼 回應狀態為 200
    而且 回應 code 為 "DUPLICATE_REQUEST"
    而且 事件不會被重複處理

  # 簽章標頭:X-Gw-Timestamp、X-Gw-Signature、Idempotency-Key(BACKEND-GUIDE §7.6)
  # BPM 事件內容格式尚未定義(2026-10-01 需求方決定先不做),事件目前只記錄不處理
  @wip
  場景: BPM 簽核完成後通知申請人
    當 BPM 主機送出簽核完成事件,申請人為 "S112009"
    那麼 "S112009" 收到 Email 與站內通知

  場景: 未設定的來源
    當 用戶端送出 "POST /webhook/line"
    那麼 回應狀態為 404
    而且 回應 code 為 "WEBHOOK_SOURCE_NOT_FOUND"
