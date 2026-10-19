const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('../src/config');
const Pool = require('../src/pool');
const { withCfg } = require('./helpers');

function proxy(n, latency = 100, extra = {}) {
  return [
    { key: `10.0.0.${n}:80`, host: `10.0.0.${n}`, port: 80 },
    { latency, anonymity: 'elite', https: true, ...extra },
  ];
}

function poolOf(...latencies) {
  const pool = new Pool();
  latencies.forEach((l, i) => pool.add(...proxy(i + 1, l)));
  pool.rebuild();
  return pool;
}

describe('scoring and selection', () => {
  test('faster proxies score higher', () => {
    const pool = poolOf(900, 100, 400);
    assert.deepEqual(pool.snapshot.map((r) => r.key), ['10.0.0.2:80', '10.0.0.3:80', '10.0.0.1:80']);
  });

  test('a reliable slow proxy outranks a fast proxy that keeps failing', () => {
    const pool = poolOf(300, 100);
    const flaky = pool.map.get('10.0.0.2:80');
    flaky.fail = 6; // fast but failing
    const steady = pool.map.get('10.0.0.1:80');
    steady.ok = 30; // slower but proven
    pool.rebuild();
    assert.equal(pool.snapshot[0].key, '10.0.0.1:80');
  });

  test('pick never returns a proxy outside the top N', async () => {
    await withCfg(cfg, { TOP_N: 2 }, () => {
      const pool = poolOf(100, 200, 300, 400, 500);
      const allowed = new Set(['10.0.0.1:80', '10.0.0.2:80']);
      for (let i = 0; i < 300; i++) assert.ok(allowed.has(pool.pick().key));
    });
  });

  test('pick can return every proxy within the top N (it rotates)', async () => {
    await withCfg(cfg, { TOP_N: 3 }, () => {
      const pool = poolOf(100, 110, 120, 900);
      const seen = new Set();
      for (let i = 0; i < 500; i++) seen.add(pool.pick().key);
      assert.equal(seen.size, 3);
    });
  });

  test('pick honours the https filter and the exclude set', () => {
    const pool = new Pool();
    pool.add(...proxy(1, 100, { https: false }));
    pool.add(...proxy(2, 200, { https: true }));
    pool.rebuild();
    assert.equal(pool.pick({ https: true }).key, '10.0.0.2:80');
    assert.equal(pool.pick({ https: true, exclude: new Set(['10.0.0.2:80']) }), null);
    assert.equal(pool.pick({ exclude: new Set(['10.0.0.1:80', '10.0.0.2:80']) }), null);
  });

  test('pick returns null on an empty pool', () => {
    assert.equal(new Pool().pick(), null);
  });
});

describe('lifecycle', () => {
  test('successes smooth latency with an EWMA and reset the failure streak', () => {
    const pool = poolOf(1000);
    const r = pool.map.get('10.0.0.1:80');
    r.consecFail = 2;
    pool.report(r.key, true, 200);
    assert.equal(r.consecFail, 0);
    assert.equal(Math.round(r.latency), Math.round(0.7 * 1000 + 0.3 * 200));
  });

  test('three consecutive failures move a proxy to cooldown and out of rotation', () => {
    const pool = poolOf(100, 200);
    const key = '10.0.0.1:80';
    pool.report(key, false);
    pool.report(key, false);
    assert.equal(pool.map.get(key).state, 'active');
    pool.report(key, false);
    assert.equal(pool.map.get(key).state, 'cooldown');
    pool.rebuild();
    assert.deepEqual(pool.snapshot.map((r) => r.key), ['10.0.0.2:80']);
  });

  test('failing during cooldown evicts the proxy and blocklists it', () => {
    const pool = poolOf(100);
    const key = '10.0.0.1:80';
    for (let i = 0; i < cfg.MAX_FAILS; i++) pool.report(key, false);
    pool.report(key, false);
    assert.equal(pool.map.has(key), false);
    assert.equal(pool.has(key), true);
  });

  test('a success after cooldown restores the proxy to active', () => {
    const pool = poolOf(100);
    const key = '10.0.0.1:80';
    for (let i = 0; i < cfg.MAX_FAILS; i++) pool.report(key, false);
    pool.report(key, true, 120);
    assert.equal(pool.map.get(key).state, 'active');
  });

  test('blocklist entries expire', () => {
    const pool = new Pool();
    pool.markDead('1.1.1.1:80');
    assert.equal(pool.has('1.1.1.1:80'), true);
    pool.dead.set('1.1.1.1:80', Date.now() - 1);
    assert.equal(pool.has('1.1.1.1:80'), false);
  });

  test('due() lists stale actives and cooled-down proxies whose wait is over', () => {
    const pool = poolOf(100, 100, 100);
    pool.map.get('10.0.0.1:80').lastChecked = Date.now() - cfg.REVALIDATE_MS - 1000;
    const cooled = pool.map.get('10.0.0.2:80');
    cooled.state = 'cooldown';
    cooled.cooldownUntil = Date.now() - 1;
    const waiting = pool.map.get('10.0.0.3:80');
    waiting.state = 'cooldown';
    waiting.cooldownUntil = Date.now() + 60_000;
    assert.deepEqual(pool.due().map((r) => r.key).sort(), ['10.0.0.1:80', '10.0.0.2:80']);
  });

  test('reporting on an unknown proxy is a no-op', () => {
    assert.doesNotThrow(() => new Pool().report('nope:1', false));
  });

  test('stats summarise the pool', () => {
    const pool = new Pool();
    pool.add(...proxy(1, 100, { anonymity: 'elite', https: true }));
    pool.add(...proxy(2, 100, { anonymity: 'anonymous', https: false }));
    pool.rebuild();
    assert.deepEqual(pool.stats(), {
      active: 2, cooldown: 0, httpsCapable: 1, anonymity: { elite: 1, anonymous: 1 }, blocklisted: 0,
    });
  });
});

describe('persistence', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-')), 'state.json');

  test('save then load restores proxies, states and the blocklist', () => {
    const file = tmp();
    const a = poolOf(100, 200);
    a.markDead('9.9.9.9:80');
    for (let i = 0; i < cfg.MAX_FAILS; i++) a.report('10.0.0.2:80', false);
    a.save(file, { lastRefresh: 1234 });

    const b = new Pool();
    const data = b.load(file);
    assert.equal(data.lastRefresh, 1234);
    assert.equal(b.map.size, 2);
    assert.equal(b.map.get('10.0.0.2:80').state, 'cooldown');
    assert.equal(b.has('9.9.9.9:80'), true);
    assert.equal(b.activeCount(), 1);
  });

  test('a missing or corrupt file is a clean cold start, not a crash', () => {
    const file = tmp();
    assert.equal(new Pool().load(file), null);
    fs.writeFileSync(file, '{oops');
    assert.equal(new Pool().load(file), null);
  });

  test('a saved pool older than STATE_MAX_AGE_MS is ignored', () => {
    const file = tmp();
    fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now() - cfg.STATE_MAX_AGE_MS - 1000, proxies: [], dead: [] }));
    assert.equal(new Pool().load(file), null);
  });

  test('expired blocklist entries are not restored', () => {
    const file = tmp();
    fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), proxies: [], dead: [['1.1.1.1:80', Date.now() - 5]] }));
    const pool = new Pool();
    pool.load(file);
    assert.equal(pool.has('1.1.1.1:80'), false);
  });

  test('saving leaves no temp file behind', () => {
    const file = tmp();
    poolOf(100).save(file);
    assert.equal(fs.existsSync(file + '.tmp'), false);
    assert.equal(fs.existsSync(file), true);
  });
});
