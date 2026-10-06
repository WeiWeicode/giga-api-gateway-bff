/**
 * nginx-log-agent(MONITORING-PLAN D4、W9-7):Nginx access log → 每分鐘彙總 → giga-observe
 *
 *   - 讀 Nginx 寫到共用 volume 的 JSON access log(nginx.conf 的 access_log /var/log/nginx-gw/access.json json)
 *   - 每分鐘彙總:請求數、狀態碼分布、401 / 403 / 429…、傳輸量、平均 / p95 回應時間、不重複來源 IP、Top 20 來源 IP、Top 20 路徑
 *   - 已結束的分鐘送 POST /api/v1/ingest/traffic(服務 gw-nginx 的 ingest Key);送不出去保留重送(最多 120 分鐘)
 *   - 每 30 秒心跳(帶 stub_status 檢查結果),架構圖的 Gateway Nginx 節點
 *   - 檔案超過 LOG_MAX_MB 時截斷(nginx 以 O_APPEND 寫入,截斷安全;原始紀錄仍在 Nginx stdout / docker logs)
 *
 * 不逐筆送:BFF 已逐筆回報同一批請求。本程式掛掉不影響 Nginx。無外部相依,只用 Node 內建模組。
 *
 * 環境變數:MONITOR_URL、MONITOR_API_KEY(_FILE)、LOG_FILE、LOG_MAX_MB(預設 50)、STUB_STATUS_URL、READ_INTERVAL_MS(預設 5000)
 */
import { closeSync, openSync, readFileSync, readSync, statSync, truncateSync } from 'node:fs';
import { BlockList, isIPv4 } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOP_N = 20;
const KEEP_MINUTES = 120;
/** 分鐘結束後再等幾毫秒才送(寫入延遲、時鐘差) */
const GRACE_MS = 10_000;

/** Docker / 主機內部網段:沒走 PROXY protocol 時 remote_addr 會是這些位址(DEPLOYMENT.md §6.1) */
const INTERNAL = new BlockList();
INTERNAL.addSubnet('172.16.0.0', 12, 'ipv4');
INTERNAL.addAddress('127.0.0.1', 'ipv4');

export function isInternalIp(ip) {
  return isIPv4(ip) && INTERNAL.check(ip, 'ipv4');
}

/** 路徑去掉 query,數字 / UUID / 長 hex 段落換成 :id,避免 Top 路徑被同一 API 的不同參數洗版 */
export function normalizePath(uri) {
  const p = String(uri || '/').split('?')[0];
  return (
    p
      .split('/')
      .map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s) || /^[0-9a-f]{24,}$/i.test(s) ? ':id' : s))
      .join('/')
      .slice(0, 200) || '/'
  );
}

function minuteOf(time) {
  const t = Date.parse(time);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 60_000) * 60_000;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function top(map, n, toItem) {
  return [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, n)
    .map(toItem);
}

/** 一分鐘的累計器 */
export class Bucket {
  constructor(minute) {
    this.minute = minute;
    this.total = 0;
    this.status = {};
    this.codes = {};
    this.bytes = 0;
    this.times = [];
    this.ips = new Map();
    this.paths = new Map();
    this.internal = 0;
  }

  add(e) {
    const status = Number(e.status) || 0;
    const cls = `${Math.floor(status / 100)}xx`;
    this.total += 1;
    this.status[cls] = (this.status[cls] || 0) + 1;
    if (status >= 400) this.codes[status] = (this.codes[status] || 0) + 1;
    this.bytes += Number(e.bytes) || 0;
    const ms = Math.round((Number(e.request_time) || 0) * 1000);
    this.times.push(ms);
    const ip = String(e.remote_addr || '');
    if (isInternalIp(ip)) this.internal += 1;
    const ipStat = this.ips.get(ip) || { count: 0, errors: 0, denied: 0 };
    ipStat.count += 1;
    if (status >= 500) ipStat.errors += 1;
    if (status === 401 || status === 403 || status === 429) ipStat.denied += 1;
    this.ips.set(ip, ipStat);
    const path = normalizePath(e.uri);
    const pathStat = this.paths.get(path) || { count: 0, errors: 0 };
    pathStat.count += 1;
    if (status >= 500) pathStat.errors += 1;
    this.paths.set(path, pathStat);
  }

  toJSON() {
    const sorted = [...this.times].sort((a, b) => a - b);
    return {
      ts: new Date(this.minute).toISOString(),
      total: this.total,
      status: this.status,
      codes: this.codes,
      bytes: this.bytes,
      avgMs: sorted.length ? Math.round(sorted.reduce((s, x) => s + x, 0) / sorted.length) : 0,
      p95Ms: percentile(sorted, 0.95),
      uniqueIps: this.ips.size,
      topIps: top(this.ips, TOP_N, ([ip, v]) => ({ ip, ...v })),
      topPaths: top(this.paths, TOP_N, ([path, v]) => ({ path, ...v })),
      // 超過一半來自內部網段 → 多半沒走 PROXY protocol,來源 IP 不可信
      realIp: this.internal * 2 <= this.total,
    };
  }
}

