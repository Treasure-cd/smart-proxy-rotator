const cfg = require('./config');
const Pool = require('./pool');
const { fetchSources } = require('./sources');
const { tcpCheck, httpCheck, validate, mapLimit } = require('./validator');
const { createServer } = require('./server');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pool = new Pool();
let realIp = null;
let refreshing = false;
let revalidating = false;
let lastRefresh = 0;

async function discoverRealIp() {
  const res = await fetch(cfg.IP_URL, { signal: AbortSignal.timeout(10_000) });
  const { origin } = await res.json();
  return String(origin).split(',')[0].trim();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  lastRefresh = Date.now();
  try {
    const found = await fetchSources();
    const fresh = found.filter((p) => !pool.has(p.key));
    log(`from refresh: scraped ${found.length} proxies, ${fresh.length} new`);

    const open = [];
    await mapLimit(fresh, cfg.TCP_CONCURRENCY, async (p) => {
      (await tcpCheck(p.host, p.port)) !== null ? open.push(p) : pool.markDead(p.key);
    });
    log(`from refresh: ${open.length} accepted a TCP connection`);

    //  real request, along with anonymity and HTTPS support
    let good = 0;
    await mapLimit(open, cfg.HTTP_CONCURRENCY, async (p) => {
      const res = await validate(p, realIp);
      if (res) { pool.add(p, res); good++; } else pool.markDead(p.key);
    });
    log(`from refresh: ${good} validated, pool active: ${(pool.rebuild(), pool.activeCount())}`);
  } catch (e) {
    log('from refresh: error:', e.message);
  } finally {
    refreshing = false;
    pool.rebuild();
  }
}

async function revalidate() {
  if (revalidating) return;
  revalidating = true;
  try {
    await mapLimit(pool.due(), 50, async (r) => {
      const res = await httpCheck(r, realIp);
      const ok = res && cfg.ALLOWED_ANON.includes(res.anonymity);
      pool.report(r.key, !!ok, ok ? res.latency : undefined);
    });
  } finally {
    revalidating = false;
    pool.rebuild();
  }
}

function tick() {
  revalidate();
  if (pool.activeCount() < cfg.MIN_ACTIVE || Date.now() - lastRefresh > cfg.REFRESH_MS) refresh();
}

async function main() {
  try {
    realIp = await discoverRealIp();
    log(`(${realIp})`);
  } catch (e) {
    console.error('Could not detect your real IP:', e.message);
    process.exit(1);
  }

  const saved = pool.load(cfg.STATE_FILE);
  if (saved) {
    lastRefresh = saved.lastRefresh || 0;
    log(`[init] restored ${pool.activeCount()} active proxies from disk`);
    revalidate();
  }

  const save = () => {
    try { pool.save(cfg.STATE_FILE, { lastRefresh }); }
    catch (e) { log('[save] failed:', e.message); }
  };
  setInterval(save, cfg.SAVE_MS).unref();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });

  setInterval(() => pool.rebuild(), 2000).unref();
  setInterval(tick, cfg.TICK_MS).unref();

  createServer(pool).listen(cfg.PORT, () => {
    log(`listening on http://localhost:${cfg.PORT}  (stats: /__stats, pool: /__pool)`);
  });

  if (pool.activeCount() < cfg.MIN_ACTIVE) refresh();
}

main();
