/**
 * 範例資源:樣本項目(記憶體資料,示範用)。新增 API 前先查 Gateway 既有路由(AGENT.md §1)。
 *
 * 每個 operation 必填(BACKEND-GUIDE.md §6.1):
 *   operationId  {system}.{resource}.{action},對應 gw.api_route.route_code
 *   summary      中文名稱
 *   description  API 用途說明(gw.api_route.description)
 *   x-permission 權限代碼 / authenticated / public
 *   x-gherkin    行為規格(gw.api_route.gherkin),Gherkin zh-TW 關鍵字
 * 後端路徑 /v1/items 對外為 /api/sample/items(預設去掉版本段)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../errors.js';

interface Item {
  id: number;
  name: string;
  dept: string;
  createdBy: string;
  createdAt: string;
}

const items: Item[] = [
  { id: 1, name: '範例項目 A', dept: 'S1800', createdBy: 'S112009', createdAt: '2026-09-25T08:00:00+08:00' },
  { id: 2, name: '範例項目 B', dept: 'S1900', createdBy: 'S100001', createdAt: '2026-09-25T08:30:00+08:00' },
];

const itemSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    dept: { type: 'string' },
    createdBy: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const itemRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { page?: number; pageSize?: number } }>(
    '/v1/items',
    {
      schema: {
        operationId: 'sample.item.list',
        summary: '樣本項目清單',
        description: '列出目前使用者所屬部門(Token 的 dept)的樣本項目,支援分頁。',
        tags: ['樣本項目'],
        'x-permission': 'sample.item.read',
        'x-gherkin': [
          '場景: 只列出自己部門的項目',
          '  假如 使用者 S112009 屬於部門 S1800 且擁有 sample.item.read',
          '  當 呼叫 GET /api/sample/items',
          '  那麼 回應 200',
          '  而且 items 只包含 dept 為 S1800 的項目',
        ].join('\n'),
        querystring: {
          type: 'object',
          properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        },
        response: {
          200: {
            type: 'object',
            properties: { items: { type: 'array', items: itemSchema }, total: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer' } },
          },
        },
      },
    },
    async (req) => {
      const { page = 1, pageSize = 20 } = req.query;
      // 資料層級權限由後端依 dept / cos / roles 自行過濾(BACKEND-GUIDE.md §4.3)
      const mine = items.filter((i) => i.dept === req.identity?.dept);
      return { items: mine.slice((page - 1) * pageSize, page * pageSize), total: mine.length, page, pageSize };
    },
  );

  app.get<{ Params: { id: number } }>(
    '/v1/items/:id',
    {
      schema: {
        operationId: 'sample.item.get',
        summary: '查詢樣本項目',
        description: '依 ID 查詢單一樣本項目;不存在回 404 SAMPLE_ITEM_NOT_FOUND,不同部門回 403 DATA_ACCESS_DENIED。',
        tags: ['樣本項目'],
        'x-permission': 'sample.item.read',
        'x-gherkin': [
          '場景: 查詢不存在的項目',
          '  假如 使用者擁有 sample.item.read',
          '  當 呼叫 GET /api/sample/items/999',
          '  那麼 回應 404',
          '  而且 回應的 code 為 "SAMPLE_ITEM_NOT_FOUND"',
        ].join('\n'),
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        response: { 200: itemSchema },
      },
    },
    async (req) => {
      const item = items.find((i) => i.id === req.params.id);
      if (!item) throw new AppError(404, 'SAMPLE_ITEM_NOT_FOUND', '找不到此項目');
      if (item.dept !== req.identity?.dept) throw new AppError(403, 'DATA_ACCESS_DENIED', '無權查看其他部門的資料');
      return item;
    },
  );

  app.post<{ Body: { name: string } }>(
    '/v1/items',
    {
      schema: {
        operationId: 'sample.item.create',
        summary: '新增樣本項目',
        description: '新增一筆樣本項目,部門與建立者取自 Token 的 dept 與 emp。',
        tags: ['樣本項目'],
        'x-permission': 'sample.item.write',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 名稱空白時驗證失敗',
          '  假如 使用者擁有 sample.item.write',
          '  當 呼叫 POST /api/sample/items,內容為 {"name": ""}',
          '  那麼 回應 400',
          '  而且 回應的 code 為 "VALIDATION_FAILED"',
        ].join('\n'),
        body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } },
        response: { 201: itemSchema },
      },
    },
    async (req, reply) => {
      const item: Item = {
        id: Math.max(0, ...items.map((i) => i.id)) + 1,
        name: req.body.name,
        dept: req.identity?.dept ?? '',
        createdBy: req.identity?.emp ?? req.identity?.sub ?? '',
        createdAt: new Date().toISOString(),
      };
      items.push(item);
      return reply.status(201).send(item);
    },
  );

  app.get(
    '/v1/me',
    {
      schema: {
        operationId: 'sample.me.get',
        summary: '目前使用者',
        description: '回傳 Gateway 傳下來的身分(X-Internal-Token 內容),示範 authenticated:登入即可呼叫。',
        tags: ['樣本項目'],
        'x-permission': 'authenticated',
        'x-gherkin': [
          '場景: 回傳目前使用者的工號',
          '  假如 使用者 S112009 已登入',
          '  當 呼叫 GET /api/sample/me',
          '  那麼 回應 200',
          '  而且 emp 為 "S112009"',
        ].join('\n'),
      },
    },
    async (req) => ({ emp: req.identity?.emp, name: req.identity?.name, dept: req.identity?.dept, roles: req.identity?.roles ?? [] }),
  );
};

export default itemRoutes;
