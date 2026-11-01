import assert from 'node:assert/strict';
import test from 'node:test';
import { NavigationTracker } from '../src/navigation.ts';

test('only the latest navigation in the current view may finish', () => {
  const tracker = new NavigationTracker();
  tracker.reset(1);
  const event = (id, phase, session = 1) => ({ id, phase, session });
  assert.equal(tracker.accept(event('1', 'started')), true);
  assert.equal(tracker.accept(event('2', 'started')), true);
  assert.equal(tracker.accept(event('1', 'started')), false);
  assert.equal(tracker.accept(event('1', 'finished')), false);
  assert.equal(tracker.accept(event('2', 'finished')), true);
  tracker.cancel();
  assert.equal(tracker.accept(event('2', 'failed')), false);
  assert.equal(tracker.accept(event('2', 'started')), false);
  assert.equal(tracker.accept(event('3', 'started')), true);
  tracker.reset(2);
  assert.equal(tracker.accept(event('3', 'finished')), false);
  assert.equal(tracker.accept(event('1', 'started', 2)), true);
});
