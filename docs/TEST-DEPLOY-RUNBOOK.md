# 公司測試區架設手冊(手動部署,一頁式)

> 適用:**公司 GitLab / CI / Registry 與 AD CS 憑證尚未就緒**時,在**主機 2(B 測試區,Windows + WSL2 內的 Docker Engine,2026-09-29 起不使用 Docker Desktop)**手動架設 Gateway、員工入口網(giga-Portal)與 IT 管理系統(GigaItApp)。
> CI 就緒後改依 [DEPLOYMENT.md](DEPLOYMENT.md) §2–§3;完整調整清單見 [COMPANY-ENV-PLAN.md](COMPANY-ENV-PLAN.md)。建立日期 2026-09-26。
> 指令一律在 **Git Bash** 執行(Git for Windows 內附)。以下以 `D:/giganexus` 為例,請依實際位置替換;`<主機 IP>` 為主機 2 的 IP。

---

## 0. 公司端要先準備(缺一不可)

| 項目 | 內容 | 清單編號 |
| --- | --- | --- |
| 資料庫 | DBA 在 SQL Server 2012 建好 `giganexus_gw_test`、schema `gw`、帳號 `gw_app` / `gw_migrate`(含 `gw_app_role`) | P-01 |
| AD | 各網域查詢用服務帳號(DN + 密碼)、DC 位址;要開放登入的網域才需要 | P-07 |
| 主機 2 | WSL2 內的 Docker Engine 已啟動;`80`、`443` 未被佔用;防火牆對使用者網段開放 `443`(`80` 轉址) | P-11 |
| 網路 | 主機可連 Docker Hub 與 npm(`node:22-alpine`、`nginx:1.27-alpine`、`redis:7-alpine`、`alpine:3.20`、npm 套件);需 proxy 時先設定 Docker(WSL 內 `/etc/systemd/system/docker.service.d/`)與 `.npmrc` | — |
| 帳號 | GigaItApp 讀 BFF 用的服務帳號(公司 AD 帳號,需有 Gateway 管理讀取權限) | — |

> 不需要:GitLab、Registry、AD CS 憑證(先用臨時自簽,步驟 4)、Endpoint Server、LOS / BPM / 舊入口網資料庫(未設定時略過,人員同步與舊帳號遷移尚未實作)。

## 1. 先做來源 IP 驗證(5 分鐘,決定能不能上線)

依 [DEPLOYMENT.md](DEPLOYMENT.md) §6.1「驗證步驟」1–5。若 Nginx 看不到使用者真實 IP,登入限流(每分鐘 5 次)會變成全公司共用,上班時段大量登入失敗;結果記錄到 PRD Q26,**遺失時先別開放給一般使用者**,改依 §6.1 方案處理。

## 2. 取得程式(四個 repo 並排)

```bash
mkdir -p D:/giganexus/src && cd D:/giganexus/src
git clone https://github.com/WeiWeicode/giga-api-gateway-bff.git
git clone https://github.com/WeiWeicode/giga-Portal.git
git clone https://github.com/WeiWeicode/GigaItApp.git
```

- 必須並排:giga-Portal 建置時取 `../giga-api-gateway-bff/web-kit`。Watchdog(RustIt)是端點電腦上的服務,**不部署到伺服器**。

## 3. 主機受保護目錄(機密與設定,不入版控)

```bash
mkdir -p D:/giganexus/deploy/secrets D:/giganexus/deploy/config && cd D:/giganexus/deploy
cp ../src/giga-api-gateway-bff/deploy/test.env.example test.env
cp ../src/giga-Portal/deploy/test.env.example portal.env
cp ../src/GigaItApp/deploy/test.env.example itapp.env
# 密碼檔(不留在 shell 歷史;每個檔案一行指令,名稱見下表)
read -rsp '密碼: ' p && printf '%s' "$p" > secrets/gw_db_password && unset p && echo
```

