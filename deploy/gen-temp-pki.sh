#!/bin/sh
# 測試區臨時憑證與 JWT 金鑰(AD CS 憑證 P-05 / P-06 到位前使用;docs/TEST-DEPLOY-RUNBOOK.md 步驟 4)。
# 產生到 $OUT(主機受保護目錄 GW_SECRETS_DIR):
#   pki/ca.crt、ca.key        臨時根 CA(瀏覽器可匯入 ca.crt 消除警告;ca.key 只留在主機)
#   pki/server.crt、server.key  Gateway 伺服器憑證,SAN 含 GATEWAY_IPS(PRD Q1 以 IP 存取)
#   pki/agent-ca-chain.pem、agent.crl  臨時 Agent 中繼 CA + 根 CA 與 CRL(只為了讓 Nginx :9443 能啟動;不發 Agent 憑證)
#   jwt/<kid>.pem              BFF JWT 簽章金鑰(ES256,kid = <區域>-<年月>)
# 用法(Windows 主機不需安裝 openssl,在 Git Bash 執行):
#   docker run --rm -v "<GW_SECRETS_DIR>:/out" -v "$PWD/deploy:/scripts:ro" -e GATEWAY_IPS="<主機 IP>" -e GW_ENV=test \
#     alpine:3.20 sh -c "apk add -q openssl && OUT=/out sh /scripts/gen-temp-pki.sh"
# 已存在的檔案不覆寫;正式憑證到位後直接以同名檔案取代 pki/ 內容並重建 nginx 容器。
set -eu
: "${OUT:?OUT 必須指定(GW_SECRETS_DIR 掛載點)}"
: "${GATEWAY_IPS:?GATEWAY_IPS 必須指定(主機 IP,空白分隔)}"
ENV_NAME="${GW_ENV:-test}"
PKI="$OUT/pki"
JWT="$OUT/jwt"
mkdir -p "$PKI" "$JWT"

# ---------- JWT 簽章金鑰(檔名即 kid,字母順序最後者為使用中) ----------
if [ -z "$(ls -A "$JWT" 2>/dev/null)" ]; then
  kid="$ENV_NAME-$(date +%Y%m)"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$JWT/$kid.pem" 2>/dev/null
  chmod 644 "$JWT/$kid.pem"
  echo "JWT 金鑰:jwt/$kid.pem"
else
  echo "jwt/ 已有金鑰,略過"
fi

cd "$PKI"
if [ -f server.crt ]; then
  echo "pki/server.crt 已存在,略過憑證產生(要重建請先移除 pki/ 內容)"
  exit 0
fi

# ---------- 臨時根 CA ----------
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -sha256 -days 825 \
  -keyout ca.key -out ca.crt -subj "/O=GigaNexus/CN=GigaNexus Temporary Root CA ($ENV_NAME)" \
  -addext "basicConstraints=critical,CA:true" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

# ---------- Gateway 伺服器憑證(SAN 帶 IP) ----------
SAN="DNS:localhost,DNS:nginx,IP:127.0.0.1"
for ip in $GATEWAY_IPS; do SAN="$SAN,IP:$ip"; done
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout server.key -out server.csr \
  -subj "/O=GigaNexus/CN=GigaNexus Gateway ($ENV_NAME, temporary)" 2>/dev/null
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n" "$SAN" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile server.ext -out server.crt 2>/dev/null

# ---------- 臨時 Agent 中繼 CA 與 CRL(Nginx ssl_client_certificate / ssl_crl 需要檔案才能啟動) ----------
cat > ca.cnf <<'EOF'
[ ca ]
default_ca = CA_default
[ CA_default ]
dir = .
database = $dir/index-$ENV::CA_NAME.txt
new_certs_dir = $dir/newcerts
serial = $dir/serial-$ENV::CA_NAME
crlnumber = $dir/crlnumber-$ENV::CA_NAME
default_md = sha256
policy = policy_any
default_crl_days = 825
unique_subject = no
[ policy_any ]
commonName = supplied
organizationName = optional
[ v3_intermediate ]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
mkdir -p newcerts
for n in root agent; do : > "index-$n.txt"; echo 1000 > "serial-$n"; echo 1000 > "crlnumber-$n"; done
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout agent-ca.key -out agent-ca.csr \
  -subj "/O=GigaNexus/CN=GigaNexus Temporary Agent CA ($ENV_NAME)" 2>/dev/null
CA_NAME=root openssl ca -batch -config ca.cnf -cert ca.crt -keyfile ca.key -extensions v3_intermediate \
  -days 825 -in agent-ca.csr -out agent-ca.crt -notext 2>/dev/null
cat agent-ca.crt ca.crt > agent-ca-chain.pem
CA_NAME=root openssl ca -config ca.cnf -cert ca.crt -keyfile ca.key -gencrl -out root.crl 2>/dev/null
CA_NAME=agent openssl ca -config ca.cnf -cert agent-ca.crt -keyfile agent-ca.key -gencrl -out agent-ca.crl 2>/dev/null
cat agent-ca.crl root.crl > agent.crl

rm -rf ./*.csr ./*.ext ./*.srl ca.cnf index-* serial-* crlnumber-* newcerts root.crl agent-ca.crl
# Nginx 以 root 讀取;私鑰只留在主機受保護目錄
chmod 644 server.crt ca.crt agent-ca-chain.pem agent.crl
chmod 600 ca.key agent-ca.key server.key
echo "已產生臨時憑證:$PKI(SAN:$SAN)"
