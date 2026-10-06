# nginx-log-agent(MONITORING-PLAN W9-7):Nginx access log 每分鐘彙總 → giga-observe;無外部相依
# 建置:docker build -t giganexus/gateway-nginx-log-agent nginx/log-agent/
# 以 root 執行:access log 由 Nginx(root)建立,檔案過大時需要截斷權限;容器不對外、不開 port
FROM node:22-alpine
WORKDIR /app
COPY agent.mjs ./
CMD ["node", "agent.mjs"]
