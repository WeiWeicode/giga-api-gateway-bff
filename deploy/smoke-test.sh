#!/bin/sh
# 部署後冒煙測試(DEPLOYMENT.md §3.2 步驟 6):/healthz 200、/api/auth/me 401、入口網首頁 200
set -eu
BASE="${1:-https://127.0.0.1}"
check() {
  CODE="$(curl -sk -o /dev/null -w '%{http_code}' "$BASE$1")"
  [ "$CODE" = "$2" ] || { echo "FAIL $1 → $CODE(預期 $2)" >&2; exit 1; }
  echo "OK   $1 → $CODE"
}
check /healthz 200
check /api/auth/me 401
check / 200
