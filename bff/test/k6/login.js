// 登入延遲(PRD §4.2:p95 < 1 秒;本機帳號 Argon2id)。用法見 README.md。
// 登入失敗不會暫停(PRD v0.10),但本機帳號連續 10 次失敗會鎖定:請確認密碼正確再執行。
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE } from './lib.js';

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '1m',
  thresholds: {
    'http_req_duration{name:login}': ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ username: __ENV.USER, password: __ENV.PASSWORD }), {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'login' },
  });
  check(res, { 'login 200': (r) => r.status === 200 });
  // 清除 Cookie,每次都是新的登入
  http.cookieJar().clear(`${BASE}/`);
  sleep(0.5);
}
