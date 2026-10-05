import { cli, remote } from '../test/e2e/gw.js';

async function main() {
  console.log('量測路由生效時間 (目標 ≤ 5 秒)...');

  // 取得發佈前 bff-1 與 bff-2 的版本
  const getVersion = async (container: string) => {
    const out = await remote(`docker exec ${container} wget -qO- http://127.0.0.1:3000/metrics`);
    const m = /gw_route_snapshot_version\s+(\d+)/.exec(out);
    return m ? Number(m[1]) : 0;
  };

  const v1Before = await getVersion('giganexus-gw-bff-1-1');
  const v2Before = await getVersion('giganexus-gw-bff-2-1');
  console.log(`發佈前版本: bff-1=${v1Before}, bff-2=${v2Before}`);

  const t0 = Date.now();
  // 發佈一個註記變更以產生新版本
  const pub = await cli('publish', '--note', `Propagation test ${Date.now()}`);
  console.log(`發佈回傳: version=${pub.version}`);

  const targetVersion = pub.version;
  let bff1Updated = false;
  let bff2Updated = false;
  let t1 = 0;
  let t2 = 0;

  for (let i = 0; i < 50; i++) {
    const now = Date.now();
    if (!bff1Updated) {
      const v1 = await getVersion('giganexus-gw-bff-1-1');
      if (v1 === targetVersion) {
        bff1Updated = true;
        t1 = (now - t0) / 1000;
        console.log(`bff-1 生效: ${t1.toFixed(3)} 秒`);
      }
    }
    if (!bff2Updated) {
      const v2 = await getVersion('giganexus-gw-bff-2-1');
      if (v2 === targetVersion) {
        bff2Updated = true;
        t2 = (now - t0) / 1000;
        console.log(`bff-2 生效: ${t2.toFixed(3)} 秒`);
      }
    }
    if (bff1Updated && bff2Updated) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const maxTime = Math.max(t1, t2);
  console.log(`\n路由發佈傳播時間: ${maxTime.toFixed(3)} 秒 (目標 ≤ 5 秒) -> ${maxTime <= 5 ? 'PASSED ✅' : 'FAILED ❌'}`);
}

main().catch((err) => {
  console.error('量測失敗:', err);
  process.exit(1);
});
