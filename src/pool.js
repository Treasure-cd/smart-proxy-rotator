const cfg = require('./config');
const fs = require('fs');

class Pool {
  constructor() {
    this.map = new Map();
    this.dead = new Map();
    this.snapshot = [];
  }

  has(key) {
    if (this.map.has(key)) return true;
    const until = this.dead.get(key);
    if (until && until > Date.now()) return true;
    if (until) this.dead.delete(key);
    return false;
  }

  markDead(key) {
    this.map.delete(key);
    this.dead.set(key, Date.now() + cfg.DEAD_TTL_MS);
  }

  add({ key, host, port }, { latency, anonymity, https }) {
    this.map.set(key, {
      key, host, port, state: 'active', latency, anonymity, https,
      ok: 1, fail: 0, consecFail: 0,
      lastChecked: Date.now(), lastUsed: 0, cooldownUntil: 0, score: 0,
    });
  }

  save(file, extra = {}) {
    const data = {
      savedAt: Date.now(),
      ...extra,
      proxies: [...this.map.values()],
      dead: [...this.dead.entries()].filter(([, until]) => until > Date.now()),
    };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file); // a crash mid-write never leaves a corrupt file
  }

  load(file) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    const now = Date.now();
    if (!data.savedAt || now - data.savedAt > cfg.STATE_MAX_AGE_MS) return null;
    for (const r of data.proxies || []) this.map.set(r.key, r);
    for (const [k, until] of data.dead || []) if (until > now) this.dead.set(k, until);
    this.rebuild();
    return data;
  }

  report(key, ok, latency) {
    const r = this.map.get(key);
    if (!r) return;
    r.lastChecked = Date.now();
    if (ok) {
      r.ok++;
      r.consecFail = 0;
      r.state = 'active';
      if (latency != null) r.latency = r.latency == null ? latency : 0.7 * r.latency + 0.3 * latency; // EWMA
      return;
    }
    r.fail++;
    r.consecFail++;
    if (r.state === 'cooldown') return this.markDead(key);
    if (r.consecFail >= cfg.MAX_FAILS) {
      r.state = 'cooldown';
      r.cooldownUntil = Date.now() + cfg.COOLDOWN_MS;
      r.consecFail = 0;
    }
  }

  scoreOf(r, now) {
    const successRate = (r.ok + 1) / (r.ok + r.fail + 2);
    const latencyFactor = 1 / (1 + (r.latency ?? 5000) / 1000);
    const freshness = Math.max(0.3, 1 - (now - r.lastChecked) / (30 * 60_000));
    return successRate * latencyFactor * freshness;
  }

  rebuild() {
    const now = Date.now();
    const active = [];
    for (const r of this.map.values()) {
      if (r.state !== 'active') continue;
      r.score = this.scoreOf(r, now);
      active.push(r);
    }
    this.snapshot = active.sort((a, b) => b.score - a.score);
  }

  pick({ https = false, exclude = new Set() } = {}) {
    const candidates = this.snapshot
      .filter((r) => r.state === 'active' && !exclude.has(r.key) && (!https || r.https))
      .slice(0, cfg.TOP_N);
    if (!candidates.length) return null;
    const total = candidates.reduce((s, r) => s + r.score, 0);
    let x = Math.random() * total;
    let chosen = candidates[candidates.length - 1];
    for (const r of candidates) { x -= r.score; if (x <= 0) { chosen = r; break; } }
    chosen.lastUsed = Date.now();
    return chosen;
  }

  due() {
    const now = Date.now();
    return [...this.map.values()].filter((r) =>
      r.state === 'cooldown' ? now >= r.cooldownUntil : now - r.lastChecked > cfg.REVALIDATE_MS);
  }

  activeCount() { return this.snapshot.length; }

  stats() {
    const by = { active: 0, cooldown: 0 };
    const anon = {};
    let https = 0;
    for (const r of this.map.values()) {
      by[r.state]++;
      if (r.state === 'active') { anon[r.anonymity] = (anon[r.anonymity] || 0) + 1; if (r.https) https++; }
    }
    return { ...by, httpsCapable: https, anonymity: anon, blocklisted: this.dead.size };
  }

  top(n = 50) {
    return this.snapshot.slice(0, n).map((r) => ({
      proxy: r.key, score: +r.score.toFixed(3), latencyMs: Math.round(r.latency),
      anonymity: r.anonymity, https: r.https, ok: r.ok, fail: r.fail,
    }));
  }
}

module.exports = Pool;
