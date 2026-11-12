import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forecastDomain,
  forecastCsv,
  forecastGeometry,
  forecastSeries,
  forecastWindow,
  nearestForecastHour,
  pointPosition,
} from '../src/forecast-chart';
import type { Hour, ModelForecast } from '../src/types';
const HOUR = 3_600_000;
const hours = [0, HOUR, 2 * HOUR].map(
  (time) => ({ time, temperature: 20, precipitation: 0, wind: 5 }) as Hour,
);

test('forecast windows bound elapsed time, sort readings and retain visible gaps', () => {
  const sparse = [30, 0, 23, 24, 2, 2, NaN].map((time) => ({ time: time * HOUR }) as Hour);
  assert.deepEqual(
    forecastWindow(sparse, 24).map((hour) => hour.time / HOUR),
    [0, 2, 23],
  );
  assert.deepEqual(
    forecastWindow(sparse, 72).map((hour) => hour.time / HOUR),
    [0, 2, 23, 24, 30],
  );
  assert.deepEqual(forecastWindow([], 24), []);
  assert.deepEqual(forecastWindow(sparse, 0), []);
  assert.deepEqual(
    sparse.map((hour) => hour.time / HOUR),
    [30, 0, 23, 24, 2, 2, NaN],
  );
});

test('CSV preserves UTC timestamps, timestamp alignment, zero and missing measurements', () => {
  const local = [
    { ...hours[0], temperature: -2 },
    { ...hours[1], temperature: null },
  ];
  const models: ModelForecast[] = [
    {
      id: 'test',
      name: '=SUM(1,2)',
      fetchedAt: 0,
      hours: [{ time: HOUR, temperature: 0, precipitation: 0, wind: 0 }],
    },
  ];
  const csv = forecastCsv(local, models, 'temperature');
  assert.equal(
    csv,
    '"time_utc","Local forecast: temperature (C)","\'=SUM(1,2): temperature (C)"\r\n"1970-01-01T00:00:00.000Z",-2,\r\n"1970-01-01T01:00:00.000Z",,0\r\n',
  );
  assert.equal(forecastCsv([], [], 'wind'), '"time_utc","Local forecast: wind (km/h)"\r\n');
});

test('comparison series join by timestamp and leave unmatched hours unavailable', () => {
  const models: ModelForecast[] = [
    {
      id: 'gfs',
      name: 'GFS',
      fetchedAt: 0,
      hours: [
        { time: 2 * HOUR, temperature: 25, precipitation: 2, wind: 9 },
        { time: 0, temperature: 17, precipitation: 0, wind: 6 },
        { time: 4 * HOUR, temperature: 100, precipitation: 9, wind: 30 },
      ],
    },
  ];
  assert.deepEqual(
    forecastSeries(hours, models, 'temperature')[1].map((point) => point.value),
    [17, null, 25],
  );
  assert.deepEqual(
    forecastSeries(hours, models, 'precipitation')[1].map((point) => point.value),
    [0, null, 2],
  );
});

test('domain includes comparison extremes and gives constant data a usable scale', () => {
  const domain = forecastDomain(
    [[{ time: 0, value: 20 }], [{ time: 0, value: -10 }], [{ time: 0, value: 45 }]],
    'temperature',
  );
  assert.ok(domain.min < -10 && domain.max > 45);
  const constant = forecastDomain([[{ time: 0, value: 0 }]], 'precipitation');
  assert.equal(constant.min, 0);
  assert.ok(constant.max > 0);
  assert.deepEqual(
    forecastDomain(
      [
        [
          { time: 0, value: null },
          { time: HOUR, value: NaN },
        ],
      ],
      'temperature',
    ),
    { min: 0, max: 1 },
  );
});

test('line and area break across missing values without implying zero', () => {
  const geometry = forecastGeometry(
    [1, 2, null, 3, 4].map((value, index) => ({ value, time: index * HOUR })),
    { min: 0, max: 5 },
  );
  assert.equal((geometry.line.match(/M/g) || []).length, 2);
  assert.equal((geometry.area.match(/Z/g) || []).length, 2);
  assert.equal(geometry.isolated.length, 0);
  assert.ok(!geometry.line.includes('NaN'));
});

test('missing timestamps produce a gap and isolated readings remain visible points', () => {
  const geometry = forecastGeometry(
    [
      { time: 0, value: 1 },
      { time: 3 * HOUR, value: 4 },
    ],
    { min: 0, max: 5 },
  );
  assert.equal((geometry.line.match(/M/g) || []).length, 2);
  assert.equal(geometry.area, '');
  assert.equal(geometry.isolated.length, 2);
  assert.equal(pointPosition(0, 0, 0), 300);
  const single = forecastGeometry([{ time: HOUR, value: 2 }], { min: 0, max: 5 });
  assert.equal(single.isolated[0].x, 300);
  assert.deepEqual(forecastGeometry([], { min: 0, max: 1 }), { line: '', area: '', isolated: [] });
});

test('pointer selection clamps boundaries and follows timestamps rather than array spacing', () => {
  const times = [0, HOUR, 4 * HOUR];
  assert.equal(nearestForecastHour(times, -0.5), 0);
  assert.equal(nearestForecastHour(times, 2), 2);
  assert.equal(nearestForecastHour(times, 0.3), 1);
  assert.equal(nearestForecastHour(times, NaN), 0);
  assert.equal(nearestForecastHour([], 0.5), 0);
  assert.equal(nearestForecastHour([7], 1), 0);
});
