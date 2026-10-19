const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseList } = require('../src/sources');

test('parses ip:port lines and ignores junk', () => {
  const out = [...parseList('1.2.3.4:8080\nnot a proxy\n\n  5.6.7.8:3128  \n').values()];
  assert.deepEqual(out.map((p) => p.key), ['1.2.3.4:8080', '5.6.7.8:3128']);
  assert.deepEqual(out[0], { key: '1.2.3.4:8080', host: '1.2.3.4', port: 8080 });
});

test('accepts a protocol prefix and trailing columns', () => {
  const keys = [...parseList('http://9.9.9.9:80\n8.8.8.8:3128 US elite\n').keys()];
  assert.deepEqual(keys, ['9.9.9.9:80', '8.8.8.8:3128']);
});

test('handles Windows line endings', () => {
  assert.equal(parseList('1.1.1.1:80\r\n2.2.2.2:81\r\n').size, 2);
});

test('rejects out-of-range ports', () => {
  assert.equal(parseList('1.1.1.1:0\n1.1.1.1:65536\n1.1.1.1:99999\n').size, 0);
  assert.equal(parseList('1.1.1.1:65535\n').size, 1);
});

test('dedupes within a list and across lists sharing one Map', () => {
  const seen = parseList('1.1.1.1:80\n1.1.1.1:80\n');
  assert.equal(seen.size, 1);
  parseList('1.1.1.1:80\n2.2.2.2:80\n', seen);
  assert.equal(seen.size, 2);
});

test('treats the same host on different ports as different proxies', () => {
  assert.equal(parseList('1.1.1.1:80\n1.1.1.1:8080\n').size, 2);
});

test('empty input yields nothing', () => {
  assert.equal(parseList('').size, 0);
});
