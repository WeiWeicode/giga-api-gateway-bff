import { query, cli, redisDelPattern, closeAll } from '../test/e2e/gw.js';

async function main() {
  console.log('1. 刪除 k6 測試路由與政策...');
  await query("DELETE FROM gw.aggregate_step WHERE route_id IN (SELECT route_id FROM gw.api_route WHERE route_code LIKE 'k6.%')");
  await query("DELETE FROM gw.api_route WHERE route_code LIKE 'k6.%'");
  await query("DELETE FROM gw.role_permission WHERE permission_id IN (SELECT permission_id FROM gw.permission WHERE code LIKE 'k6.%')");
  await query("DELETE FROM gw.permission WHERE code LIKE 'k6.%'");
  await query("DELETE FROM gw.rate_limit_policy WHERE code = 'k6-unlimited'");

  console.log('2. 發佈空更動使 BFF 熱重載清除測試路由...');
  await cli('publish', '--note', '清除 k6 壓測路由');

  console.log('3. 清理 Redis 限流與快取...');
  await redisDelPattern('gw:rl:*');
  await redisDelPattern('gw:perm:bench:*');

  await closeAll();
  console.log('k6 測試環境清理完成！');
}

main().catch((err) => {
  console.error('清理失敗:', err);
  process.exit(1);
});
