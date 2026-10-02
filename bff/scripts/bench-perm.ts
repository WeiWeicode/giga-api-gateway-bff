import { remote, BFF } from '../test/e2e/gw.js';

async function main() {
  console.log('在測試區 BFF 容器執行權限快取判斷基準測試 (Redis cache hit)...');
  const jsCode = `
import { Redis } from 'ioredis';
const redis = new Redis(process.env.REDIS_URL || 'redis://giganexus-gw-redis-1:6379');

async function run() {
  const testKey = 'gw:perm:bench:test';
  await redis.sadd(testKey, 'test.permission.read');
  
  // Warm up
  await redis.multi().sismember(testKey, 'test.permission.read').exists(testKey).exec();

  const N = 2000;
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    const [[, member], [, exists]] = await redis.multi().sismember(testKey, 'test.permission.read').exists(testKey).exec();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }

  times.sort((a, b) => a - b);
  const min = times[0];
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const max = times[times.length - 1];
  const avg = times.reduce((a, b) => a + b, 0) / times.length;

  console.log(JSON.stringify({
    N,
    min: min.toFixed(3),
    avg: avg.toFixed(3),
    p50: p50.toFixed(3),
    p95: p95.toFixed(3),
    p99: p99.toFixed(3),
    max: max.toFixed(3)
  }));

  await redis.del(testKey);
  await redis.quit();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

  const script = `docker exec -i ${BFF} node --input-type=module <<'EOF'
${jsCode}
EOF
`;

  const out = await remote(script);
  console.log('測試結果:');
  const res = JSON.parse(out.trim());
  console.log(`樣本數 N: ${res.N}`);
  console.log(`Min: ${res.min} ms`);
  console.log(`Avg: ${res.avg} ms`);
  console.log(`p50: ${res.p50} ms`);
  console.log(`p95: ${res.p95} ms (目標 < 2 ms)`);
  console.log(`p99: ${res.p99} ms`);
  console.log(`Max: ${res.max} ms`);
}

main().catch((err) => {
  console.error('Bench failed:', err);
  process.exit(1);
});
