#!/bin/sh
# 等待容器 healthcheck(BFF 為 /readyz)通過;逾時則失敗並中止部署(DEPLOYMENT.md §3.2 步驟 3)
set -eu
SERVICE="$1"
TIMEOUT="${2:-120}"
ID="$(docker compose -f deploy/docker-compose.yml ps -q "$SERVICE")"
i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$ID" 2>/dev/null || echo unknown)"
  [ "$STATUS" = "healthy" ] && { echo "$SERVICE healthy"; exit 0; }
  i=$((i + 2)); sleep 2
done
echo "$SERVICE 在 ${TIMEOUT} 秒內未就緒" >&2
exit 1
