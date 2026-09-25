# language: zh-TW
@mvp @W3-3 @e2e @security
功能: Agent 專用通道(:9443 mTLS + gRPC)
  為了讓端點 Agent 以裝置身分與 Endpoint Server 長連線
  身為 Gateway 維運人員
  我需要在獨立 port 強制驗證裝置憑證,且不影響瀏覽器使用者

  背景:
    假如 Nginx 在 ":9443" 啟用 "ssl_verify_client on"
    而且 只信任 Agent 專用中繼 CA
    而且 已載入最新的 CRL

  場景: 有效裝置憑證可建立 gRPC 雙向串流
    假如 Agent 持有中繼 CA 簽發、未過期、未撤銷的憑證 "CN=PC-001"
    當 Agent 連線 "GATEWAY_IP:9443" 並呼叫 Heartbeat
    那麼 串流建立成功
    而且 Endpoint Server 收到標頭 "x-client-cert-dn" 包含 "CN=PC-001"
    而且 Endpoint Server 收到標頭 "x-client-verify" 為 "SUCCESS"

  場景: 雙向串流可連續收送並正常結束
    假如 Agent 持有有效憑證 "CN=PC-001"
    當 Agent 在同一條 Stream 串流上依序送出 3 則訊息,每送一則就等待回覆
    那麼 每則訊息都在下一則送出前收到回覆
    而且 每則回覆的 "x-client-cert-dn" 都包含 "CN=PC-001"
    當 Agent 結束送出
    那麼 串流以 OK 狀態結束

  場景: 同一條連線可同時開多條串流
    假如 Agent 以有效憑證建立一條連線
    當 Agent 在這條連線上同時開啟兩條 Stream 串流
    那麼 兩條串流各自收到自己的回覆,互不干擾

  場景: 長串流累計上傳超過 10 MB 不會被切斷
    假如 Agent 以有效憑證建立 Stream 串流
    當 Agent 在同一條串流上累計送出 11 MB
    那麼 所有訊息都收到回覆
    而且 串流以 OK 狀態結束

  場景: Agent 無法偽造身分標頭
    假如 Agent 持有有效憑證 "CN=PC-001"
    當 Agent 自行在 metadata 帶入 "x-client-cert-dn" 為 "CN=FORGED"
    那麼 Endpoint Server 收到的 "x-client-cert-dn" 為憑證實際的 "O=GigaNexus Dev,CN=PC-001"

  場景大綱: 無效憑證在 TLS 層即被拒絕
    假如 Agent <憑證狀態>
    當 Agent 連線 "GATEWAY_IP:9443"
    那麼 TLS 握手失敗
    而且 請求不會進入應用層

    例子:
      | 憑證狀態                   |
      | 沒有出示憑證               |
      | 出示已過期的憑證           |
      | 出示已被撤銷的憑證         |
      | 出示其他 CA 簽發的憑證     |

  場景: 瀏覽器存取 :443 不會被要求出示憑證
    當 使用者以瀏覽器開啟 "https://GATEWAY_IP/"
    那麼 TLS 握手不要求用戶端憑證

  場景: 長連線維持 1 小時
    假如 200 個 Agent 以有效憑證建立串流
    當 經過 1 小時
    那麼 所有串流仍維持連線

  場景: 單一來源的連線數受限
    假如 同一來源 IP 的連線數已達 "limit_conn" 上限
    當 該來源再建立新連線
    那麼 新連線被拒絕
