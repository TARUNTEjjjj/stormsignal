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
