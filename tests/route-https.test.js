process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cfg = require('../src/config');
const h = require('./helpers');

function makeCert() {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cert-'));
    const key = path.join(dir, 'k.pem');
    const crt = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt,
      '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  } catch { return null; }
}

const creds = makeCert();
const skip = !creds && 'openssl not available';

async function startTlsTarget() {
  const server = h.track(https.createServer(creds, (req, res) => {
    res.end(`secure ${req.url} host=${req.headers.host}`);
  }));
  return { server, port: await h.listen(server) };
}

test('/route forwards an https target through a CONNECT tunnel', { skip }, async () => {
  const t = await startTlsTarget();
  const rig = await h.startRig([{}]);
  try {
    const res = await h.request({ port: rig.port, path: `/route?url=${encodeURIComponent(`https://localhost:${t.port}/b?x=1`)}` });
    assert.equal(res.status, 200);
    assert.equal(res.body, `secure /b?x=1 host=localhost:${t.port}`);
    assert.equal(res.headers['x-proxy-used'], rig.proxies[0].key);
  } finally { await rig.close(); await h.stop(t.server); }
});

test('/route https fails over past a dead proxy', { skip }, async () => {
  await h.withCfg(cfg, { TOP_N: 1 }, async () => {
    const t = await startTlsTarget();
    const rig = await h.startRig([{ broken: true, latency: 10 }, { latency: 500 }]);
    try {
      const res = await h.request({ port: rig.port, path: `/route?url=https://localhost:${t.port}/ok` });
      assert.equal(res.status, 200);
      assert.equal(rig.record(0).fail, 1);
      assert.equal(res.headers['x-proxy-used'], rig.proxies[1].key);
    } finally { await rig.close(); await h.stop(t.server); }
  });
});

test('/route https returns 503 when no HTTPS-capable proxy exists', { skip }, async () => {
  const rig = await h.startRig([{ https: false }]);
  try {
    const res = await h.request({ port: rig.port, path: '/route?url=https://localhost:1/x' });
    assert.equal(res.status, 503);
  } finally { await rig.close(); }
});
