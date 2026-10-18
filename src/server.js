const http = require('http');
const net = require('net');
const cfg = require('./config');
const tls = require('tls');
const https = require('https');


const HOP = ['proxy-connection', 'proxy-authorization'];

function createServer(pool) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/route')) return route(pool, req, res);
    if (req.url.startsWith('/')) return admin(pool, req, res);
    forwardHttp(pool, req, res);
  });
  server.on('connect', (req, clientSocket, head) => tunnel(pool, req, clientSocket, head));
  server.on('clientError', (_e, socket) => socket.destroy());
  return server;
}

function admin(pool, req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/__stats') return res.end(JSON.stringify(pool.stats(), null, 2));
  if (req.url === '/__pool') return res.end(JSON.stringify(pool.top(), null, 2));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'try /__stats or /__pool' }));
}

function forwardHttp(pool, req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => attempt(Buffer.concat(chunks), new Set(), 0));

  function attempt(body, tried, n) {
    const proxy = pool.pick({ exclude: tried });
    if (!proxy) return bail(res, 503, 'No working proxies available');
    tried.add(proxy.key);

    const headers = { ...req.headers };
    HOP.forEach((h) => delete headers[h]);
    const start = Date.now();
    let retried = false;
    const retry = () => {
      if (retried) return;
      retried = true;
      pool.report(proxy.key, false);
      if (n + 1 >= cfg.MAX_RETRIES) return bail(res, 502, 'All proxy attempts failed');
      attempt(body, tried, n + 1);
    };

    const up = http.request(
      { host: proxy.host, port: proxy.port, method: req.method, path: req.url, headers, timeout: cfg.REQUEST_TIMEOUT },
      (upRes) => {
        if (upRes.statusCode === 407 || upRes.statusCode === 502) { upRes.resume(); return retry(); }
        pool.report(proxy.key, true, Date.now() - start);
        res.writeHead(upRes.statusCode, { ...upRes.headers, 'x-proxy-used': proxy.key });
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      }
    );
    up.on('timeout', () => up.destroy());
    up.on('error', () => { if (!res.headersSent) retry(); else res.destroy(); });
    up.end(body);
  }
}


function tunnel(pool, req, clientSocket, head) {
  const tried = new Set();
  let attempts = 0;
  clientSocket.on('error', () => {});

  const next = () => {
    if (attempts++ >= cfg.MAX_RETRIES) return clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    const proxy = pool.pick({ https: true, exclude: tried });
    if (!proxy) return clientSocket.end('HTTP/1.1 503 No working proxies available\r\n\r\n');
    tried.add(proxy.key);

    const start = Date.now();
    const s = net.connect({ host: proxy.host, port: proxy.port });
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      s.destroy();
      pool.report(proxy.key, false);
      next();
    };

    s.setTimeout(cfg.REQUEST_TIMEOUT, fail);
    s.once('error', fail);
    s.once('close', fail);
    s.once('connect', () => s.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`));

    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      s.off('data', onData);
      if (settled) return;
      const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) return fail();

      settled = true;
      s.setTimeout(0);
      s.on('error', () => clientSocket.destroy());
      pool.report(proxy.key, true, Date.now() - start);

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.subarray(end + 4);
      if (rest.length) clientSocket.write(rest);
      if (head && head.length) s.write(head);
      s.pipe(clientSocket);
      clientSocket.pipe(s);
      s.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => s.destroy());
    };
    s.on('data', onData);
  };
  next();
}

function route(pool, req, res) {
  let u;
  try {
    const urlIndex = req.url.indexOf('?url=');
    if (urlIndex === -1) throw new Error();

    let targetStr = req.url.slice(urlIndex + 5);
    if (!/^https?:\/\//i.test(targetStr)) {
      try { targetStr = decodeURIComponent(targetStr); } catch (e) {}
    }

    // parse the final target URL
    u = new URL(targetStr);
  }
  catch {
    return bail(res, 400, 'Usage: /route?url=https://example.com');
  }

  if (u.protocol === 'http:') {
    req.url = u.href;
    req.headers.host = u.host;
    return forwardHttp(pool, req, res);
  }
  if (u.protocol === 'https:') return forwardHttps(pool, req, res, u);
  bail(res, 400, 'Only http and https targets are supported');
}

function forwardHttps(pool, req, res, u) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => attempt(Buffer.concat(chunks), new Set(), 0));

  function attempt(body, tried, n) {
    const proxy = pool.pick({ https: true, exclude: tried });
    if (!proxy) return bail(res, 503, 'No working proxies available');
    tried.add(proxy.key);

    const start = Date.now();
    const hostPort = `${u.hostname}:${u.port || 443}`;
    let done = false;
    const retry = () => {
      if (done) return;
      done = true;
      pool.report(proxy.key, false);
      if (n + 1 >= cfg.MAX_RETRIES) return bail(res, 502, 'All proxy attempts failed');
      attempt(body, tried, n + 1);
    };

    const s = net.connect({ host: proxy.host, port: proxy.port });
    let buf = Buffer.alloc(0);
    s.setTimeout(cfg.REQUEST_TIMEOUT, () => s.destroy());
    s.on('error', retry);
    s.on('close', retry);
    s.once('connect', () => s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));

    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      s.off('data', onData);
      if (done) return;
      if (!/^HTTP\/1\.[01] 200/.test(buf.subarray(0, buf.indexOf('\r\n')).toString('latin1'))) {
        s.destroy();
        return retry();
      }
      const rest = buf.subarray(end + 4);
      if (rest.length) s.unshift(rest);

      const headers = { ...req.headers, host: u.host };
      HOP.forEach((h) => delete headers[h]);
      const up = https.request(
        {
          method: req.method, path: u.pathname + u.search, headers, timeout: cfg.REQUEST_TIMEOUT,
          createConnection: () => tls.connect({ socket: s, servername: u.hostname }),
        },
        (upRes) => {
          done = true;
          pool.report(proxy.key, true, Date.now() - start);
          res.writeHead(upRes.statusCode, { ...upRes.headers, 'x-proxy-used': proxy.key });
          upRes.pipe(res);
          upRes.on('error', () => res.destroy());
        }
      );
      up.on('timeout', () => up.destroy());
      up.on('error', () => (res.headersSent ? res.destroy() : retry()));
      up.end(body);
    };
    s.on('data', onData);
  }
}

function bail(res, code, msg) {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { 'Content-Type': 'text/plain' });
  res.end(msg + '\n');
}

module.exports = { createServer };
