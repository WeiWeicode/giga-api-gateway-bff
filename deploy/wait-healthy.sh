#!/bin/sh
# 等待容器 healthcheck(BFF 為 /readyz)通過;逾時則失敗並中止部署(DEPLOYMENT.md §3.2 步驟 3)
# 以 compose 標籤找容器,不需重新解析 compose 檔(解析需要 env 檔的必填變數)
set -eu
SERVICE="$1"
TIMEOUT="${2:-120}"
PROJECT="${COMPOSE_PROJECT_NAME:-giganexus-gw}"
ID="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$SERVICE" | head -1)"
[ -n "$ID" ] || { echo "找不到 $PROJECT 的 $SERVICE 容器" >&2; exit 1; }
i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$ID" 2>/dev/null || echo unknown)"
  [ "$STATUS" = "healthy" ] && { echo "$SERVICE healthy"; exit 0; }
  i=$((i + 2)); sleep 2
done
echo "$SERVICE 在 ${TIMEOUT} 秒內未就緒" >&2
docker logs --tail 30 "$ID" >&2 || true
exit 1
