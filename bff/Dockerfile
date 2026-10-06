# BFF / worker / migrate / CLI 共用映像檔(DEPLOYMENT.md §3.1),以啟動指令區分:
#   bff:     node dist/bff/src/server.js(預設)
#   worker:  node dist/bff/src/worker.js(佇列處理)
#   migrate: node dist/bff/src/db/migrate.js && node dist/bff/src/db/seed.js
#   CLI:     node dist/bff/src/cli/index.js <指令>
# 建置(context 為 repo 根目錄,需要 db/):docker build -f bff/Dockerfile -t <registry>/gateway/bff:<SHA> .
FROM node:22-alpine AS build
WORKDIR /repo/bff
COPY bff/package.json bff/package-lock.json ./
# 建置需要 devDependencies(typescript);明確 --include=dev,不受基底映像的 NODE_ENV 影響
RUN npm ci --include=dev
COPY bff/tsconfig.json bff/tsconfig.build.json ./
COPY bff/src ./src
COPY db/seed /repo/db/seed
# backend-sdk 的監控模組以原始碼編入(MONITORING-PLAN W9-6;SDK 發佈到 Registry 後改為一般相依)
COPY sdk/node/src /repo/sdk/node/src
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY bff/package.json bff/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    MIGRATIONS_FOLDER=/app/db/migrations \
    ROUTE_SNAPSHOT_FILE=/app/var/routes-snapshot.json
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /repo/bff/dist ./dist
COPY db/migrations ./db/migrations
COPY bff/package.json ./
RUN mkdir -p /app/var && chown node:node /app/var
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "dist/bff/src/server.js"]
