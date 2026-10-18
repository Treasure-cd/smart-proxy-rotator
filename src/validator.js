const net = require('net');
const http = require('http');
const cfg = require('./config');

function tcpCheck(host, port, timeout = cfg.TCP_TIMEOUT) {
  return new Promise((resolve) => {
    const start = Date.now();
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok ? Date.now() - start : null); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function classify(echo, realIp) {
  const headers = {};
  for (const [k, v] of Object.entries(echo.headers || {})) headers[k.toLowerCase()] = String(v);
  const origin = String(echo.origin || '');
  const leaks = realIp && (origin.includes(realIp) || Object.values(headers).some((v) => v.includes(realIp)));
  if (leaks) return 'transparent';
  const tells = ['via', 'forwarded', 'x-forwarded-for', 'x-real-ip', 'proxy-connection'];
  if (tells.some((h) => h in headers)) return 'anonymous';
  return 'elite';
}


function httpCheck(proxy, realIp, timeout = cfg.HTTP_TIMEOUT) {
  return new Promise((resolve) => {
    const start = Date.now();
    const target = new URL(cfg.ECHO_URL);
    const req = http.request(
      {
        host: proxy.host, port: proxy.port, method: 'GET',
        path: cfg.ECHO_URL,
        headers: { Host: target.host, 'User-Agent': 'proxy-validator' },
        timeout,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 20_000) req.destroy(); });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const echo = JSON.parse(body);
            if (realIp && echo.origin === undefined) return resolve(null);
            resolve({ latency: Date.now() - start, anonymity: classify(echo, realIp) });
          } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.on('close', () => resolve(null));
    req.end();
  });
}

function connectCheck(proxy, timeout = cfg.HTTP_TIMEOUT) {
  return new Promise((resolve) => {
    const s = net.connect({ host: proxy.host, port: proxy.port });
    let buf = '';
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('error', () => done(false));
    s.once('connect', () =>
      s.write(`CONNECT ${cfg.CONNECT_TARGET} HTTP/1.1\r\nHost: ${cfg.CONNECT_TARGET}\r\n\r\n`));
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n')) done(/^HTTP\/1\.[01] 200/.test(buf));
    });
  });
}

async function validate(proxy, realIp) {
  const res = await httpCheck(proxy, realIp);
  if (!res || !cfg.ALLOWED_ANON.includes(res.anonymity)) return null;
  const https = await connectCheck(proxy);
  return { ...res, https };
}


async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); } catch { }
    }
  });
  await Promise.all(workers);
}

module.exports = { tcpCheck, httpCheck, connectCheck, validate, mapLimit };
