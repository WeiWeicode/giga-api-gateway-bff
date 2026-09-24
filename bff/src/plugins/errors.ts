/**
 * 統一錯誤回應(PRD §8.1.1):{ code, message, requestId, details? };不回傳堆疊或 SQL 內容。
 */
import fp from 'fastify-plugin';
import type { FastifyError } from 'fastify';
import { errorBody, GwError } from '../errors.js';

export default fp(
  async (app) => {
    app.setErrorHandler((err: FastifyError | GwError, req, reply) => {
      if (err instanceof GwError) {
        if (err.status >= 500) req.log.warn({ code: err.code, msg: err.message }, 'Gateway 錯誤');
        return reply.code(err.status).send(errorBody(err.code, err.message, req.id, err.details));
      }
      if (err.validation) {
        const details = err.validation.map((v) => ({
          field: v.instancePath.replace(/^\//, '') || (v.params as { missingProperty?: string }).missingProperty,
          message: v.message,
        }));
        return reply.code(400).send(errorBody('VALIDATION_FAILED', '參數驗證失敗', req.id, details));
      }
      if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send(errorBody('PAYLOAD_TOO_LARGE', '請求內容過大', req.id));
      if (
        err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
        err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
        (err.statusCode === 400 && err.code?.startsWith('FST_ERR_CTP'))
      ) {
        return reply.code(400).send(errorBody('VALIDATION_FAILED', '請求格式錯誤', req.id));
      }
      req.log.error({ err }, '未預期的錯誤');
      return reply.code(500).send(errorBody('INTERNAL_ERROR', '系統發生錯誤', req.id));
    });

    app.setNotFoundHandler((req, reply) => reply.code(404).send(errorBody('ROUTE_NOT_FOUND', '找不到此 API', req.id)));
  },
  { name: 'errors' },
);
