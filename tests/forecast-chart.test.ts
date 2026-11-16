import test from 'node:test';
import assert from 'node:assert/strict';
import {
  axisTicks,
  comparisonTimeline,
  forecastDomain,
  forecastCsv,
  forecastGeometry,
  forecastSeries,
  forecastWindow,
  nearestForecastHour,
  pointPosition,
  selectedHourIndex,
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

test('the inspected hour is found by its time, not by its place in the window', () => {
  const hourly = Array.from({ length: 30 }, (_, offset) => offset * HOUR);
  const before = hourly.slice(0, 24);
  // Half past each hour the app drops the oldest hour, so every later hour moves one place left.
  const after = hourly.slice(1, 25);
  assert.equal(after[selectedHourIndex(after, before[6])], before[6]);
  assert.equal(selectedHourIndex(after, before[6]), 5);
  // No selection yet, or an inspected hour that has left the window: the first hour.
  assert.equal(selectedHourIndex(after, null), 0);
  assert.equal(selectedHourIndex(after, before[0]), 0);
  // A time beyond the window, or in a gap the provider left: the last, or the next later hour.
  assert.equal(selectedHourIndex(before, 50 * HOUR), 23);
  assert.equal(selectedHourIndex([0, HOUR, 4 * HOUR], 2 * HOUR), 2);
  assert.equal(selectedHourIndex([], 2 * HOUR), 0);
});

const START = Date.UTC(2026, 10, 15, 14);
function model(
  name: string,
  readings: [offset: number, temperature: number | null, wind?: number][],
) {
  return {
    id: name,
    name,
    fetchedAt: 0,
    hours: readings.map(([offset, temperature, wind = null]) => ({
      time: START + offset * HOUR,
      temperature,
      precipitation: null,
      wind,
    })),
  } satisfies ModelForecast;
}
const offsets = (timeline: Hour[]) => timeline.map((hour) => (hour.time - START) / HOUR);

test('comparison hours the local forecast omits join the timeline with local values missing', () => {
  const local = [3, 0, 1].map((offset) => ({ ...hours[0], time: START + offset * HOUR }));
  const gfs = model(
    'GFS',
    [-1, 0, 1, 2, 3, 24, 30].map((offset) => [offset, 20 + offset]),
  );
  // 16:00 is missing locally. Hours before the first local hour or beyond the range stay out.
  const timeline = comparisonTimeline(local, [gfs], 24);
  assert.deepEqual(offsets(timeline), [0, 1, 2, 3]);
  assert.deepEqual(timeline[2], {
    time: START + 2 * HOUR,
    temperature: null,
    apparent: null,
    precipitation: null,
    probability: null,
    wind: null,
    gust: null,
    humidity: null,
    code: null,
    uv: null,
  });
  const [localPoints, gfsPoints] = forecastSeries(timeline, [gfs], 'temperature');
  assert.deepEqual(
    gfsPoints.map((point) => point.value),
    [20, 21, 22, 23],
  );
  const domain = forecastDomain([localPoints, gfsPoints], 'temperature');
  assert.equal((forecastGeometry(gfsPoints, domain).line.match(/M/g) || []).length, 1);
  assert.equal((forecastGeometry(localPoints, domain).line.match(/M/g) || []).length, 2);
  assert.ok(
    forecastCsv(timeline, [gfs], 'temperature').includes('"2026-11-15T16:00:00.000Z",,22\r\n'),
  );
  assert.deepEqual(offsets(comparisonTimeline(local, [gfs], 72)), [0, 1, 2, 3, 24, 30]);
  // Two models reporting the same missing hour add it once. A reading of any metric keeps the
  // hour, so the timeline does not change with the metric shown; a record without one adds none.
  assert.deepEqual(
    offsets(comparisonTimeline(local, [gfs, model('ECMWF', [[2, 21]])], 24)),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    offsets(comparisonTimeline(local, [model('ECMWF', [[2, null, 7]])], 24)),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    offsets(comparisonTimeline(local, [model('ECMWF', [[2, null]])], 24)),
    [0, 1, 3],
  );
  assert.deepEqual(comparisonTimeline(local, [], 24), forecastWindow(local, 24));
  assert.deepEqual(comparisonTimeline([], [gfs], 24), []);
});

test('a comparison model on another time grid cannot open gaps in the local forecast', () => {
  const local = [0, 1, 2].map((offset) => ({ ...hours[0], time: START + offset * HOUR }));
  const halfHours = model(
    'Half-hour grid',
    [0.5, 1.5, 2.5].map((offset) => [offset, 10]),
  );
  // Readings between joined local hours stay unmatched; the one after the last local hour is kept.
  const timeline = comparisonTimeline(local, [halfHours], 24);
  assert.deepEqual(offsets(timeline), [0, 1, 2, 2.5]);
  const [localPoints] = forecastSeries(timeline, [halfHours], 'temperature');
  const line = forecastGeometry(localPoints, { min: 0, max: 30 });
  assert.equal((line.line.match(/M/g) || []).length, 1);
  assert.equal(line.isolated.length, 0);
});

test('axis ticks follow elapsed time and stay a quarter of the axis apart', () => {
  const ticks = (hourOffsets: number[]) =>
    axisTicks(hourOffsets.map((offset) => offset * HOUR)).map((index) => hourOffsets[index]);
  const hourly = (length: number) => Array.from({ length }, (_, offset) => offset);
  assert.deepEqual(ticks(hourly(24)), [0, 7, 15, 23]);
  assert.deepEqual(ticks(hourly(72)), [0, 23, 47, 71]);
  // Evenly spaced hours keep the ticks that array positions used to give them. Six hours are
  // the exception: their second tick sat a fifth of the axis from the first.
  for (let length = 2; length <= 96; length++)
    if (length !== 6)
      assert.deepEqual(ticks(hourly(length)), [
        ...new Set([
          0,
          Math.floor((length - 1) / 3),
          Math.floor((2 * (length - 1)) / 3),
          length - 1,
        ]),
      ]);
  assert.deepEqual(ticks(hourly(6)), [0, 3, 5]);
  // With hours missing, array positions gave [0, 2, 4, 23], [0, 1, 2, 23] and [0, 2, 41, 71].
  assert.deepEqual(ticks([0, 1, 2, 3, 4, 5, 22, 23]), [0, 23]);
  assert.deepEqual(ticks([0, 1, 2, 3, 23]), [0, 23]);
  assert.deepEqual(ticks([0, 1, 2, 3, 40, 41, 42, 70, 71]), [0, 42, 71]);
  assert.deepEqual(ticks([0, 6, 7, 20, 23]), [0, 7, 23]);
  assert.deepEqual(axisTicks([5 * HOUR]), [0]);
  assert.deepEqual(axisTicks([]), []);
});
