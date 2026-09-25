import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../src/cli/openapi.js';

const doc = (op: Record<string, unknown>) => ({
  'x-gateway': { upstream: 'node-sample', system: 'smp' },
  'x-permissions': [{ code: 'smp.item.read', name: '項目查詢' }],
  paths: { '/v1/items/{id}': { get: { operationId: 'smp.item.get', summary: '查詢項目', 'x-permission': 'smp.item.read', ...op } } },
});

describe('parseOpenApi:description 與 x-gherkin', () => {
  it('description → description、x-gherkin → gherkin(去除前後空白)', () => {
    const gherkin = '場景: 查詢存在的項目\n  當 呼叫 GET /api/smp/items/1\n  那麼 回應 200\n';
    const spec = parseOpenApi(doc({ description: ' 依 ID 查詢單一項目 ', 'x-gherkin': gherkin }));
    expect(spec.errors).toEqual([]);
    expect(spec.routes[0]).toMatchObject({ description: '依 ID 查詢單一項目', gherkin: gherkin.trim() });
  });

  it('未提供時為 null,不列為錯誤', () => {
    const spec = parseOpenApi(doc({}));
    expect(spec.errors).toEqual([]);
    expect(spec.routes[0]).toMatchObject({ description: null, gherkin: null });
  });

  it('description 超過 1000 字、x-gherkin 不是文字時列為錯誤', () => {
    const spec = parseOpenApi(doc({ description: 'x'.repeat(1001), 'x-gherkin': ['場景: x'] }));
    expect(spec.errors.map((e) => e.message)).toEqual(['description 需為 1000 字以內的文字', 'x-gherkin 需為文字(Gherkin 場景)']);
  });
});
