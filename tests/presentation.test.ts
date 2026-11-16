import test from 'node:test';
import assert from 'node:assert/strict';
import {
  value,
  readPlaces,
  chartPaths,
  modelSpread,
  localTime,
  age,
  warningTime,
  clockDifference,
  clockNotice,
  MAX_SAVED_PLACES,
  toggleSavedPlace,
  outlookDayLabel,
  isDaylight,
} from '../src/presentation';
import type { ModelForecast, Hour, Place } from '../src/types';
test('missing numbers and NaN are never rendered as zero', () => {
  assert.equal(value(null), '—');
  assert.equal(value(NaN), '—');
  assert.equal(value(0), '0');
  assert.equal(value(0.12, 1), '0.1');
});
test('a negative value that rounds to zero is shown without a minus sign', () => {
  // A winter reading such as -0.3 °C must not read "-0".
  assert.equal(value(-0.3), '0');
  assert.equal(value(-0.49), '0');
  assert.equal(value(-0.04, 1), '0.0');
  assert.equal(value(-0), '0');
  // The chart's lower axis bound for 2.4 to 18.6 °C: floor(2.4) less 12% padding.
  assert.equal(value(2 - 17 * 0.12, 1), '0.0');
  // A value that keeps a digit other than zero keeps its sign.
  assert.equal(value(-0.5), '-1');
  assert.equal(value(-0.3, 1), '-0.3');
  assert.equal(value(-0.06, 1), '-0.1');
  assert.equal(value(-12.34, 1), '-12.3');
});
test('malformed browser storage does not crash or create invalid places', () => {
  assert.deepEqual(readPlaces('{bad'), []);
  assert.deepEqual(readPlaces('{}'), []);
  assert.deepEqual(
    readPlaces(
      '[{"id":"1","name":"Bad","country":"X","countryCode":"IN","latitude":100,"longitude":0}]',
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
test('saved places reject malformed metadata without discarding other valid places', () => {
  const valid = {
    id: 'chennai',
    name: 'Chennai',
    country: 'India',
    countryCode: 'IN',
    latitude: 13,
    longitude: 80,
    admin: 'Tamil Nadu',
    timezone: 'Asia/Kolkata',
  };
  for (const invalid of [
    { admin: {} },
    { admin: 'x'.repeat(201) },
    { timezone: {} },
    { timezone: 'not/a-timezone' },
    { countryCode: 'India' },
    { id: ' ' },
    { id: 'x'.repeat(301) },
    { name: ' ' },
    { country: 'x'.repeat(201) },
  ]) {
    assert.deepEqual(readPlaces(JSON.stringify([{ ...valid, ...invalid }, valid])), [valid]);
  }
});
test('saved places retain only known fields and normalize country codes', () => {
  const valid = {
    id: 'chennai',
    name: 'Chennai',
    country: 'India',
    countryCode: 'IN',
    latitude: 13,
    longitude: 80,
  };
  assert.deepEqual(readPlaces(JSON.stringify([{ ...valid, countryCode: 'in', extra: {} }])), [
    valid,
  ]);
  const point = { ...valid, id: 'point', name: 'Selected point', country: '', countryCode: '' };
  assert.deepEqual(readPlaces(JSON.stringify([point])), [point]);
  assert.deepEqual(readPlaces(' '.repeat(65_537) + JSON.stringify([valid])), []);
});
const savedPlace = (name: string, latitude: number, longitude: number): Place => ({
  id: name.toLowerCase().replaceAll(' ', '-'),
  name,
  country: 'Testland',
  countryCode: 'TL',
  latitude,
  longitude,
});
const names = (places: Place[]) => places.map((place) => place.name);
test('saving or removing a place merges with what another window stored meanwhile', () => {
  const tokyo = savedPlace('Tokyo', 35.6762, 139.6503);
  const london = savedPlace('London', 51.5085, -0.1257);
  const miami = savedPlace('Miami', 25.7743, -80.1937);
  // Another window saved Tokyo after this one loaded an empty list.
  const added = toggleSavedPlace(JSON.stringify([tokyo]), london, false);
  assert.deepEqual(names(added.places), ['London', 'Tokyo']);
  assert.equal(added.dropped, null);
  // Places removed or cleared elsewhere stay removed.
  assert.deepEqual(names(toggleSavedPlace('[]', miami, false).places), ['Miami']);
  assert.deepEqual(names(toggleSavedPlace(null, miami, false).places), ['Miami']);
  const stored = JSON.stringify([london, tokyo, miami]);
  assert.deepEqual(names(toggleSavedPlace(stored, tokyo, true).places), ['London', 'Miami']);
  assert.deepEqual(names(toggleSavedPlace(null, tokyo, true).places), []);
  // The same point saved again moves to the front without a duplicate.
  const again = { ...tokyo, id: 'tokyo-again', latitude: tokyo.latitude + 0.004 };
  assert.deepEqual(names(toggleSavedPlace(stored, again, false).places), [
    'Tokyo',
    'London',
    'Miami',
  ]);
});
test('a full saved-place list keeps the newest places and reports the one it removed', () => {
  const full = Array.from({ length: MAX_SAVED_PLACES }, (_, index) =>
    savedPlace(`Saved ${index + 1}`, 10 + index, 10 + index),
  );
  const result = toggleSavedPlace(
    JSON.stringify(full),
    savedPlace('Tokyo', 35.6762, 139.6503),
    false,
  );
  assert.deepEqual(names(result.places), ['Tokyo', ...names(full).slice(0, MAX_SAVED_PLACES - 1)]);
  assert.equal(result.dropped?.name, `Saved ${MAX_SAVED_PLACES}`);
  // Saving a place that is already on a full list removes nothing.
  assert.equal(toggleSavedPlace(JSON.stringify(full), full[3], false).dropped, null);
});
test('7-day outlook rows name the provider day across a clock change', () => {
  // Open-Meteo starts each daily step at midnight by the one UTC offset in force at the request.
  const days = (firstDay: number, offsetHours: number) =>
    Array.from(
      { length: 7 },
      (_, index) => firstDay + index * 86_400_000 - offsetHours * 3_600_000,
    );
  const labels = (times: number[], zone: string, now: number) =>
    times.map((time) => outlookDayLabel(time, zone, now));
  // New York on Saturday 31 October 2026; clocks go back early on Sunday.
  assert.deepEqual(
    labels(days(Date.UTC(2026, 9, 31), -4), 'America/New_York', Date.UTC(2026, 9, 31, 16)),
    ['Today', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  );
  // Just after midnight on the night of the change.
  assert.deepEqual(
    labels(days(Date.UTC(2026, 10, 1), -4), 'America/New_York', Date.UTC(2026, 10, 1, 4, 30)),
    ['Today', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  );
  // Sunday 14 March 2027, after clocks went forward at 02:00.
  assert.deepEqual(
    labels(days(Date.UTC(2027, 2, 14), -4), 'America/New_York', Date.UTC(2027, 2, 14, 16)),
    ['Today', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  );
  // A real answer for Sydney, 30 September to 6 October 2026; clocks went forward on 4 October.
  const sydney = [
    1790686800, 1790773200, 1790859600, 1790946000, 1791032400, 1791118800, 1791205200,
  ];
  assert.deepEqual(
    labels(
      sydney.map((seconds) => seconds * 1000),
      'Australia/Sydney',
      Date.UTC(2026, 10, 16, 4),
    ),
    ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue'],
  );
  // No clock change.
  assert.deepEqual(
    labels(days(Date.UTC(2026, 10, 16), 5.5), 'Asia/Kolkata', Date.UTC(2026, 10, 16, 6)),
    ['Today', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  );
});
test('day and night follow the sun at the selected point', () => {
  // Chennai, 16 November 2026: sunrise about 06:05 and sunset about 17:40 (UTC+5:30).
  const chennai = (hour: number, minute = 0) =>
    isDaylight(Date.UTC(2026, 10, 16, hour, minute), 13.0827, 80.2707);
  for (const [hour, minute] of [
    [18, 0],
    [20, 30],
    [23, 0],
    [0, 0],
    [13, 0],
  ])
    assert.equal(chennai(hour, minute), false, `${hour}:${minute} UTC is night in Chennai`);
  for (const [hour, minute] of [
    [1, 0],
    [6, 30],
    [11, 30],
  ])
    assert.equal(chennai(hour, minute), true, `${hour}:${minute} UTC is day in Chennai`);
  // A summer evening in Sydney (sunset about 20:05, UTC+11) and a winter afternoon in London
  // (sunset about 16:10).
  assert.equal(isDaylight(Date.UTC(2026, 11, 21, 8), -33.8688, 151.2093), true);
  assert.equal(isDaylight(Date.UTC(2026, 11, 21, 11), -33.8688, 151.2093), false);
  assert.equal(isDaylight(Date.UTC(2026, 10, 16, 15, 30), 51.5085, -0.1257), true);
  assert.equal(isDaylight(Date.UTC(2026, 10, 16, 16, 45), 51.5085, -0.1257), false);
  // Tromsø: no sunrise at midday in December, no sunset at midnight in June.
  assert.equal(isDaylight(Date.UTC(2026, 11, 15, 10, 40), 69.6492, 18.9553), false);
  assert.equal(isDaylight(Date.UTC(2027, 5, 21, 22, 40), 69.6492, 18.9553), true);
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
test('official warning times name their time zone wherever the viewer is', () => {
  // A Miami expiry read by a viewer in India must not look like an Indian time.
  const expires = Date.UTC(2026, 10, 9, 22);
  assert.match(warningTime(expires, 'America/New_York'), /^09 Nov\D+17:00 GMT-5$/);
  assert.match(warningTime(expires, 'Asia/Kolkata'), /^10 Nov\D+03:30 GMT\+5:30$/);
  assert.match(warningTime(expires, 'UTC', true), /^09 Nov 2026\D+22:00 UTC$/);
  // The UTC fallback for an unknown zone says so.
  assert.match(warningTime(expires, 'invalid-zone'), /22:00 UTC$/);
  // The repeated New York hour at the fall-back change stays distinct.
  const first = warningTime(Date.UTC(2026, 10, 1, 5, 30), 'America/New_York');
  const second = warningTime(Date.UTC(2026, 10, 1, 6, 30), 'America/New_York');
  assert.match(first, /01:30 GMT-4$/);
  assert.match(second, /01:30 GMT-5$/);
});

test('a device clock five minutes or more from the warning service is named, with its direction', () => {
  const MINUTE = 60_000;
  for (const quiet of [undefined, NaN, Infinity, 0, 4_000, -299_999, 299_999]) {
    assert.equal(clockDifference(quiet), '');
    assert.equal(clockNotice(quiet), '');
  }
  assert.equal(clockDifference(5 * MINUTE), 'about 5 minutes ahead of');
  assert.equal(clockDifference(-10 * MINUTE - 20_000), 'about 10 minutes behind');
  assert.equal(clockDifference(119 * MINUTE), 'about 119 minutes ahead of');
  assert.equal(clockDifference(-3 * 60 * MINUTE), 'about 3 hours behind');
  assert.equal(clockDifference(47 * 60 * MINUTE), 'about 47 hours ahead of');
  assert.equal(clockDifference(-30 * 24 * 60 * MINUTE), 'about 30 days behind');
  const notice = clockNotice(60 * MINUTE);
  assert.match(
    notice,
    /^This device’s clock is about 60 minutes ahead of the warning service’s clock\./,
  );
  assert.match(notice, /listed by the service’s clock/);
  assert.match(notice, /check this device’s date and time/);
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
