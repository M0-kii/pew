import assert from 'node:assert/strict';
import test from 'node:test';
import { formatUrl } from '../src/url.ts';

test('public sites default to HTTPS and preserve paths, queries, and fragments', () => {
  assert.equal(
    formatUrl('  example.com/path?q=1#section  '),
    'https://example.com/path?q=1#section',
  );
  assert.equal(formatUrl('example.com:8080'), 'https://example.com:8080/');
  assert.equal(formatUrl('example.com:80'), 'https://example.com:80/');
  assert.equal(formatUrl('https://example.com'), 'https://example.com/');
  assert.equal(formatUrl('http://example.com/path'), 'http://example.com/path');
});

test('local development addresses default to HTTP', () => {
  for (const host of [
    'localhost:3000',
    'app.localhost:5173',
    '127.0.0.1:1420',
    '127.0.0.2',
    '[::1]:3000',
    '192.168.1.20:8080',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.1',
  ]) {
    assert.equal(formatUrl(`${host}/app?q=1`), `http://${host}/app?q=1`);
  }
  assert.equal(formatUrl('localhost?test=1'), 'http://localhost/?test=1');
  assert.equal(formatUrl('https://localhost:3000'), 'https://localhost:3000/');
  assert.equal(formatUrl('localhost:443'), 'http://localhost:443/');
  assert.equal(formatUrl('LOCALHOST:3000'), 'http://localhost:3000/');
  assert.equal(formatUrl('127.1:3000'), 'http://127.0.0.1:3000/');
});

test('local-looking public hosts still default to HTTPS', () => {
  for (const host of ['localhost.example.com', '172.15.0.1', '172.32.0.1', '192.169.1.2']) {
    assert.equal(formatUrl(host), `https://${host}/`);
  }
});

test('empty, malformed, and unsupported URLs are rejected', () => {
  for (const value of ['', '   ', 'https://', 'a bad host', 'localhost:99999', 'http://[broken']) {
    assert.throws(() => formatUrl(value));
  }
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///C:/test.html',
    'mailto:test@example.com',
    'ftp://example.com',
    'about:blank',
  ]) {
    assert.throws(() => formatUrl(value), /HTTP or HTTPS/);
  }
});
