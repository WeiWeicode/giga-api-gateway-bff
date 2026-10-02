// 權限判斷(PRD §4.2:快取命中 < 2 ms):以 permission 路由產生負載,結束後由 /metrics 的 gw_permission_check_seconds 直方圖計算 p95。
// /metrics 僅內網服務白名單可讀(nginx/allowlists/<區域>/internal-services.conf)。用法見 README.md。
import http from 'k6/http';
import { check } from 'k6';
import { BASE, login } from './lib.js';

const PATH = __ENV.PATH_UNDER_TEST || '/api/k6/perm';

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  return login();
}

export default function (data) {
  const res = http.get(`${BASE}${PATH}`, {
    headers: { Cookie: data.cookie },
  });
  check(res, { 200: (r) => r.status === 200 });
}

/** 由累積直方圖估計 p95(取第一個累積比例 ≥ 95% 的桶上限) */
export function teardown() {
  const metricsUrl = __ENV.METRICS_URL || `${BASE}/metrics`;
  const res = http.get(metricsUrl);
  if (res.status !== 200) {
    console.warn(`無法讀取 /metrics(${res.status}),請在內網服務白名單內的主機執行`);
    return;
  }
  const buckets = [];
  let total = 0;
  for (const line of res.body.split('\n')) {
    const m = /^gw_permission_check_seconds_bucket\{le="([^"]+)"\} (\d+)/.exec(line);
    if (m) buckets.push([m[1] === '+Inf' ? Infinity : Number(m[1]), Number(m[2])]);
    const c = /^gw_permission_check_seconds_count (\d+)/.exec(line);
    if (c) total = Number(c[1]);
  }
  const hit = buckets.find(([, n]) => total > 0 && n / total >= 0.95);
  console.log(`權限判斷 p95 ≤ ${hit ? hit[0] * 1000 : '?'} ms(共 ${total} 次;目標 < 2 ms)`);
}
