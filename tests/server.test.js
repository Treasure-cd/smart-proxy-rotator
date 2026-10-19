const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../src/config');
const h = require('./helpers');

let target, echo;
const seen = [];

before(async () => {
  target = await h.startTarget((req, res) => {
    seen.push({ url: req.url, host: req.headers.host });
    if (req.url.startsWith('/forbidden')) { res.writeHead(403); return res.end('nope'); }
    res.end('target ' + req.url);
  });
  echo = await h.startTcpEcho();
});

after(async () => {
  await h.stop(target.server);
  await h.stop(echo.server);
});

const T = (p) => `http://127.0.0.1:${target.port}${p}`;

describe('acting as a standard HTTP proxy', () => {
  test('forwards a request through a pool proxy and names it in x-proxy-used', async () => {
    const rig = await h.startRig([{}]);
    try {
      const res = await h.viaProxy(rig.port, T('/hello'));
      assert.equal(res.status, 200);
      assert.equal(res.body, 'target /hello');
      assert.equal(res.headers['x-proxy-used'], rig.proxies[0].key);
      assert.equal(rig.proxies[0].server.hits, 1);
    } finally { await rig.close(); }
  });

  test('fails over to the next proxy so the client never sees a dead one', async () => {
    await h.withCfg(cfg, { TOP_N: 1 }, async () => {
      const rig = await h.startRig([{ broken: true, latency: 10 }, { latency: 500 }]);
      try {
        for (let i = 0; i < 5; i++) {
          const res = await h.viaProxy(rig.port, T('/n' + i));
          assert.equal(res.status, 200);
          assert.equal(res.headers['x-proxy-used'], rig.proxies[1].key);
        }
        assert.equal(rig.record(0).state, 'cooldown');
        assert.equal(rig.record(0).fail, 3);
        assert.equal(rig.proxies[0].server.hits, 3);  // never touched again after cooldown
        assert.ok(rig.record(1).ok >= 6);
      } finally { await rig.close(); }
    });
  });

  test('returns 503 when the pool is empty', async () => {
    const rig = await h.startRig([]);
    try {
      const res = await h.viaProxy(rig.port, T('/x'));
      assert.equal(res.status, 503);
      assert.match(res.body, /No working proxies/);
    } finally { await rig.close(); }
  });

  test('returns 502 when every proxy fails', async () => {
    const rig = await h.startRig([{ broken: true }, { broken: true }]);
    try {
      const res = await h.viaProxy(rig.port, T('/x'));
      assert.ok([502, 503].includes(res.status));
    } finally { await rig.close(); }
  });

  test('a 403 from the target is passed through and does not penalise the proxy', async () => {
    const rig = await h.startRig([{}]);
    try {
      const res = await h.viaProxy(rig.port, T('/forbidden'));
      assert.equal(res.status, 403);
      assert.equal(rig.record(0).fail, 0);
    } finally { await rig.close(); }
  });

  test('forwards request bodies', async () => {
    const t = await h.startTarget((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => res.end(`${req.method}:${b}`));
    });
    const rig = await h.startRig([{}]);
    try {
      const res = await h.request(
        { port: rig.port, method: 'POST', path: `http://127.0.0.1:${t.port}/p`, headers: { host: `127.0.0.1:${t.port}` } },
        'hello=world'
      );
      assert.equal(res.body, 'POST:hello=world');
    } finally { await rig.close(); await h.stop(t.server); }
  });
});

