const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const cfg = require('../src/config');
const { classify, tcpCheck, httpCheck, connectCheck, validate, mapLimit } = require('../src/validator');
const h = require('./helpers');

const REAL_IP = '198.51.100.7';

describe('classify (anonymity detection)', () => {
  test('transparent when the real IP is in the origin', () => {
    assert.equal(classify({ origin: REAL_IP, headers: {} }, REAL_IP), 'transparent');
  });

  test('transparent when the real IP is one of several origins', () => {
    assert.equal(classify({ origin: `203.0.113.9, ${REAL_IP}`, headers: {} }, REAL_IP), 'transparent');
  });

  test('transparent when the real IP leaks through a header', () => {
    const echo = { origin: '203.0.113.9', headers: { 'X-Forwarded-For': REAL_IP } };
    assert.equal(classify(echo, REAL_IP), 'transparent');
  });

  test('anonymous when IP is hidden but proxy headers reveal a proxy', () => {
    assert.equal(classify({ origin: '203.0.113.9', headers: { Via: '1.1 squid' } }, REAL_IP), 'anonymous');
  });

  test('header names are matched case-insensitively', () => {
    assert.equal(classify({ origin: '203.0.113.9', headers: { VIA: 'x' } }, REAL_IP), 'anonymous');
  });

  test('elite when nothing gives the proxy away', () => {
    assert.equal(classify({ origin: '203.0.113.9', headers: { Host: 'echo', 'User-Agent': 'x' } }, REAL_IP), 'elite');
  });
});

describe('network checks against local mock servers', () => {
  let echoSrv, tcpEcho, good, bad;
  const saved = {};

  before(async () => {
    echoSrv = await h.startTarget((req, res) => {
      res.setHeader('content-type', 'application/json');
      const base = { origin: '203.0.113.9', headers: { Host: 'echo' } };
      if (req.url === '/anon') return res.end(JSON.stringify({ ...base, headers: { ...base.headers, Via: '1.1 x' } }));
      if (req.url === '/leak') return res.end(JSON.stringify({ ...base, origin: `203.0.113.9, ${REAL_IP}` }));
      if (req.url === '/500') { res.statusCode = 500; return res.end('{}'); }
      if (req.url === '/garbage') return res.end('<html>not json</html>');
      res.end(JSON.stringify(base));
    });
    tcpEcho = await h.startTcpEcho();
    good = await h.startMockProxy();
    bad = await h.startMockProxy({ broken: true });
    for (const k of ['ECHO_URL', 'CONNECT_TARGET']) saved[k] = cfg[k];
    cfg.CONNECT_TARGET = `127.0.0.1:${tcpEcho.port}`;
  });

  after(async () => {
    Object.assign(cfg, saved);
    for (const s of [echoSrv, tcpEcho, good, bad]) await h.stop(s.server);
  });

  const echoAt = (p) => { cfg.ECHO_URL = `http://127.0.0.1:${echoSrv.port}${p}`; };
  const goodP = () => ({ host: '127.0.0.1', port: good.port });
  const badP = () => ({ host: '127.0.0.1', port: bad.port });

  async function closedPort() {
    const s = net.createServer();
    await h.listen(s);
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
  }

  test('tcpCheck returns latency for an open port and null for a closed one', async () => {
    assert.equal(typeof (await tcpCheck('127.0.0.1', tcpEcho.port)), 'number');
    assert.equal(await tcpCheck('127.0.0.1', await closedPort(), 500), null);
  });

  test('httpCheck measures latency and classifies elite', async () => {
    echoAt('/');
    const res = await httpCheck(goodP(), REAL_IP);
    assert.equal(res.anonymity, 'elite');
    assert.ok(res.latency >= 0);
  });

  test('httpCheck classifies anonymous and transparent', async () => {
    echoAt('/anon');
    assert.equal((await httpCheck(goodP(), REAL_IP)).anonymity, 'anonymous');
    echoAt('/leak');
    assert.equal((await httpCheck(goodP(), REAL_IP)).anonymity, 'transparent');
  });

  test('httpCheck returns null for bad statuses, non-JSON, dead and unreachable proxies', async () => {
    echoAt('/500');
    assert.equal(await httpCheck(goodP(), REAL_IP), null);
    echoAt('/garbage');
    assert.equal(await httpCheck(goodP(), REAL_IP), null);
    echoAt('/');
    assert.equal(await httpCheck(badP(), REAL_IP), null);
    assert.equal(await httpCheck({ host: '127.0.0.1', port: await closedPort() }, REAL_IP, 500), null);
  });

  test('connectCheck is true for a proxy that tunnels and false otherwise', async () => {
    assert.equal(await connectCheck(goodP()), true);
    assert.equal(await connectCheck(badP()), false);
    assert.equal(await connectCheck({ host: '127.0.0.1', port: await closedPort() }, 500), false);
  });

  test('validate accepts good proxies and rejects transparent or dead ones', async () => {
    echoAt('/');
    const ok = await validate(goodP(), REAL_IP);
    assert.equal(ok.anonymity, 'elite');
    assert.equal(ok.https, true);
    echoAt('/leak');
    assert.equal(await validate(goodP(), REAL_IP), null);
    echoAt('/');
    assert.equal(await validate(badP(), REAL_IP), null);
  });
});

describe('mapLimit', () => {
  test('never exceeds the concurrency limit but does run in parallel', async () => {
    let running = 0, max = 0;
    await mapLimit(Array.from({ length: 30 }, (_, i) => i), 5, async () => {
      running++;
      max = Math.max(max, running);
      await h.sleep(5);
      running--;
    });
    assert.ok(max <= 5, `max was ${max}`);
    assert.ok(max > 1, 'expected real concurrency');
  });

  test('processes every item even when some throw', async () => {
    const done = [];
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      if (n % 2 === 0) throw new Error('boom');
      done.push(n);
    });
    assert.deepEqual(done.sort(), [1, 3, 5]);
  });

  test('handles an empty list', async () => {
    await mapLimit([], 10, async () => { throw new Error('should not run'); });
  });
});
