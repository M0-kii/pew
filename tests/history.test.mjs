import assert from 'node:assert/strict';
import test from 'node:test';
import { HISTORY_KEY, recentUrls, rememberUrl } from '../src/history.ts';

const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

test('recent URLs are unique, ordered, bounded, and omit credentials and tokens', () => {
  const saved = storage();
  for (let i = 0; i < 7; i++) rememberUrl(saved, `http://localhost:3000/${i}`);
  assert.equal(recentUrls(saved).length, 5);
  rememberUrl(saved, 'http://localhost:3000/4?token=secret#private');
  assert.equal(recentUrls(saved)[0], 'http://localhost:3000/4');
  assert.equal(recentUrls(saved).filter((url) => url.endsWith('/4')).length, 1);
  rememberUrl(saved, 'https://name:password@example.com/');
  assert.equal(saved.getItem(HISTORY_KEY).includes('password'), false);
  assert.equal(saved.getItem(HISTORY_KEY).includes('secret'), false);
});

test('corrupt or unavailable history does not prevent previewing', () => {
  const saved = storage();
  saved.setItem(HISTORY_KEY, '{broken');
  assert.deepEqual(recentUrls(saved), []);
  saved.setItem(HISTORY_KEY, JSON.stringify(['javascript:alert(1)', 42, 'example.com']));
  assert.deepEqual(recentUrls(saved), ['https://example.com/']);
  const unavailable = {
    getItem() {
      throw Error('disabled');
    },
    setItem() {
      throw Error('disabled');
    },
  };
  assert.deepEqual(recentUrls(unavailable), []);
  assert.doesNotThrow(() => rememberUrl(unavailable, 'example.com'));
});
