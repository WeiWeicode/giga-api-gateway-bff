// BFF 吞吐與延遲(PRD §4.2:單實例 ≥ 1,500 RPS、Gateway 額外延遲 p95 < 20 ms)。用法見 README.md。
import http from 'k6/http';
import { check } from 'k6';
import { BASE, login } from './lib.js';

const RATE = Number(__ENV.RATE || 1500);
const PATH = __ENV.PATH_UNDER_TEST || '/api/k6/ping';

export const options = {
  scenarios: {
    constant: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: Math.ceil(RATE / 4),
      maxVUs: RATE,
    },
  },
  thresholds: {
    'http_req_duration{name:route}': ['p(95)<20'],
    http_req_failed: ['rate<0.01'],
    // 未達目標速率時(dropped_iterations)代表吞吐不足
    dropped_iterations: ['count<' + Math.ceil(RATE * 0.01 * 60)],
  },
};

export function setup() {
  return login();
}

export default function (data) {
  const res = http.get(`${BASE}${PATH}`, {
    headers: { Cookie: data.cookie },
    tags: { name: 'route' },
  });
  check(res, { 200: (r) => r.status === 200 });
}
