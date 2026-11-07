import test from 'node:test';
import assert from 'node:assert/strict';
import { value, readPlaces, chartPaths, modelSpread, localTime, age } from '../src/presentation';
import type { ModelForecast, Hour } from '../src/types';
test('missing numbers and NaN are never rendered as zero', () => {
  assert.equal(value(null), '—');
  assert.equal(value(NaN), '—');
  assert.equal(value(0), '0');
  assert.equal(value(0.12, 1), '0.1');
});
test('malformed browser storage does not crash or create invalid places', () => {
  assert.deepEqual(readPlaces('{bad'), []);
  assert.deepEqual(readPlaces('{}'), []);
  assert.deepEqual(
    readPlaces(
      '[{"id":"1","name":"Bad","country":"X","countryCode":"X","latitude":100,"longitude":0}]',
    ),
    [],
  );
});
test('saved places are bounded and valid', () => {
  const p = {
    id: '1',
    name: 'Chennai',
    country: 'India',
    countryCode: 'IN',
    latitude: 13,
    longitude: 80,
  };
  assert.equal(readPlaces(JSON.stringify(Array(20).fill(p))).length, 8);
});
test('chart paths break across missing observations', () => {
  assert.equal(chartPaths([0, null, 10], 0, 10, 100, 100), 'M0.0,100.0  M100.0,0.0');
  assert.ok(!chartPaths([null, null], 0, 0).includes('NaN'));
});
test('model spread compares common valid timestamps only', () => {
  const a = {
    id: 'a',
    name: 'A',
    fetchedAt: 1,
    hours: [
      { time: 1, temperature: 4, wind: 0, precipitation: 0 },
      { time: 2, temperature: null, wind: 0, precipitation: 0 },
    ],
  } satisfies ModelForecast;
  const b = {
    ...a,
    id: 'b',
    hours: [
      { time: 1, temperature: 7, wind: 0, precipitation: 0 },
      { time: 2, temperature: 99, wind: 0, precipitation: 0 },
    ],
  };
  assert.equal(modelSpread([a, b], [{ time: 1 } as Hour]), 3);
  assert.equal(modelSpread([a, b], [{ time: 3 } as Hour]), null);
  assert.equal(modelSpread([a], [{ time: 1 } as Hour]), null);
});
test('time formatting uses explicit timezone and safe fallback', () => {
  assert.equal(localTime(Date.UTC(2026, 9, 30, 18, 35), 'Asia/Kolkata'), '00:05');
  assert.equal(localTime(Date.UTC(2026, 9, 30, 18, 35), 'invalid'), '18:35');
  assert.equal(age(NaN), 'Unknown age');
  assert.equal(age(0, 61000), '1m ago');
});
test('zone labels distinguish repeated local hours across daylight-saving changes', () => {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  const before = localTime(Date.UTC(2026, 10, 1, 5), 'America/New_York', options);
  const after = localTime(Date.UTC(2026, 10, 1, 6), 'America/New_York', options);
  assert.match(before, /01:00/);
  assert.match(after, /01:00/);
  assert.notEqual(before, after);
});

test('equivalent option objects reuse a formatter without caching the timestamp or changing timezone precedence', (t) => {
  const Original = Intl.DateTimeFormat;
  let constructions = 0;
  t.mock.method(
    Intl,
    'DateTimeFormat',
    function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      constructions++;
      return new Original(...args);
    },
  );
  const first: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/New_York',
  };
  const second: Intl.DateTimeFormatOptions = {
    minute: '2-digit',
    hour: '2-digit',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    second: undefined,
    timeZone: 'UTC',
  };
  const start = Date.UTC(2026, 10, 7, 5);
  const expected = new Original('en-GB', { ...first, timeZone: 'Asia/Tokyo' });
  assert.equal(localTime(start, 'Asia/Tokyo', first), expected.format(start));
  assert.equal(
    localTime(start + 3_600_000, 'Asia/Tokyo', second),
    expected.format(start + 3_600_000),
  );
  assert.equal(constructions, 1);
  assert.equal(first.timeZone, 'America/New_York', 'Formatting must not mutate caller options.');
});

test('formatter reuse preserves distinct options, zones, fallback and daylight-saving changes', () => {
  const start = Date.UTC(2026, 10, 1, 5);
  const withZone: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York', 'invalid-zone']) {
    for (const options of [withZone, { ...withZone, weekday: 'short' as const }]) {
      const expected = new Intl.DateTimeFormat('en-GB', {
        ...options,
        timeZone: zone === 'invalid-zone' ? 'UTC' : zone,
      });
      for (const time of [start, start + 3_600_000, start + 86_400_000])
        assert.equal(localTime(time, zone, options), expected.format(time));
    }
  }
  assert.equal(localTime(NaN, 'invalid-zone'), 'Unavailable');
});

test('the formatter cache is bounded and evicts the least recently used entry', (t) => {
  const zones = Intl.supportedValuesOf('timeZone').slice(0, 65);
  assert.equal(zones.length, 65);
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    era: 'long',
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    hourCycle: 'h24',
  };
  const Original = Intl.DateTimeFormat;
  let constructions = 0;
  t.mock.method(
    Intl,
    'DateTimeFormat',
    function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      constructions++;
      return new Original(...args);
    },
  );
  const time = Date.UTC(2026, 10, 7);
  for (const zone of zones) localTime(time, zone, options);
  assert.equal(constructions, 65);
  localTime(time, zones[1], options);
  assert.equal(constructions, 65, 'A recently used entry remains cached.');
  localTime(time, zones[0], options);
  assert.equal(constructions, 66, 'The oldest of 65 distinct entries was evicted.');
  localTime(time, zones[2], options);
  assert.equal(constructions, 67, 'Refreshing another entry does not grow the cache.');
});
