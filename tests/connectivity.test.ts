import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertCheckIsRecent, networkPolicy, readConnectionMode } from '../src/connectivity';

test('first visit and invalid preferences default to data saver', () => {
  for (const value of [null, '', 'invalid', 'lite'])
    assert.equal(readConnectionMode(value), 'lite');
  assert.equal(readConnectionMode('offline'), 'offline');
  assert.equal(readConnectionMode('full'), 'full');
});
test('offline mode and lost connections disable every provider request and poll', () => {
  assert.deepEqual(networkPolicy('offline', true), {
    essentials: false,
    extras: false,
    polling: false,
  });
  for (const mode of ['lite', 'full', 'offline'] as const)
    assert.deepEqual(networkPolicy(mode, false), {
      essentials: false,
      extras: false,
      polling: false,
    });
});
test('data saver allows essential checks without heavy feeds or automatic polling', () => {
  assert.deepEqual(networkPolicy('lite', true), {
    essentials: true,
    extras: false,
    polling: false,
  });
  assert.deepEqual(networkPolicy('full', true), { essentials: true, extras: true, polling: true });
});
test('a warning check cannot be called current offline, after two minutes or with an invalid clock', () => {
  const now = 1_800_000_000_000;
  assert.equal(alertCheckIsRecent(now, now, true), true);
  assert.equal(alertCheckIsRecent(now - 120_000, now, true), true);
  for (const fetched of [undefined, NaN, Infinity, now - 120_001, now + 60_001])
    assert.equal(alertCheckIsRecent(fetched, now, true), false);
  assert.equal(alertCheckIsRecent(now, now, false), false);
});