| 檔案(`secrets/`) | 內容 | 必要 |
| --- | --- | --- |
| `gw_db_password`、`gw_migrate_password` | `gw_app`、`gw_migrate` 密碼 | 是 |
| `ldap_<網域代碼>_password` | 該網域服務帳號密碼(代碼小寫,例 `ldap_gsc_password`) | `ldap-domains.json` 列出的每個網域都要有,否則 BFF 啟動失敗 |
| `los_db_password`、`bpm_db_password`、`portal_db_password` | 唯讀帳號 | 否(`test.env` 未設對應 HOST 時不用) |

`config/ldap-domains.json`(只列要開放登入的網域;`url` 過渡期為 `ldap://<DC>:389`):

```json
[
  { "code": "gsc", "name": "碩禾", "netbios": "GSC", "upnSuffix": "gsc.com.tw",
    "url": "ldap://<DC>:389", "baseDN": "DC=gsc,DC=com,DC=tw", "bindDN": "<服務帳號 DN>" }
]
```

`test.env`(由範本修改):`REGISTRY=giganexus`、`IMAGE_TAG=<步驟 5 的 tag>`、`GW_SECRETS_DIR=D:/giganexus/deploy/secrets`、`GW_CONFIG_DIR=D:/giganexus/deploy/config`、`GW_DB_HOST`、`GW_DB_NAME=giganexus_gw_test`、`ITAPP_API_UPSTREAM=itapp-api:51291`(同一台主機);Endpoint Server 未部署時兩個 `ENDPOINT_*` 刪除,用預設值;LOS / BPM / 舊入口網未提供時刪除對應 `*_HOST`。

## 4. 臨時憑證與 JWT 金鑰(AD CS 憑證到位前)

```bash
cd D:/giganexus/src/giga-api-gateway-bff
MSYS_NO_PATHCONV=1 docker run --rm -v "D:/giganexus/deploy/secrets:/out" -v "$(pwd -W)/deploy:/scripts:ro" \
  -e GATEWAY_IPS="<主機 IP>" -e GW_ENV=test alpine:3.20 sh -c "apk add -q openssl && OUT=/out sh /scripts/gen-temp-pki.sh"
```

- 產生 `secrets/pki/`(伺服器憑證 SAN 含主機 IP、臨時 Agent CA 與 CRL,讓 Nginx 能啟動)與 `secrets/jwt/test-<年月>.pem`。
- 瀏覽器會出現憑證警告;要消除時把 `secrets/pki/ca.crt`(**不是** `ca.key`)匯入使用者電腦的「受信任的根憑證授權單位」。
- AD CS 憑證(P-05、P-06)到位後,以同名檔案取代 `agent-server.*`、`agent-ca-chain.pem`、`agent.crl`、`ca.crt`,再執行步驟 6 的 `up -d nginx`。

### 4.1 `:443` 換成公司憑證(`*.gigasolar.com.tw`,PRD Q1)

前提:網通已建立 DNS A 紀錄(測試區 `giganexus-test.gigasolar.com.tw` → 10.10.130.124;正式區 `giganexus.gigasolar.com.tw` → 10.10.130.122),`nslookup` 查得到。公司憑證檔(`STAR_gigasolar_com_tw.crt`、`ca.crt`、`ssl.key`)向主管取得,**不放進任何 repo**。

```bash
PKI=<GW_SECRETS_DIR>/pki
SSL=<公司憑證資料夾>
# 1. 舊版 pki/ 先補上 :9443 用的 agent-server.*(必須在換掉 server.crt 之前;已有則略過)
#    重新執行上方 gen-temp-pki.sh 即可
# 2. 備份後置換:server.crt = 伺服器憑證 + 中繼鏈(順序不可顛倒)
cp "$PKI/server.crt" "$PKI/server.crt.temp.bak"; cp "$PKI/server.key" "$PKI/server.key.temp.bak"
cat "$SSL/STAR_gigasolar_com_tw.crt" "$SSL/ca.crt" > "$PKI/server.crt"
cp "$SSL/ssl.key" "$PKI/server.key"; chmod 600 "$PKI/server.key"
# 3. 確認私鑰與憑證成對(兩行輸出相同)
openssl x509 -in "$PKI/server.crt" -noout -modulus | openssl md5; openssl rsa -in "$PKI/server.key" -noout -modulus | openssl md5
```