describe('CONNECT tunnelling (HTTPS through the rotator)', () => {
  test('opens a tunnel and relays bytes both ways', async () => {
    const rig = await h.startRig([{}]);
    try {
      const { status, socket } = await h.connectVia(rig.port, `127.0.0.1:${echo.port}`);
      assert.equal(status, 200);
      const reply = await new Promise((resolve) => { socket.once('data', (d) => resolve(d.toString())); socket.write('ping'); });
      assert.equal(reply, 'ECHO:ping');
      socket.destroy();
    } finally { await rig.close(); }
  });

  test('skips a dead proxy and tunnels through a working one', async () => {
    await h.withCfg(cfg, { TOP_N: 1 }, async () => {
      const rig = await h.startRig([{ broken: true, latency: 10 }, { latency: 500 }]);
      try {
        const { status, socket } = await h.connectVia(rig.port, `127.0.0.1:${echo.port}`);
        assert.equal(status, 200);
        socket.destroy();
        assert.equal(rig.record(0).fail, 1);
      } finally { await rig.close(); }
    });
  });

  test('only uses proxies that passed the HTTPS check', async () => {
    const rig = await h.startRig([{ https: false }]);
    try {
      const { status } = await h.connectVia(rig.port, `127.0.0.1:${echo.port}`);
      assert.equal(status, 503);
    } finally { await rig.close(); }
  });
});

describe('/route endpoint (http targets)', () => {
  test('forwards an encoded target URL', async () => {
    const rig = await h.startRig([{}]);
    try {
      const res = await h.request({ port: rig.port, path: `/route?url=${encodeURIComponent(T('/a?x=1&y=2'))}` });
      assert.equal(res.status, 200);
      assert.equal(res.body, 'target /a?x=1&y=2');
      assert.equal(res.headers['x-proxy-used'], rig.proxies[0].key);
    } finally { await rig.close(); }
  });

  test('keeps the target query string when the URL is passed unencoded', async () => {
    const rig = await h.startRig([{}]);
    try {
      const res = await h.request({ port: rig.port, path: `/route?url=${T('/search?q=shoes&page=2')}` });
      assert.equal(res.body, 'target /search?q=shoes&page=2');
    } finally { await rig.close(); }
  });

  test('does not decode percent-escapes inside an unencoded target', async () => {
    const rig = await h.startRig([{}]);
    try {
      const res = await h.request({ port: rig.port, path: `/route?url=${T('/a?q=a%26b')}` });
      assert.equal(res.body, 'target /a?q=a%26b');
    } finally { await rig.close(); }
  });

  test('sets the Host header to the target, not the rotator', async () => {
    const rig = await h.startRig([{}]);
    try {
      seen.length = 0;
      await h.request({ port: rig.port, path: `/route?url=${encodeURIComponent(T('/host'))}` });
      assert.equal(seen.at(-1).host, `127.0.0.1:${target.port}`);
    } finally { await rig.close(); }
  });

  test('rejects a missing, malformed or non-http(s) url with 400', async () => {
    const rig = await h.startRig([{}]);
    try {
      for (const p of ['/route', '/route?url=', '/route?url=notaurl', '/route?url=ftp://example.com/x']) {
        const res = await h.request({ port: rig.port, path: p });
        assert.equal(res.status, 400, p);
      }
    } finally { await rig.close(); }
  });

  test('retries on another proxy transparently', async () => {
    await h.withCfg(cfg, { TOP_N: 1 }, async () => {
      const rig = await h.startRig([{ broken: true, latency: 10 }, { latency: 500 }]);
      try {
        const res = await h.request({ port: rig.port, path: `/route?url=${encodeURIComponent(T('/r'))}` });
        assert.equal(res.status, 200);
        assert.equal(rig.record(0).fail, 1);
      } finally { await rig.close(); }
    });
  });
});

describe('admin endpoints', () => {
  test('/__stats and /__pool describe the pool; unknown paths 404', async () => {
    const rig = await h.startRig([{}, { https: false }]);
    try {
      const stats = JSON.parse((await h.request({ port: rig.port, path: '/__stats' })).body);
      assert.equal(stats.active, 2);
      assert.equal(stats.httpsCapable, 1);
      const pool = JSON.parse((await h.request({ port: rig.port, path: '/__pool' })).body);
      assert.equal(pool.length, 2);
      assert.ok('score' in pool[0] && 'latencyMs' in pool[0]);
      assert.equal((await h.request({ port: rig.port, path: '/nothing' })).status, 404);
    } finally { await rig.close(); }
  });
});
