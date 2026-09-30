#!/bin/sh
# 主機 2(測試區 WSL)放入 Gateway 密碼檔:本人執行,密碼以隱藏輸入寫入 GW_SECRETS_DIR,不經開發機、不留在 shell 歷史。
#   在主機 2 的 WSL Ubuntu 視窗:sudo sh deploy/host2-set-secrets.sh [GW_SECRETS_DIR]
# 已存在的檔案詢問是否覆寫(直接 Enter = 保留)。BFF / migrate 容器以 node(uid 1000)讀取,檔案權限 400。
set -eu
DIR="${1:-/srv/giganexus/deploy/secrets}"
[ -d "$DIR" ] || { echo "找不到 $DIR" >&2; exit 1; }

ask() { # $1 檔名 $2 說明
  f="$DIR/$1"
  if [ -f "$f" ]; then
    printf '%s 已存在,要覆寫嗎?[y/N] ' "$1"; read -r yn
    [ "$yn" = y ] || { echo "  保留 $1"; return; }
  fi
  stty -echo; printf '%s(%s):' "$1" "$2"; read -r p; stty echo; echo
  [ -n "$p" ] || { echo "  空白,略過 $1"; return; }
  printf '%s' "$p" > "$f"; unset p
  chown 1000:1000 "$f"; chmod 400 "$f"
  echo "  已寫入 $1"
}

ask gw_db_password      'gw_app 密碼'
ask gw_migrate_password 'gw_migrate 密碼'
ask los_db_password     'los_reader 密碼'
ask bpm_db_password     'bpm_reader 密碼'
ask portal_db_password  'portal_reader 密碼'
ask ldap_gsmc_password  'gsmc AD 服務帳號 sasmgr 密碼'
ls -l "$DIR"
