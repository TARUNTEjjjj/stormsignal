import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveHazards, getOutlook, FORECAST_STALE_MS } from '../src/risk';
import type { Forecast, Hour } from '../src/types';

const now = Date.parse('2026-10-30T10:00:00Z');
const hour = (values: Partial<Hour> = {}): Hour => ({
  time: now + 3_600_000,
  temperature: 22,
  apparent: 22,
  precipitation: 0,
  probability: 0,
  wind: 10,
  gust: 20,
  humidity: 50,
  code: 0,
  uv: 1,
  ...values,
});
const forecast = (hours: Hour[], fetchedAt = now): Forecast => ({
  hours,
  current: hour(),
  fetchedAt,
  timezone: 'UTC',
  days: [],
  source: 'test',
});

test('null values do not trigger cold or imply zero precipitation', () => {
  assert.deepEqual(
    deriveHazards(
      forecast([
        hour({
          temperature: null,
          precipitation: null,
          gust: null,
          apparent: null,
          uv: null,
          code: null,
        }),
      ]),
      now,
    ),
    [],
  );
});

test('thresholds are inclusive and high severity replaces earlier lower severity', () => {
  const hazards = deriveHazards(
    forecast([hour({ precipitation: 5 }), hour({ precipitation: 15, time: now + 2 * 3_600_000 })]),
    now,
  );
  assert.equal(hazards.length, 1);
  assert.equal(hazards[0].level, 'high');
  assert.equal(hazards[0].time, now + 2 * 3_600_000);
  // The lower threshold on its own is a signal too.
  assert.deepEqual(
    deriveHazards(forecast([hour({ precipitation: 5 })]), now).map((h) => [h.kind, h.level]),
    [['rain', 'elevated']],
  );
});

test('high signals are listed before elevated ones, each group in time order', () => {
  // The panel shows the first four signals, so the order decides which ones are seen.
  const at = (hours: number, values: Partial<Hour>) =>
    hour({ ...values, time: now + hours * 3_600_000 });
  const hazards = deriveHazards(
    forecast([
      at(1, { code: 95 }),
      at(2, { precipitation: 6 }),
      at(3, { gust: 80 }),
      at(4, { precipitation: 20 }),
    ]),
    now,
  );
  assert.deepEqual(
    hazards.map((h) => [h.kind, h.level, (h.time - now) / 3_600_000]),
    [
      ['wind', 'high', 3],
      ['rain', 'high', 4],
      ['thunder', 'elevated', 1],
    ],
  );
});

test('does not mix past or more-than-24-hour values into the current hazard view', () => {
  const hazards = deriveHazards(
    forecast([
      hour({ gust: 150, time: now - 3_600_000 }),
      hour({ gust: 150, time: now + 24 * 3_600_000 }),
    ]),
    now,
  );
  assert.deepEqual(hazards, []);
});

test('stale or implausibly future-dated forecasts do not create current hazard signals', () => {
  assert.deepEqual(
    deriveHazards(forecast([hour({ precipitation: 50 })], now - FORECAST_STALE_MS - 1), now),
    [],
  );
  assert.deepEqual(
    deriveHazards(forecast([hour({ precipitation: 50 })], now + 60 * 60_000), now),
    [],
  );
});

test('wind, heat, cold, UV, and thunderstorm indicators retain distinct meanings', () => {
  const hazards = deriveHazards(
    forecast([hour({ gust: 75, apparent: 40, temperature: -15, uv: 8, code: 99 })]),
    now,
  );
  assert.deepEqual(
    new Set(hazards.map((h) => h.kind)),
    new Set(['wind', 'heat', 'cold', 'uv', 'thunder']),
  );
  assert.ok(hazards.every((h) => h.level === 'high'));
});

test('a hazard card never prints the high threshold while its level is elevated', () => {
  const only = (values: Partial<Hour>) => {
    const hazards = deriveHazards(forecast([hour(values)]), now);
    assert.equal(hazards.length, 1, JSON.stringify(values));
    return `${hazards[0].level}: ${hazards[0].detail.split('. ')[0]}`;
  };
  // Just below a high threshold: the level stays elevated, and the text stays below it too.
  assert.equal(only({ gust: 74.6 }), 'elevated: Gusts around 74 km/h in the forecast');
  assert.equal(only({ apparent: 39.6 }), 'elevated: Feels-like temperature around 39°C');
  assert.equal(only({ temperature: -14.6 }), 'elevated: Air temperature around -14°C');
  assert.equal(only({ uv: 7.96 }), 'elevated: Forecast UV index 7.9');
  assert.equal(only({ precipitation: 14.96 }), 'elevated: 14.9 mm forecast in one hour');
  // Everywhere else the value is rounded as before.
  assert.equal(only({ gust: 62.7 }), 'elevated: Gusts around 63 km/h in the forecast');
  assert.equal(only({ gust: 75.4 }), 'high: Gusts around 75 km/h in the forecast');
  assert.equal(only({ temperature: -7.5 }), 'elevated: Air temperature around -7°C');
  assert.equal(only({ temperature: -15.4 }), 'high: Air temperature around -15°C');
  assert.equal(only({ uv: 8.04 }), 'high: Forecast UV index 8.0');
  assert.equal(only({ precipitation: 15 }), 'high: 15.0 mm forecast in one hour');

  // Every value near the thresholds: the level follows the forecast value, and the printed value
  // lies in the band that level names, within one printed unit of the forecast value.
  const cases = [
    { field: 'precipitation', kind: 'rain', low: 5, high: 15, unit: 0.1, shown: /^(\d+\.\d) mm/ },
    { field: 'gust', kind: 'wind', low: 50, high: 75, unit: 1, shown: /around (\d+) km\/h/ },
    { field: 'apparent', kind: 'heat', low: 35, high: 40, unit: 1, shown: /around (\d+)°C/ },
    { field: 'temperature', kind: 'cold', low: -5, high: -15, unit: 1, shown: /around (-\d+)°C/ },
    { field: 'uv', kind: 'uv', low: 6, high: 8, unit: 0.1, shown: /UV index (\d+\.\d)\./ },
  ] as const;
  for (const c of cases) {
    const sign = c.high < c.low ? -1 : 1; // for cold, lower is more severe
    const reaches = (value: number, threshold: number) => sign * value >= sign * threshold;
    for (let i = -200; i <= 200; i++) {
      for (const threshold of [c.low, c.high]) {
        const raw = Number((threshold + i / 100).toFixed(2));
        const hazard = deriveHazards(forecast([hour({ [c.field]: raw })]), now).find(
          (h) => h.kind === c.kind,
        );
        const note = `${c.field} ${raw}: ${hazard?.level} "${hazard?.detail}"`;
        if (!reaches(raw, c.low)) {
          assert.equal(hazard, undefined, note);
          continue;
        }
        assert.equal(hazard?.level, reaches(raw, c.high) ? 'high' : 'elevated', note);
        const printed = Number(hazard?.detail.match(c.shown)?.[1]);
        assert.equal(reaches(printed, c.high), hazard?.level === 'high', note);
        assert.ok(reaches(printed, c.low) && Math.abs(printed - raw) < c.unit, note);
      }
    }
  }
});

