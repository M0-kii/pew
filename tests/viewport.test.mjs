import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_VIEWPORT, savedViewport, validateViewport } from '../src/viewport.ts';

test('custom viewport validation bounds dimensions and pixel density', () => {
  assert.deepEqual(validateViewport(768, 1024, 2), { width: 768, height: 1024, pixelRatio: 2 });
  for (const args of [
    [0, 852, 3],
    [393.5, 852, 3],
    [393, 1921, 3],
    [393, 852, 4],
    [NaN, 852, 3],
  ]) {
    assert.throws(() => validateViewport(...args));
  }
});

test('saved viewport settings restore safely and recover from invalid storage', () => {
  const value = { width: 1024, height: 768, pixelRatio: 2 };
  assert.deepEqual(savedViewport({ getItem: () => JSON.stringify(value) }), value);
  for (const raw of [null, 'broken', 'null', '[]', '{"width":-1,"height":852,"pixelRatio":3}']) {
    assert.deepEqual(savedViewport({ getItem: () => raw }), DEFAULT_VIEWPORT);
  }
  assert.deepEqual(
    savedViewport({
      getItem() {
        throw Error('Storage unavailable');
      },
    }),
    DEFAULT_VIEWPORT,
  );
});
