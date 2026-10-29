#!/bin/sh
# 主機 3(正式區 WSL)把 :9443 與 endpoint-server 的臨時 PKI 換成正式區專用的一套(與測試區分開):本人執行,私鑰只留在主機 3。
#   在主機 3 的 WSL:sudo sh /srv/giganexus/deploy/host3-prod-temp-pki.sh
#
# 背景:主機 3 的 pki/ 是從測試區複製來的,ca.crt、agent-ca.crt 與主機 2 指紋相同 → 正式區 :9443 會信任測試區 Agent 的裝置憑證,
#       測試區主機也持有能簽正式區憑證的私鑰。IT AD CS 正式憑證到位前,先以 gen-temp-pki.sh(GW_ENV=prod)另產一套。
# 產生並換上(原檔先備份到 pki.bak-<日期時間>/、ita-secrets/endpoint_server.*.bak-<日期時間>):
#   pki/ca.crt、ca.key                 臨時根 CA(prod)
#   pki/agent-ca.crt、agent-ca.key、agent-ca-chain.pem、agent.crl   臨時 Agent 中繼 CA(prod)與 CRL(Nginx :9443 驗裝置憑證)
#   pki/agent-server.crt、agent-server.key                         :9443 伺服器憑證(SAN IP 10.10.130.122)
#   ita-secrets/endpoint_server.crt、.key                           endpoint-server :51241(SAN DNS:endpoint-server;Nginx 以 ca.crt 驗證)
# 不動:pki/server.crt、server.key(:443 公司 *.gigasolar.com.tw 憑證)、jwt/(BFF 簽章金鑰)。
# 換上後 nginx -t 通過才 nginx -s reload(不重建容器、不中斷 :443);失敗時自動還原備份。
# 主機 3 的 WSL 查不到外部 DNS(apk 裝不了 openssl),直接用 WSL 的 openssl 執行 gen-temp-pki.sh。
set -eu
GW_IP=10.10.130.122
S=/srv/giganexus/deploy/secrets
PKI="$S/pki"
ITA=/srv/giganexus/ita-secrets
GEN=/srv/giganexus/shared/giga-api-gateway-bff/deploy/gen-temp-pki.sh
NGINX=giganexus-gw-nginx-1
TS="$(date +%Y%m%d%H%M%S)"
[ "$(id -u)" = 0 ] || { echo "請用 sudo 執行" >&2; exit 1; }
command -v openssl >/dev/null || { echo "WSL 沒有 openssl" >&2; exit 1; }
[ -f "$GEN" ] || { echo "找不到 $GEN" >&2; exit 1; }
[ -f "$PKI/server.crt" ] || { echo "找不到 $PKI/server.crt" >&2; exit 1; }
case "$(openssl x509 -in "$PKI/ca.crt" -noout -subject)" in
  *"Root CA (prod)"*) echo "pki/ca.crt 已是正式區臨時 CA,不重複產生(要重建先還原備份)"; exit 0 ;;
esac

# ---------- 1. 在暫存目錄產生新的一套 ----------
NEW="$(mktemp -d /srv/giganexus/deploy/pki-prod-new.XXXXXX)"; chmod 700 "$NEW"
trap 'rm -rf "$NEW"' EXIT
OUT="$NEW" GATEWAY_IPS="$GW_IP" GW_ENV=prod sh "$GEN"
cd "$NEW/pki"
serial() { echo "0x$(openssl rand -hex 16)"; }
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout endpoint_server.key -out s.csr \
  -subj "/O=GigaNexus/CN=endpoint-server" 2>/dev/null
printf "subjectAltName=DNS:endpoint-server\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n" > s.ext
openssl x509 -req -in s.csr -CA ca.crt -CAkey ca.key -set_serial "$(serial)" -days 825 -sha256 -extfile s.ext -out endpoint_server.crt 2>/dev/null
rm -f s.csr s.ext
openssl verify -CAfile ca.crt agent-server.crt endpoint_server.crt agent-ca.crt

# ---------- 2. 備份並換上(server.crt / server.key 不動) ----------
cp -a "$PKI" "$PKI.bak-$TS"
for f in endpoint_server.crt endpoint_server.key; do [ -f "$ITA/$f" ] && cp -p "$ITA/$f" "$ITA/$f.bak-$TS"; done
restore() {
  echo "nginx 設定檢查失敗,還原備份" >&2
  cp -a "$PKI.bak-$TS/." "$PKI/"
  for f in endpoint_server.crt endpoint_server.key; do [ -f "$ITA/$f.bak-$TS" ] && cp -p "$ITA/$f.bak-$TS" "$ITA/$f"; done
  docker exec "$NGINX" nginx -t
  exit 1
}
for f in ca.crt ca.key agent-ca.crt agent-ca.key agent-ca-chain.pem agent.crl agent-server.crt agent-server.key; do
  cp "$f" "$PKI/$f"
done
chown root:root "$PKI"/ca.key "$PKI"/agent-ca.key "$PKI"/agent-server.key
chmod 600 "$PKI"/ca.key "$PKI"/agent-ca.key "$PKI"/agent-server.key
chmod 644 "$PKI"/ca.crt "$PKI"/agent-ca.crt "$PKI"/agent-ca-chain.pem "$PKI"/agent.crl "$PKI"/agent-server.crt
cp endpoint_server.crt endpoint_server.key "$ITA/"
chown 1000:1000 "$ITA/endpoint_server.crt" "$ITA/endpoint_server.key"
chmod 400 "$ITA/endpoint_server.crt" "$ITA/endpoint_server.key"

# ---------- 3. Nginx 重新載入(不重建容器) ----------
docker exec "$NGINX" nginx -t || restore
docker exec "$NGINX" nginx -s reload
echo "已換上正式區臨時 PKI(備份 $PKI.bak-$TS)"
for f in ca.crt agent-ca.crt agent-server.crt; do
  printf '%-18s %s | %s\n' "$f" "$(openssl x509 -in "$PKI/$f" -noout -subject | sed 's/^subject=//')" "$(openssl x509 -in "$PKI/$f" -noout -fingerprint -sha256 | cut -d= -f2 | cut -c1-23)"
done
echo "endpoint_server    $(openssl x509 -in "$ITA/endpoint_server.crt" -noout -issuer | sed 's/^issuer=//')"