- `test.env` / `prod.env` 設定 `GW_PUBLIC_HOST`(見 env 範本),執行步驟 6 的 `up -d nginx`;`nginx -t` 失敗時還原 `*.temp.bak`。
  - 主機 2(CI 部署,WSL root):`cd /srv/giganexus/shared/giga-api-gateway-bff && IMAGE_TAG=$(cat ../gateway-image-tag) docker compose --env-file /srv/giganexus/deploy/test.env -f deploy/docker-compose.yml -f deploy/docker-compose.test.yml up -d --no-deps --force-recreate nginx`(或在 GitLab 重跑 `deploy-test`)
- 公司憑證檔複製到主機只為了置換,完成後刪除暫存的那份,私鑰只留在 `pki/`。
- 驗證:`openssl s_client -connect <主機 IP>:443 -servername <DNS 名稱> </dev/null | openssl x509 -noout -subject -enddate` 顯示 `CN=*.gigasolar.com.tw`;瀏覽器開 `https://<DNS 名稱>/` 無憑證警告。
- **同主機的 GigaItApp**(`itapp-api` 以 `https://nginx` 呼叫 BFF)會因主機名稱不符而失敗,需同步改為 `https://<GW_PUBLIC_HOST>`(Gateway compose 已將此名稱設為 nginx 的網路別名)並移除 `GW_CA_CERT` 的臨時根 CA;下游 Node.js 後端 `GW_BASE_URL` 改用 DNS 名稱,不需 `NODE_EXTRA_CA_CERTS`。
- 憑證 2027-01-31 到期,更新時重做步驟 2–3。

## 5. 在主機上建置 Gateway 映像檔(沒有 Registry)

```bash
cd D:/giganexus/src/giga-api-gateway-bff
TAG=$(git rev-parse --short HEAD)
docker build -f bff/Dockerfile -t giganexus/gateway/bff:$TAG .
docker build -t giganexus/gateway/nginx:$TAG nginx/
echo "IMAGE_TAG=$TAG"   # 填回 test.env
```

## 6. 部署 Gateway

```bash
cd D:/giganexus/src/giga-api-gateway-bff/deploy
GW="docker compose --env-file D:/giganexus/deploy/test.env -f docker-compose.yml -f docker-compose.test.yml"
$GW --profile tools run --rm migrate          # migration + seed;失敗即停止,先排除(常見:帳號權限、定序)
$GW up -d --wait redis bff-1 bff-2
$GW up -d nginx
curl -sk https://127.0.0.1/healthz              # 200
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/api/auth/me   # 401
```

- 角色與 AD 群組對應(誰是 Gateway 管理員等)依 [COMPANY-ENV-PLAN.md](COMPANY-ENV-PLAN.md) §3「角色與 AD 群組對應」另寫一份以 CLI `apply` 套用(P-08):`$GW --profile tools run --rm -v "$(pwd -W)/<檔案>.yaml:/cfg.yaml:ro" migrate node dist/bff/src/cli/index.js apply --file /cfg.yaml --actor <你的工號>`(前面加 `MSYS_NO_PATHCONV=1`)。

## 7. 部署員工入口網(提供 `/`、`/login`,**沒有它沒人能登入**)

