# language: zh-TW
@mvp @W3-5.8 @W3-5.9
功能: Email 與站內通知
  為了讓各系統以統一方式發送通知,並確保送達可追蹤
  身為後端系統
  我呼叫通知 API 後,由 Gateway 負責排入佇列、發送、重試與紀錄

  # LINE 通知暫緩(PRD Q7),本階段只有 email 與 inapp 通道

  背景:
    假如 通知範本 "BPM_APPROVAL_PENDING" 的預設通道為 "email"、"inapp"
    而且 呼叫端具備權限 "notify.message.send"

  場景: 發送 API 只負責入列
    當 呼叫端送出通知:
      """
      {
        "templateCode": "BPM_APPROVAL_PENDING",
        "to": { "users": ["S112009"] },
        "data": { "formNo": "LV-20261201-001" },
        "idempotencyKey": "bpm-LV-20261201-001-step2"
      }
      """
    那麼 回應狀態為 202
    而且 通知排入佇列 "bull:notify"
    而且 "gw.notify_log" 新增狀態為 "queued" 的紀錄

  場景: 依範本與資料組成 Email
    假如 "S112009" 的 Email 為 "s112009@example.com"
    當 Worker 處理上述通知
    那麼 寄出一封 Email 到 "s112009@example.com",內容包含 "LV-20261201-001"
    而且 "gw.notify_log" 狀態變為 "sent"

  場景: 站內通知即時推播
    假如 "S112009" 已連線 "/ws/notify"
    當 Worker 處理上述通知
    那麼 "gw.notify_message" 新增一筆 "S112009" 的未讀通知
    而且 "S112009" 的 WebSocket 收到新通知

  場景: 以 AD 群組指定收件人
    假如 AD 群組 "GN-HR-Managers" 有 3 位成員
    當 呼叫端送出通知,收件對象為 AD 群組 "GN-HR-Managers"
    那麼 3 位成員各收到一則通知

  場景: 相同 idempotencyKey 不重複發送
    假如 已送出 idempotencyKey 為 "bpm-LV-20261201-001-step2" 的通知
    當 呼叫端在 24 小時內以相同 idempotencyKey 再送一次
    那麼 不會產生新的通知
    而且 回應指出為重複請求

  場景: 發送失敗以指數退避重試,最終進入死信
    假如 SMTP 伺服器持續回應錯誤
    當 Worker 處理通知
    那麼 系統以指數退避重試 5 次
    而且 最終 "gw.notify_log" 狀態為 "dead"
    而且 系統發出告警

  場景: 暫時失敗後重試成功
    假如 SMTP 伺服器第一次回應錯誤,第二次成功
    當 Worker 處理通知
    那麼 "gw.notify_log" 狀態為 "sent",retry_count 為 1

  場景: 要求 LINE 通道時回應不支援
    當 呼叫端送出通知並指定通道 "line"
    那麼 回應狀態為 400
    而且 回應 code 為 "CHANNEL_NOT_SUPPORTED"

  場景: 沒有權限的呼叫端無法發送
    假如 呼叫端沒有權限 "notify.message.send"
    當 呼叫端送出通知
    那麼 回應狀態為 403
