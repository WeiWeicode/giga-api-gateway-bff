#!/bin/sh
# 部署後冒煙測試(DEPLOYMENT.md §3.2 步驟 6):/healthz 200、/api/auth/me 401、入口網首頁 200
# Nginx 容器剛重建時尚未接受連線:第一項最多重試 30 秒
set -eu
BASE="${1:-https://127.0.0.1}"
code() { curl -sk -o /dev/null -w '%{http_code}' "$BASE$1" || true; }
check() {
  CODE="$(code "$1")"
  [ "$CODE" = "$2" ] || { echo "FAIL $1 → $CODE(預期 $2)" >&2; exit 1; }
  echo "OK   $1 → $CODE"
}
i=0
until [ "$(code /healthz)" = 200 ] || [ "$i" -ge 30 ]; do i=$((i + 1)); sleep 1; done
check /healthz 200
check /api/auth/me 401
check / 200
