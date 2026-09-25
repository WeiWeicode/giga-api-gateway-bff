# Node.js 下游後端樣本

依 [BACKEND-GUIDE.md](../../docs/BACKEND-GUIDE.md) 撰寫的最小 Fastify 服務,可複製作為新後端的起點。AI 協作規則見 [AGENT.md](AGENT.md)。

- X-Internal-Token 驗證(§4.2)、資料層級權限、統一錯誤格式(§5.3)、`/healthz` / `/readyz` / `/openapi.json`
- 每支 API 附 `description`(用途說明)與 `x-gherkin`(行為規格),自動註冊時寫入 `gw.api_route`
- `GW_ENV=dev|test|prod`;test、prod 啟動時以 API Key 自動註冊為 Gateway 草稿(§7.5)
- 共用功能來自 [`@giganexus/backend-sdk`](../../sdk/node)

## 開始

```bash
npm install          # 會一併建置 ../../sdk/node
cp .env.example .env # 填入 SERVICE_CODE、PORT、GW_BASE_URL、GW_API_KEY
npm run dev
npm test
```

API Key 由 Gateway 負責人建立(明文只顯示一次):

```bash
npm run gw -- client:create --code <服務代碼>
```

複製到獨立專案時,把 `package.json` 的 `@giganexus/backend-sdk` 改為公司 npm registry 的版本,並移除 `postinstall`。
