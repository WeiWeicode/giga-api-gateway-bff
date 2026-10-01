# language: zh-TW
@W6 @e2e @security @wip
功能: Agent 專用通道(:9443 mTLS + HTTPS / WebSocket)
  為了讓端點 Agent(Rust)以裝置身分與 Endpoint Server 長連線
  身為 Gateway 維運人員
  我需要在獨立 port 強制驗證裝置憑證,且不影響瀏覽器使用者

  # 未實作(2026-10-01):nginx/conf.d/agent.conf 仍為 gRPC 版,待 W6-1 訊息協定定版後改寫(ENDPOINT-AGENT-GUIDE §10 G0)

  # 2026-10-01 由 gRPC 改為 HTTPS / WebSocket(PRD v0.9 §7.6)。
  # 現行 nginx/conf.d/agent.conf 仍為 gRPC 版,改寫後以本檔為準。

  背景:
    假如 Nginx 在 ":9443" 啟用 "ssl_verify_client on"
    而且 只信任 Agent 專用中繼 CA
    而且 已載入最新的 CRL

  場景: 有效裝置憑證可建立 WebSocket
    假如 Agent 持有中繼 CA 簽發、未過期、未撤銷的憑證 "CN=PC-001"
    當 Agent 連線 "wss://GATEWAY_IP:9443/agent/v1/ws" 並送出 hello
    那麼 WebSocket 建立成功
    而且 Endpoint Server 收到標頭 "x-client-cert-dn" 包含 "CN=PC-001"
    而且 Endpoint Server 收到標頭 "x-client-verify" 為 "SUCCESS"

  場景: WebSocket 可連續收送並正常關閉
    假如 Agent 以有效憑證 "CN=PC-001" 建立 WebSocket
    當 Agent 依序送出 3 則 heartbeat,每送一則就等待 heartbeat_ack
    那麼 每則訊息都在下一則送出前收到回覆
    當 Agent 送出 close frame
    那麼 WebSocket 正常關閉

  場景: HTTPS 回報與 WebSocket 可同時使用
    假如 Agent 以有效憑證建立 WebSocket
    當 Agent 同時以 HTTPS POST "/agent/v1/inventory" 回報資產
    那麼 回報成功,WebSocket 不受影響

  場景: 大型 HTTPS 回報不會被切斷
    假如 Agent 持有有效憑證
    當 Agent 以 HTTPS POST 送出 11 MB 的資產快照
    那麼 Endpoint Server 完整收到並回應成功

  場景: Agent 無法偽造身分標頭
    假如 Agent 持有有效憑證 "CN=PC-001"
    當 Agent 自行在請求帶入標頭 "x-client-cert-dn" 為 "CN=FORGED"
    那麼 Endpoint Server 收到的 "x-client-cert-dn" 為憑證實際的 "O=GigaNexus Dev,CN=PC-001"

  場景大綱: 無效憑證被拒絕且不會到達 Endpoint Server
    假如 Agent <憑證狀態>
    當 Agent 連線 "GATEWAY_IP:9443"
    那麼 Nginx 回應 <回應>
    而且 請求不會到達 Endpoint Server

    例子:
      | 憑證狀態                   | 回應     |
      | 沒有出示憑證               | HTTP 400 |
      | 出示已過期的憑證           | HTTP 400 |
      | 出示已被撤銷的憑證         | HTTP 400 |
      | 出示其他 CA 簽發的憑證     | HTTP 400 |
      | 出示企業 CA 但非 Agent 中繼 CA 簽發的憑證 | HTTP 403 |

  場景: 瀏覽器存取 :443 不會被要求出示憑證
    當 使用者以瀏覽器開啟 "https://GATEWAY_HOST/"
    那麼 TLS 握手不要求用戶端憑證

  場景: 長連線維持 1 小時
    假如 200 個 Agent 以有效憑證建立 WebSocket 並每 30 秒送 heartbeat
    當 經過 1 小時
    那麼 所有 WebSocket 仍維持連線

  場景: 單一裝置憑證的同時連線數受限
    假如 同一張裝置憑證的連線數已達 "limit_conn" 上限 10 條
    當 該憑證再建立新連線
    那麼 新連線被拒絕(HTTP 429)

  場景: 共用來源 IP 的不同裝置各自計算連線數
    假如 兩台電腦經 NAT 或 Docker 轉送,Nginx 看到相同的來源 IP
    而且 第一台電腦的憑證已佔滿 10 條連線
    當 第二台電腦以自己的憑證建立 WebSocket
    那麼 連線建立成功
