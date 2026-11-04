#!/bin/sh
# gw-super-admin 只新增權限(DEPLOYMENT.md §3.5.1;super-admin-grants.yaml):Gateway 負責人在該區主機以 root 執行,不隨 CI 套用。
#   cd /srv/giganexus/shared/giga-api-gateway-bff/deploy          # 主機 2;Gateway build job 會把 deploy/ 複製到這裡
#   ACTOR=cli:<工號> sh apply-super-admin-grants.sh test /srv/giganexus/deploy/test.env
# 步驟:
#   1. 唯讀計畫:以 migrate 映像執行 super-admin-grants-plan.mjs,讀出 gw-super-admin 目前的權限,與本檔合併(只新增)
#   2. 顯示新增清單,輸入 y 確認(YES=1 略過確認)
#   3. 重新計畫一次,與第 1 步相同才以 CLI apply 寫入(兩步之間有人改了角色就中止,避免蓋掉別人剛加的權限)
#   4. 再計畫一次,應顯示「已全部具備」
# 寫入後權限版本遞增,已登入的人下一次請求即取得新權限(GigaItApp 重新整理或重新登入)。
# 映像:IMAGE_TAG 預設讀 Gateway 共用目錄的 gateway-image-tag(該區 Gateway 目前的版本),REGISTRY 預設 GitLab Registry。
set -eu
ZONE="${1:?用法:ACTOR=cli:<工號> sh apply-super-admin-grants.sh <test|prod> <Gateway 區域 env 檔>}"
ENV_FILE="${2:?用法:ACTOR=cli:<工號> sh apply-super-admin-grants.sh <test|prod> <Gateway 區域 env 檔>}"
case "$ZONE" in test | prod) ;; *) echo "區域只能是 test 或 prod" >&2; exit 1 ;; esac
[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_ABS="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
TAG_FILE="$HERE/../../gateway-image-tag"
export IMAGE_TAG="${IMAGE_TAG:-$(cat "$TAG_FILE" 2>/dev/null || true)}"
[ -n "$IMAGE_TAG" ] || { echo "找不到 Gateway 映像版本:設定 IMAGE_TAG,或在 Gateway 共用目錄執行($TAG_FILE)" >&2; exit 1; }
export REGISTRY="${REGISTRY:-10.10.130.123:5050/giganexus/giga-api-gateway-bff}"
ACTOR="${ACTOR:-cli:${SUDO_USER:-$(id -un)}}"

# 計畫檔與合併結果不含機密;容器以 uid 1000(node)執行,暫存目錄需可讀
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 755 "$TMP"
cd "$HERE"
run() {
  docker compose --env-file "$ENV_ABS" -f docker-compose.yml -f "docker-compose.$ZONE.yml" --profile tools run --rm --no-deps -T \
    -v "$HERE/super-admin-grants.yaml:/gw/super-admin-grants.yaml:ro" \
    -v "$HERE/super-admin-grants-plan.mjs:/gw/super-admin-grants-plan.mjs:ro" \
    -v "$TMP:/gw-plan:ro" \
    migrate "$@"
}
plan() {
  set +e
  run node /gw/super-admin-grants-plan.mjs > "$1"
  rc=$?
  set -e
  chmod 644 "$1"
  return $rc
}

echo "== 1. 計畫(唯讀,$ZONE,映像 $IMAGE_TAG)"
rc=0; plan "$TMP/merged.yaml" || rc=$?
[ "$rc" -eq 3 ] && exit 0
[ "$rc" -eq 0 ] || { echo "計畫失敗(結束碼 $rc),未寫入" >&2; exit 1; }
# stdout 只能是計畫產生的 apply 檔(混入其他輸出就不套用)
head -n 1 "$TMP/merged.yaml" | grep -q '^# 由 super-admin-grants-plan.mjs 產生' || { echo "計畫輸出格式不符,未寫入" >&2; exit 1; }

if [ "${YES:-}" != 1 ]; then
  [ -t 0 ] || { echo "請在終端機執行以確認,或設定 YES=1" >&2; exit 1; }
  printf '以 %s 寫入上述新增權限?輸入 y 確認:' "$ACTOR"; read -r ans
  [ "$ans" = y ] || { echo "已取消,未寫入"; exit 1; }
fi

echo "== 2. 重新計畫並比對"
rc=0; plan "$TMP/merged2.yaml" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] && cmp -s "$TMP/merged.yaml" "$TMP/merged2.yaml" \
  || { echo "確認期間 gw-super-admin 的權限有變動(或計畫失敗),未寫入;請重新執行" >&2; exit 1; }

echo "== 3. 套用(CLI apply)"
run node dist/bff/src/cli/index.js apply --file /gw-plan/merged.yaml --actor "$ACTOR"

echo "== 4. 驗證"
rc=0; plan "$TMP/after.yaml" || rc=$?
[ "$rc" -eq 3 ] || { echo "套用後仍有未具備的權限(結束碼 $rc),請檢查上方輸出" >&2; exit 1; }
echo "完成。GigaItApp 重新整理(或重新登入)後即可指派新角色。"