/** 彙總器:吃一行行 JSON log,吐出已結束的分鐘 */
export class Aggregator {
  constructor() {
    this.buckets = new Map();
    this.skipped = 0;
  }

  line(text) {
    if (!text.trim()) return;
    let e;
    try {
      e = JSON.parse(text);
    } catch {
      this.skipped += 1;
      return;
    }
    const m = minuteOf(e.time);
    if (m === null) {
      this.skipped += 1;
      return;
    }
    if (!this.buckets.has(m)) this.buckets.set(m, new Bucket(m));
    this.buckets.get(m).add(e);
  }

  /** 取出 now - GRACE 之前已結束的分鐘 */
  drain(now = Date.now()) {
    const cutoff = Math.floor((now - GRACE_MS) / 60_000) * 60_000;
    const done = [];
    for (const [m, b] of [...this.buckets.entries()].sort((a, b) => a[0] - b[0])) {
      if (m >= cutoff) break;
      done.push(b.toJSON());
      this.buckets.delete(m);
    }
    return done;
  }
}

/** 增量讀檔:記住讀到的位置;檔案被截斷或換新時從頭讀 */
export class Tailer {
  constructor(file, maxBytes) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.pos = 0;
    this.rest = '';
  }

  read() {
    let size;
    try {
      size = statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.pos) {
      this.pos = 0;
      this.rest = '';
    }
    if (size === this.pos) return [];
    const fd = openSync(this.file, 'r');
    try {
      const len = Math.min(size - this.pos, 16 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, this.pos);
      this.pos += len;
      const text = this.rest + buf.toString('utf8');
      const lines = text.split('\n');
      this.rest = lines.pop() ?? '';
      if (this.pos >= this.maxBytes && !this.rest) {
        try {
          truncateSync(this.file, 0);
          this.pos = 0;
        } catch (err) {
          if (!this.truncateWarned) console.warn(`[nginx-log-agent] 無法截斷 ${this.file}:${err.message}`);
          this.truncateWarned = true;
        }
      }
      return lines;
    } finally {
      closeSync(fd);
    }
  }
}

function secret(name) {
  const file = process.env[`${name}_FILE`];
  if (!file) return process.env[name] || '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    // Key 檔還沒放好不讓容器重啟循環,只停用回報
    console.warn(`[nginx-log-agent] 無法讀取 ${name}_FILE:${err.message}`);
    return '';
  }
}

async function main() {
  const endpoint = (process.env.MONITOR_URL || '').replace(/\/$/, '');
  const apiKey = secret('MONITOR_API_KEY');
  const file = process.env.LOG_FILE || '/var/log/nginx-gw/access.json';
  const stubUrl = process.env.STUB_STATUS_URL || 'http://nginx:8081/stub_status';
  const tailer = new Tailer(file, (Number(process.env.LOG_MAX_MB) || 50) * 1024 * 1024);
  const agg = new Aggregator();
  let pending = [];
  let warned = false;

  if (!endpoint || !apiKey) console.warn('[nginx-log-agent] 未設定 MONITOR_URL 或 MONITOR_API_KEY:只讀檔不回報');
  console.log(`[nginx-log-agent] 讀取 ${file},回報 ${endpoint || '(停用)'}`);

  const post = async (path, body) => {
    const res = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel().catch(() => undefined);
    // 4xx(格式錯、認證錯)重送沒用;5xx 重送
    return res.status < 500;
  };

  setInterval(async () => {
    try {
      for (const l of tailer.read()) agg.line(l);
    } catch (err) {
      // 讀檔失敗(權限、檔案暫時不存在…)下一輪再試,不讓程序結束
      console.warn(`[nginx-log-agent] 讀取失敗:${err.message}`);
    }
    pending = pending.concat(agg.drain()).slice(-KEEP_MINUTES);
    if (!pending.length || !endpoint || !apiKey) return;
    const batch = pending.slice(0, 100);
    try {
      if (await post('/api/v1/ingest/traffic', { minutes: batch })) {
        pending = pending.slice(batch.length);
        warned = false;
      }
    } catch (err) {
      if (!warned) console.warn(`[nginx-log-agent] 回報失敗,稍後重送:${err.message}`);
      warned = true;
    }
  }, Number(process.env.READ_INTERVAL_MS) || 5000);

  const startedAt = Date.now();
  const heartbeat = async () => {
    if (!endpoint || !apiKey) return;
    const t0 = Date.now();
    let nginx = { name: 'nginx', ok: false, latencyMs: null };
    try {
      const r = await fetch(stubUrl, { signal: AbortSignal.timeout(2000) });
      await r.text();
      nginx = { name: 'nginx', ok: r.ok, latencyMs: Date.now() - t0 };
    } catch {
      // nginx 無回應:ok = false
    }
    // Nginx 沒回應就不送心跳:否則 agent 活著會讓 Gateway Nginx 節點一直顯示正常
    if (!nginx.ok) return;
    await post('/api/v1/heartbeat', { ts: new Date().toISOString(), version: process.env.IMAGE_TAG || null, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), deps: [nginx] }).catch(() => undefined);
  };
  heartbeat();
  setInterval(heartbeat, 30_000);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
