const http = require('http');
const net = require('net');
const Pool = require('../src/pool');
const { createServer } = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function track(server) {
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.destroyAll = () => sockets.forEach((s) => s.destroy());
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function stop(server) {
  server.destroyAll?.();
  await new Promise((r) => server.close(r));
}

async function startTarget(handler = (req, res) => res.end('target ' + req.url)) {
  const server = track(http.createServer(handler));
  return { server, port: await listen(server) };
}

async function startTcpEcho() {
  const server = track(net.createServer((s) => {
    s.on('data', (d) => s.write('ECHO:' + d));
    s.on('error', () => {});
  }));
  return { server, port: await listen(server) };
}

// orwards absolute-form requests and supports connect.
// this bit, { broken: true } makes it drop every connection, like a dead free proxy.
async function startMockProxy({ broken = false } = {}) {
  const server = track(http.createServer((req, res) => {
    server.hits++;
    if (broken) return req.socket.destroy();
    const u = new URL(req.url);
    const up = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
    );
    up.on('error', () => res.destroy());
    req.pipe(up);
  }));
  server.hits = 0;
  server.on('connect', (req, clientSocket) => {
    server.hits++;
    if (broken) return clientSocket.destroy();
    const [host, port] = req.url.split(':');
    const s = net.connect(+port, host === 'localhost' ? '127.0.0.1' : host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      s.pipe(clientSocket);
      clientSocket.pipe(s);
    });
    s.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => s.destroy());
  });
  return { server, port: await listen(server) };
}


async function startRig(specs) {
  const pool = new Pool();
  const proxies = [];
  for (const spec of specs) {
    const p = await startMockProxy({ broken: spec.broken });
    p.key = `127.0.0.1:${p.port}`;
    pool.add(
      { key: p.key, host: '127.0.0.1', port: p.port },
      { latency: spec.latency ?? 100, anonymity: 'elite', https: spec.https ?? true }
    );
    proxies.push(p);
  }
  pool.rebuild();
  const rotator = track(createServer(pool));
  const port = await listen(rotator);
  return {
    pool, proxies, port,
    record: (i) => pool.map.get(proxies[i].key),
    async close() {
      await stop(rotator);
      for (const p of proxies) await stop(p.server);
    },
  };
}

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', ...opts }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Plain-HTTP request in proxy style: absolute URL sent to the rotator.
function viaProxy(rotatorPort, targetUrl) {
  const u = new URL(targetUrl);
  return request({ port: rotatorPort, path: targetUrl, headers: { host: u.host } });
}

function connectVia(rotatorPort, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: rotatorPort, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject);
    req.end();
  });
}

async function withCfg(cfg, overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = cfg[k]; cfg[k] = overrides[k]; }
  try { return await fn(); } finally { Object.assign(cfg, saved); }
}

module.exports = {
  sleep, track, listen, stop, startTarget, startTcpEcho, startMockProxy,
  startRig, request, viaProxy, connectVia, withCfg,
};
