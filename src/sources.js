const cfg = require('./config');

const LINE = /^(?:\w+:\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/;

async function fetchSources() {
  const results = await Promise.allSettled(
    cfg.SOURCES.map(async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      return res.text();
    })
  );

  const seen = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      console.warn('[sources] failed:', r.reason.message);
      continue;
    }
    for (const line of r.value.split(/\r?\n/)) {
      const m = LINE.exec(line.trim());
      if (!m) continue;
      const port = Number(m[2]);
      if (port < 1 || port > 65535) continue;
      const key = `${m[1]}:${port}`;
      if (!seen.has(key)) seen.set(key, { key, host: m[1], port });
    }
  }
  return [...seen.values()];
}

module.exports = { fetchSources };
