const path = require('path');

module.exports = {
  PORT: Number(process.env.PORT) || 8080,

  // got these list of proxies
  SOURCES: [
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  ],


  ECHO_URL: 'http://httpbin.org/get',
  IP_URL: 'http://httpbin.org/ip',
  CONNECT_TARGET: 'httpbin.org:443',

  ALLOWED_ANON: ['anonymous', 'elite'],

  TCP_TIMEOUT: 3000,
  HTTP_TIMEOUT: 8000,
  TCP_CONCURRENCY: 300,
  HTTP_CONCURRENCY: 100,

  MIN_ACTIVE: 30,
  REFRESH_MS: 10 * 60_000,
  REVALIDATE_MS: 3 * 60_000,
  COOLDOWN_MS: 2 * 60_000,
  DEAD_TTL_MS: 30 * 60_000,
  MAX_FAILS: 3,
  TICK_MS: 30_000,

  TOP_N: 20,
  MAX_RETRIES: 3,
  REQUEST_TIMEOUT: 15_000,
  STATE_FILE: process.env.STATE_FILE || path.join(__dirname, '..', 'pool-state.json'),
  SAVE_MS: 60_000,
  STATE_MAX_AGE_MS: 6 * 60 * 60_000,
};