test('a heavy snow hour is a snow signal, not heavy rain with flood advice', () => {
  // Open-Meteo's precipitation counts snow as liquid water; the hour's weather code says snow.
  const signals = (values: Partial<Hour>) =>
    deriveHazards(forecast([hour(values)]), now).map((h) => `${h.level}: ${h.title}. ${h.detail}`);
  const snow = signals({ code: 75, temperature: -8.6, precipitation: 5.9 });
  assert.doesNotMatch(snow.join(' | '), /rain|flood/i);
  assert.equal(
    snow[0],
    'elevated: Heavy snow signal. 5.9 mm water equivalent forecast as snow in one hour; the snow depth is greater. Follow local winter weather advice.',
  );
  assert.match(signals({ code: 86, precipitation: 15 })[0], /^high: Heavy snow signal\. 15\.0 mm/);
  // Rain keeps its flood advice. Without a weather code, the kind of precipitation is unknown.
  assert.match(
    signals({ code: 65, precipitation: 6 })[0],
    /^elevated: Heavy rain signal\. 6\.0 mm forecast in one hour\. Local flooding/,
  );
  assert.match(
    signals({ code: null, precipitation: 6 })[0],
    /^elevated: Heavy precipitation signal/,
  );
  const kinds = (values: Partial<Hour>) =>
    deriveHazards(forecast([hour(values)]), now).map((h) => h.kind);
  assert.deepEqual(kinds({ code: 75, precipitation: 5.9 }), ['snow']);
  assert.deepEqual(kinds({ code: 65, precipitation: 6 }), ['rain']);
  assert.deepEqual(kinds({ code: null, precipitation: 6 }), ['rain']);
});

test('heavy rain and heavy snow in the same 24 hours are both shown', () => {
  // Each kind keeps its own strongest signal, so a snow hour cannot hide a rain hour or the reverse.
  const at = (hours: number, values: Partial<Hour>) =>
    hour({ ...values, time: now + hours * 3_600_000 });
  const hours = [
    at(2, { code: 65, precipitation: 6 }),
    at(9, { code: 75, temperature: -3, apparent: -8, precipitation: 16 }),
    at(12, { code: 73, temperature: -4, apparent: -9, precipitation: 7 }),
  ];
  assert.deepEqual(
    deriveHazards(forecast(hours), now).map((h) => [
      h.kind,
      h.level,
      h.title,
      (h.time - now) / 3_600_000,
    ]),
    [
      ['snow', 'high', 'Heavy snow signal', 9],
      ['rain', 'elevated', 'Heavy rain signal', 2],
    ],
  );
  assert.match(getOutlook(hours, now).detail, /^2 weather signals in the next 24 hours\./);
  // An hour without a weather code stays a precipitation signal beside a snow signal.
  assert.deepEqual(
    deriveHazards(
      forecast([at(1, { code: null, precipitation: 6 }), at(2, { code: 85, precipitation: 6 })]),
      now,
    ).map((h) => [h.kind, h.title]),
    [
      ['rain', 'Heavy precipitation signal'],
      ['snow', 'Heavy snow signal'],
    ],
  );
});

test('outlook with absent values is unknown, not an all-clear', () => {
  const result = getOutlook(
    [
      hour({
        temperature: null,
        apparent: null,
        gust: null,
        precipitation: null,
        uv: null,
        code: null,
      }),
    ],
    now,
  );
  assert.equal(result.level, 'unknown');
});

test('outlook without selected signals explicitly avoids safety assurance', () => {
  const result = getOutlook([hour()], now);
  assert.equal(result.level, 'watch');
  assert.match(result.detail, /does not rule out hazardous/);
});

test('a high forecast signal is explicitly distinct from an official warning', () => {
  const result = getOutlook([hour({ gust: 90 })], now);
  assert.equal(result.level, 'high');
  assert.match(result.detail, /not official warnings/);
});

test('heavy thunderstorms produce a high model signal without creating an official warning', () => {
  const result = deriveHazards(forecast([hour({ code: 97 })]), now);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'thunder');
  assert.equal(result[0].level, 'high');
  assert.equal(getOutlook([hour({ code: 97 })], now).level, 'high');
  assert.match(getOutlook([hour({ code: 97 })], now).detail, /not official warnings/);
});
