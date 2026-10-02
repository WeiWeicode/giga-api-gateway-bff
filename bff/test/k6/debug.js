import http from 'k6/http';
import { check } from 'k6';
import { BASE } from './lib.js';

let cachedCookie = null;

function loginOnce() {
  if (cachedCookie) return cachedCookie;
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ username: __ENV.USER, password: __ENV.PASSWORD }), {
    headers: { 'content-type': 'application/json' },
  });
  const at = res.cookies.gn_at?.[0]?.value;
  cachedCookie = `gn_at=${at}`;
  return cachedCookie;
}

export const options = { vus: 1, iterations: 3 };

export default function () {
  const cookie = loginOnce();
  const res = http.get(`${BASE}/api/k6/ping`, { headers: { Cookie: cookie } });
  check(res, { 'status is 200': (r) => r.status === 200 });
  console.log(`Iter ${__ITER}: status = ${res.status}`);
}
