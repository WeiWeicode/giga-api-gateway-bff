// k6 共用:本機帳號登入,回傳 Cookie 與 CSRF(PRD §8.2.2)。k6 以 ES module 執行,不經 TypeScript / Vitest。
import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE = __ENV.BASE || 'https://giganexus-test.gigasolar.com.tw';

export function login(user = __ENV.USER, password = __ENV.PASSWORD) {
  if (!user || !password) fail('請以 -e USER=<假工號> -e PASSWORD=<密碼> 指定測試帳號');
  const jar = http.cookieJar();
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ username: user, password }), {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'login' },
  });
  if (!check(res, { 'login 200': (r) => r.status === 200 })) fail(`登入失敗:${res.status} ${res.body}`);
  const cookies = jar.cookiesForURL(`${BASE}/`);
  return { csrf: (cookies.gn_csrf || [])[0] };
}
