# Gateway Nginx 映像檔(DEPLOYMENT.md §3.1):設定檔打包進映像檔,憑證 / CRL 以 volume 或 secret 掛載到 /etc/nginx/pki
# 建置:docker build -t giganexus/gateway-nginx nginx/
FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY snippets/ /etc/nginx/snippets/
COPY conf.d/ /etc/nginx/conf.d/
COPY allowlists/ /etc/nginx/allowlists/
COPY templates/ /etc/nginx/templates/
# nginx-log-agent 讀取的 access log(compose 掛共用 volume)
RUN mkdir -p /var/log/nginx-gw
# 部署區預設(可由 compose 覆寫)
ENV GW_ENV=prod \
    ENDPOINT_WS_UPSTREAM=endpoint-server:51240 \
    ENDPOINT_GRPC_UPSTREAM=endpoint-server:51241 \
    ITAPP_API_UPSTREAM=itapp-api:51291 \
    NGINX_ENVSUBST_FILTER="^(GW_|ENDPOINT_|ITAPP_)"
EXPOSE 80 443 9443
