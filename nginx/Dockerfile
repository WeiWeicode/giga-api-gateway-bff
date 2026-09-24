# Gateway Nginx 映像檔(DEPLOYMENT.md §3.1):設定檔打包進映像檔,憑證 / CRL 以 volume 或 secret 掛載到 /etc/nginx/pki
# 建置:docker build -t giganexus/gateway-nginx nginx/
FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY snippets/ /etc/nginx/snippets/
COPY conf.d/ /etc/nginx/conf.d/
COPY allowlists/ /etc/nginx/allowlists/
COPY templates/ /etc/nginx/templates/
# 部署區預設(可由 compose 覆寫);登入限流 PRD §7.3:5 r/min
ENV GW_ENV=prod \
    GW_AUTH_RATE=5r/m \
    ENDPOINT_WS_UPSTREAM=endpoint-server:51240 \
    ENDPOINT_GRPC_UPSTREAM=endpoint-server:51241 \
    NGINX_ENVSUBST_FILTER="^(GW_|ENDPOINT_)"
EXPOSE 80 443 9443
