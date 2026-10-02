import { cli, cliApply, closeAll, createLocalUser, query, redisDelPattern, Session } from '../test/e2e/gw.js';

const EMP = 'Z99K6001';
const PASSWORD = 'K6Password2026!';

async function main() {
  console.log('1. 檢查/建立 k6 測試帳號...');
  const [existingUser] = await query<{ user_id: number }>('SELECT user_id FROM gw.[user] WHERE employee_no = @emp', { emp: EMP });
  if (!existingUser) {
    console.log(`建立測試帳號 ${EMP}...`);
    await createLocalUser(EMP, 'k6 壓測測試員', PASSWORD);
    console.log(`測試帳號 ${EMP} 建立成功`);
  } else {
    console.log(`測試帳號 ${EMP} 已存在 (user_id=${existingUser.user_id})`);
    await cli('local:unlock', '--emp', EMP).catch(() => {});
  }

  // 測試登入
  const s = new Session();
  const loginRes = await s.post('/api/auth/login', { username: EMP, password: PASSWORD });
  if (loginRes.status !== 200) {
    console.error('登入驗證失敗:', loginRes.status, loginRes.text);
    await cli('local:reset', '--emp', EMP, '--pwd', PASSWORD);
    const retry = await new Session().post('/api/auth/login', { username: EMP, password: PASSWORD });
    if (retry.status !== 200) {
      throw new Error(`無法登入 ${EMP}: ${retry.status} ${retry.text}`);
    }
  }
  console.log('測試帳號登入成功');

  console.log('2. 套用 k6-unlimited 限流政策、k6.ping.read 權限與 mock 路由...');
  await cliApply(`
policies:
  - code: k6-unlimited
    limitCount: 500000
    windowSec: 60
    keyBy: user
permissions:
  - code: k6.ping.read
    name: k6 壓測讀取
roles:
  - code: employee
    permissions:
      - k6.ping.read
routes:
  - routeCode: k6.ping
    name: k6 壓測路由
    systemCode: k6
    method: GET
    publicPath: /api/k6/ping
    routeType: mock
    authMode: authenticated
    rateLimitPolicy: k6-unlimited
    mockResponse: { pong: true }
  - routeCode: k6.perm
    name: k6 權限壓測路由
    systemCode: k6
    method: GET
    publicPath: /api/k6/perm
    routeType: mock
    authMode: permission
    permissionCode: k6.ping.read
    rateLimitPolicy: k6-unlimited
    mockResponse: { pong: true }
`);
  console.log('發佈路由...');
  await cli('publish', '--note', 'k6 壓測路由(含 authenticated 與 permission 路由)發佈');
  console.log('/api/k6/ping 與 /api/k6/perm 路由已就緒');

  // 清除 Redis 限流計數
  await redisDelPattern('gw:rl:*');

  // 測試以新 token 呼叫 /api/k6/ping
  const s2 = new Session();
  const l2 = await s2.post('/api/auth/login', { username: EMP, password: PASSWORD });
  if (l2.status !== 200) throw new Error(`登入失敗: ${l2.status} ${l2.text}`);
  const pingRes = await s2.get('/api/k6/ping');
  console.log('Ping 測試結果:', pingRes.status, pingRes.text);

  await closeAll();
  console.log('前置設定完成！');
}

main().catch((err) => {
  console.error('失敗:', err);
  process.exit(1);
});
