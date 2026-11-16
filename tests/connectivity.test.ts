import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alertCheckIsRecent,
  alertToggleDisabled,
  networkPolicy,
  readConnectionMode,
  sourceClock,
  startClock,
  unexpiredAlerts,
} from '../src/connectivity';

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
test('warning expiry is judged on the clock of the source that answered the check', () => {
  const now = 1_800_000_000_000;
  const warning = (id: string, expires: number) => ({
    id,
    title: id,
    event: 'Flood',
    severity: 'Severe',
    area: 'Fixture district',
    sent: now - 3_600_000,
    effective: now - 3_600_000,
    expires,
    description: '',
    instruction: '',
    source: 'Fixture authority',
    url: 'https://severeweather.wmo.int/',
    geometry: null,
  });
  const alerts = [warning('five-minutes-left', now + 300_000), warning('ended', now - 1)];
  const ids = (clockOffset: number | undefined, device: number) =>
    unexpiredAlerts({ alerts, clockOffset }, device).map((alert) => alert.id);
  // Clocks agree, or the source states no clock: the device clock decides.
  for (const offset of [undefined, 0, NaN, Infinity]) {
    assert.deepEqual(ids(offset, now), ['five-minutes-left']);
    assert.deepEqual(ids(offset, now + 300_000), []);
    assert.equal(sourceClock(now, offset), now);
  }
  // A device ten minutes fast reads `now + 10 min` at the same moment: the warning is still valid.
  assert.equal(sourceClock(now + 600_000, 600_000), now);
  assert.deepEqual(ids(600_000, now + 600_000), ['five-minutes-left']);
  assert.deepEqual(ids(600_000, now + 600_000 + 300_000), []);
  // A device ten minutes slow does not keep a warning that ended on the source's clock.
  assert.deepEqual(ids(-600_000, now - 600_000), ['five-minutes-left']);
  assert.deepEqual(ids(-600_000, now - 600_000 + 300_000), []);
  assert.deepEqual(unexpiredAlerts(null, now), []);
  assert.deepEqual(unexpiredAlerts(undefined, now), []);
});
test('page alerts switch on only for a complete polled point feed, and switch off at any place', () => {
  const point = { status: 'available', scope: 'point' } as const;
  // A complete NWS point answer while Full workspace polls it.
  assert.equal(alertToggleDisabled(false, point, true), false);
  assert.equal(alertToggleDisabled(false, { ...point, partial: false }, true), false);
  // Alerts stay on when another place is chosen. Its check may be anything below.
  const otherPlaces = [
    null, // still loading, or it failed
    undefined,
    { ...point, partial: true }, // WMO SWIC, or an NWS answer with pages not loaded
    { status: 'available', scope: 'region', partial: true }, // NDMA SACHET state bulletins
    { status: 'available', scope: 'country' },
    { status: 'available' }, // no scope stated
    { status: 'unsupported', scope: 'point', partial: true },
  ] as const;
  for (const check of otherPlaces) {
    assert.equal(alertToggleDisabled(false, check, true), true, 'alerts cannot be switched on');
    assert.equal(alertToggleDisabled(true, check, true), false, '"Disable alerts" must work');
  }
  // Data saver does not poll: alerts cannot be switched on, but alerts that are on can be stopped.
  assert.equal(alertToggleDisabled(false, point, false), true);
  assert.equal(alertToggleDisabled(true, point, false), false);
  assert.equal(alertToggleDisabled(true, point, true), false);
});
test('a check completed after a connection-mode change is judged against the current time', (t) => {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: start });
  let now = 0,
    polls = 0;
  // The dashboard clock restarts on every connection-mode change.
  const restart = () =>
    startClock(
      (time) => (now = time),
      () => polls++,
    );
  let stop = restart(); // Data saver
  assert.equal(now, start);
  t.mock.timers.tick(10_000);
  stop();
  stop = restart(); // Offline only
  t.mock.timers.tick(5 * 60_000 + 58_000); // the last tick was 58 seconds ago
  assert.equal(polls, 5);
  stop();
  stop = restart(); // Data saver again: the clock reads the switch time at once
  assert.equal(now, Date.now());
  assert.equal(polls, 5);
  t.mock.timers.tick(3_000);
  const fetchedAt = Date.now(); // the warning check completes 3 seconds later
  assert.equal(alertCheckIsRecent(fetchedAt, now, true), true);
  t.mock.timers.tick(57_000);
  assert.equal(now, fetchedAt + 57_000);
  assert.equal(polls, 6);
  stop();
  t.mock.timers.tick(120_000);
  assert.equal(polls, 6);
});
