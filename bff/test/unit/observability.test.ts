import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import docsPlugin from '../../src/plugins/docs.js';
import metricsPlugin from '../../src/plugins/metrics.js';

const config = loadConfig({
  GW_DB_HOST: 'sql2012',
  GW_DB_NAME: 'giganexus_gw',
  GW_DB_USER: 'gw_app',
  GW_DB_PASSWORD: 'x',
  REDIS_URL: 'redis://redis:6379',
  JWT_KEYS_DIR: '/run/secrets/jwt',
  GW_ENV: 'test',
});

async function build() {
  const app = Fastify();
  await app.register(metricsPlugin);
  await app.register(docsPlugin, { config });
  app.get('/api/admin/things/:id', { schema: { params: { type: 'object', properties: { id: { type: ['string', 'null'] } } } } }, async () => ({ ok: true }));
  app.get('/_auth/verify', async () => '');
  app.get('/api/*', async () => ({ dynamic: true }));
  await app.ready();
  return app;
}

describe('/docs(W3-5.11)', () => {
  it('OpenAPI 3.1 列出路由並依前綴分類;內部端點不列入', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { openapi: string; paths: Record<string, Record<string, { tags: string[] }>> };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/api/admin/things/{id}']?.get?.tags).toEqual(['admin']);
    expect(Object.keys(doc.paths)).not.toContain('/_auth/verify');
    expect(Object.keys(doc.paths)).not.toContain('/api/*');
    expect(Object.keys(doc.paths)).not.toContain('/metrics');
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBeLessThan(400);
    await app.close();
  });
});

describe('/metrics(W3-5.11)', () => {
  it('以路由樣板(或 x-route-code)為標籤記錄請求數與延遲', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/admin/things/123' });
    await app.inject({ method: 'GET', url: '/api/admin/things/456' });
    const text = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(text).toMatch(/gw_http_requests_total\{method="GET",route="\/api\/admin\/things\/:id",status="200"\} 2/);
    expect(text).toContain('gw_http_request_duration_seconds_bucket');
    expect(text).toContain('gw_permission_check_seconds');
    expect(text).toContain('gw_process_cpu_seconds_total');
    // 不以實際路徑當標籤(避免高基數)
    expect(text).not.toContain('things/123');
    await app.close();
  });
});