```bash
cd D:/giganexus/src/giga-Portal
# 權限代碼與 employee 角色(需要 AD 群組的角色先在 deploy/gateway-rbac.yaml 填入 DN)
sh deploy/apply-gateway-rbac.sh test D:/giganexus/deploy/test.env
# 前端發佈到 Gateway 的 gw_www(portal.env 的 RELEASE_SHA 建議填 commit 短 SHA)
docker compose --env-file D:/giganexus/deploy/portal.env -f deploy/docker-compose.yml run --rm --build spa-portal
curl -sk https://127.0.0.1/login | grep -o '<title>[^<]*'   # GigaNexus 員工入口網
```

## 8. 部署 IT 管理系統(`/it/`)

```bash
cd D:/giganexus/src/GigaItApp
# itapp.env:GW_CA_CERT=D:/giganexus/deploy/secrets/pki/ca.crt、BFF_SERVICE_USER=<服務帳號工號>
# 機密:服務帳號密碼與種子帳號密碼一定要指定,不要用預設值
read -rsp 'BFF 服務帳號密碼: ' BFF_SERVICE_PASSWORD && echo && read -rsp 'IT 系統種子帳號密碼: ' ITAPP_SEED_PASSWORD && echo
BFF_SERVICE_PASSWORD="$BFF_SERVICE_PASSWORD" ITAPP_SEED_PASSWORD="$ITAPP_SEED_PASSWORD" sh deploy/gen-secrets.sh && unset BFF_SERVICE_PASSWORD ITAPP_SEED_PASSWORD
IT="docker compose --env-file D:/giganexus/deploy/itapp.env -f deploy/docker-compose.yml"
$IT up -d --build --wait itapp-api
$IT run --rm --build spa-it
```

- GigaItApp 目前仍為**自有登入**(改單一入口為 giga-Portal PRD M3);它讀 BFF 的 `/api/admin/demo/*`、`/api/admin/db/*` 只在測試區開放(2026-09-26 決定:測試區保留、正式區關閉)。

## 9. 驗收(從另一台電腦的瀏覽器)

- [ ] `https://<DNS 名稱>/` 導向 `/login`、無憑證警告;以 AD 帳號登入後看到員工入口網首頁與選單
- [ ] 一般員工看不到應用切換;有 `it.app.access` 的人看得到,點「IT 管理系統」到 `/it/`
- [ ] 登出後回到 `/login`
- [ ] Gateway log 的 `remote_addr` 是那台電腦的 IP(DEPLOYMENT.md §6.1 步驟 6)
- 已知:`/api/auth/register`、`/password/forgot`、`/password/reset` 已實作(W3-5.8a/b,2026-10-01),Email 改寄 `test.env` 的 `MAIL_REDIRECT_TO`;giga-Portal 註冊頁尚未送出 `password`,沒有 Email 的同仁目前無法以到職日完成註冊;首頁資訊區塊與各功能頁為「建置中」(giga-Portal M4 / M5)

## 10. 常見狀況與回滾

| 狀況 | 原因 / 處理 |
| --- | --- |
| 登入頁一直 429 | 來源 IP 遺失(步驟 1);暫時可在 `test.env` 放寬 `GW_AUTH_RATE` 後 `up -d nginx`,並盡快依 §6.1 處理 |
| 登入後「沒有員工入口網使用權限」 | 步驟 7 的權限尚未套用,或套用後尚未重新整理 |
| `bff-1` 起不來 | `docker logs giganexus-gw-bff-1-1`:多為缺密碼檔、`ldap-domains.json` 網域沒有對應密碼、資料庫連不上 |
| `/it/` 讀 BFF 失敗 | `itapp.env` 的 `GW_CA_CERT` 未指向步驟 4 的 `ca.crt`,或服務帳號沒有權限 |
| 前端回滾 | 入口網:`docker compose --env-file D:/giganexus/deploy/portal.env -f deploy/docker-compose.yml run --rm spa-portal rollback portal`;IT:`... spa-it rollback it-admin` |
| Gateway 回滾 | 以上一版的 tag 重新建置(或保留舊映像),改 `test.env` 的 `IMAGE_TAG` 後重做步驟 6(資料庫不降版) |
