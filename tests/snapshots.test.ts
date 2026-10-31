import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFLINE_PACK_KEY,
  MAX_BRIEFING_BYTES,
  createBriefing,
  validateBriefing,
  loadBriefings,
  saveBriefing,
  removeBriefing,
  clearBriefings,
  briefingText,
  officialBriefingUrl,
  type StorageAccess,
} from '../src/offline';
import type { Place, Forecast, AlertResult } from '../src/types';

const NOW = Date.UTC(2026, 10, 1, 3);
const HOUR = 3_600_000;
const place: Place = {
  id: 'miami',
  name: 'Miami',
  country: 'United States',
  countryCode: 'US',
  latitude: 25.7743,
  longitude: -80.1937,
  timezone: 'America/New_York',
};
const hour = (time: number) => ({
  time,
  temperature: 25,
  apparent: 27,
  precipitation: 0,
  probability: 20,
  gust: 25,
  wind: 10,
  humidity: 60,
  code: 3,
  uv: 2,
});
const forecast: Forecast = {
  fetchedAt: NOW,
  timezone: 'America/New_York',
  current: hour(NOW),
  hours: Array.from({ length: 72 }, (_, i) => hour(NOW + i * HOUR)),
  days: [],
  source: 'Open-Meteo forecast',
};
const alerts: AlertResult = {
  status: 'available',
  fetchedAt: NOW,
  source: 'US National Weather Service',
  coverage: 'NWS point alerts; no warning is not an all-clear.',
  officialUrl: 'https://www.weather.gov/',
  alerts: [
    {
      id: 'test-alert',
      title: 'Fixture flood warning',
      event: 'Flood Warning',
      severity: 'Severe',
      area: 'Fixture county',
      sent: NOW - HOUR,
      effective: NOW - HOUR,
      expires: NOW + HOUR,
      description: 'Test data, not a current warning.',
      instruction: 'Do not enter floodwater.',
      source: 'National Weather Service',
      url: 'https://www.weather.gov/safety/flood',
      geometry: { type: 'Polygon', coordinates: [[[1, 2]]] },
    },
  ],
};
const pack = () => createBriefing(place, forecast, alerts, NOW);
function storage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(OFFLINE_PACK_KEY, initial);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}
const encoded = (briefings = [pack()]) => JSON.stringify({ version: 1, briefings });

test('offline briefings preserve fetch and valid times, omit geometry and limit hourly data', () => {
  const item = pack();
  assert.equal(item.savedAt, NOW);
  assert.equal(item.forecast.fetchedAt, NOW);
  assert.equal(item.forecast.current.time, NOW);
  assert.equal(item.forecast.hours.length, 24);
  assert.equal(item.warnings.alerts[0].instruction, alerts.alerts[0].instruction);
  assert.equal(Object.hasOwn(item.warnings.alerts[0], 'geometry'), false);
  assert.equal(JSON.stringify(item).includes('coordinates'), false);
});

test('snapshot save limits are explicit when warning texts exceed five', () => {
  const input = {
    ...alerts,
    alerts: Array.from({ length: 8 }, (_, i) => ({ ...alerts.alerts[0], id: `alert-${i}` })),
  };
  const item = createBriefing(place, forecast, input, NOW);
  assert.equal(item.warnings.alerts.length, 5);
  assert.equal(item.warnings.omitted, 3);
  assert.match(briefingText(item, NOW), /3 additional warning/);
});

test('missing or stale warning retrieval becomes unavailable rather than no-danger', () => {
  for (const input of [null, { ...alerts, fetchedAt: NOW - 6 * 60000 }]) {
    const item = createBriefing(place, forecast, input, NOW);
    assert.equal(item.warnings.status, 'unavailable');
    assert.equal(item.warnings.fetchedAt, null);
    assert.deepEqual(item.warnings.alerts, []);
    assert.match(item.warnings.coverage, /not an all-clear/);
  }
});

test('unsupported regional warning coverage remains unsupported in saved briefing', () => {
  const india = {
    ...place,
    countryCode: 'IN',
    country: 'India',
    name: 'Chennai',
    latitude: 13,
    longitude: 80,
  };
  const item = createBriefing(
    india,
    forecast,
    {
      ...alerts,
      status: 'unsupported',
      alerts: [],
      source: 'IMD',
      officialUrl: 'https://mausam.imd.gov.in/',
    },
    NOW,
  );
  assert.equal(item.warnings.status, 'unsupported');
  assert.equal(item.warnings.alerts.length, 0);
  assert.equal(officialBriefingUrl(india), 'https://mausam.imd.gov.in/');
});

test('old saved briefing remains historical and expiry status changes without refreshing time', () => {
  const item = validateBriefing(pack(), NOW + 20 * 86400000);
  assert.equal(item.savedAt, NOW);
  assert.equal(item.warnings.fetchedAt, NOW);
  const exported = briefingText(item, NOW + 20 * 86400000);
  assert.match(exported, /SAVED HISTORICAL BRIEFING/);
  assert.match(exported, /NOT LIVE/);
  assert.match(exported, /PAST STATED EXPIRY/);
  assert.match(exported, /Warnings may have changed or been cancelled/);
});

test('future-dated and old forecasts cannot be relabeled as new snapshots', () => {
  for (const fetchedAt of [NOW + 6 * 60000, NOW - HOUR - 1, NaN, Infinity]) {
    assert.throws(() => createBriefing(place, { ...forecast, fetchedAt }, alerts, NOW));
  }
  assert.throws(() =>
    createBriefing(place, { ...forecast, current: hour(NOW - 3 * HOUR) }, alerts, NOW),
  );
  assert.throws(() => validateBriefing({ ...pack(), savedAt: NOW + 6 * 60000 }, NOW));
});

test('invalid coordinates, dates, timezones, arrays, and nonfinite weather are rejected', () => {
  const mutate = [
    (p: any) => {
      p.place.latitude = 100;
    },
    (p: any) => {
      p.place.countryCode = 'USA';
    },
    (p: any) => {
      p.place.timezone = 'not/a-zone';
    },
    (p: any) => {
      p.id = 'different-place';
    },
    (p: any) => {
      p.forecast.current.gust = Infinity;
    },
    (p: any) => {
      p.forecast.current.temperature = undefined;
    },
    (p: any) => {
      p.forecast.hours = [];
    },
    (p: any) => {
      p.forecast.hours.reverse();
    },
    (p: any) => {
      p.forecast.hours[0].time = NOW - 2 * HOUR;
    },
    (p: any) => {
      p.forecast.hours[1].probability = 101;
    },
    (p: any) => {
      p.warnings.status = 'safe';
    },
    (p: any) => {
      p.warnings.alerts[0].expires = p.warnings.alerts[0].effective;
    },
    (p: any) => {
      p.warnings.alerts[0].sent = NOW + 6 * 60000;
    },
    (p: any) => {
      p.warnings.fetchedAt = NOW + 6 * 60000;
    },
    (p: any) => {
      p.warnings.alerts.push(p.warnings.alerts[0]);
    },
  ];
  for (const change of mutate) {
    const item = pack();
    change(item);
    assert.throws(() => validateBriefing(item, NOW));
  }
});

test('unexpected prototypes and prototype pollution keys are rejected', () => {
  assert.throws(() =>
    validateBriefing(Object.assign(Object.create({ inherited: true }), pack()), NOW),
  );
  const raw = encoded().replace('"version":1', '"version":1,"__proto__":{"polluted":true}');
  const state = loadBriefings(storage(raw), NOW);
  assert.ok(state.error);
  assert.deepEqual(state.briefings, []);
  const item = pack();
  (item.place as any).constructor = 'bad';
  assert.throws(() => validateBriefing(item, NOW));
  assert.equal(({} as any).polluted, undefined);
});

test('source links cannot execute script or lead to arbitrary sites', () => {
  for (const bad of [
    'javascript:alert(1)',
    'https://weather.gov.evil.example/a',
    'https://evil.example',
    'https://user:pass@weather.gov/',
    'http://weather.gov/',
  ]) {
    const item = pack();
    item.warnings.alerts[0].url = bad;
    assert.throws(() => validateBriefing(item, NOW), bad);
    const other = pack();
    other.warnings.officialUrl = bad;
    assert.throws(() => validateBriefing(other, NOW), bad);
  }
  const item = pack();
  item.warnings.alerts[0].url = 'https://forecast.weather.gov/MapClick.php?lat=25&lon=-80';
  assert.ok(validateBriefing(item, NOW));
});

test('briefing storage retains three most-recent places and replaces a location in place', () => {
  const disk = storage();
  for (let i = 0; i < 4; i++) {
    const item = createBriefing(
      { ...place, latitude: i, name: `Place ${i}` },
      forecast,
      alerts,
      NOW,
    );
    assert.equal(saveBriefing(disk, item, NOW).error, null);
  }
  assert.deepEqual(
    loadBriefings(disk, NOW).briefings.map((b) => b.place.name),
    ['Place 3', 'Place 2', 'Place 1'],
  );
  const updated = createBriefing(
    { ...place, latitude: 2, name: 'Updated place' },
    forecast,
    alerts,
    NOW,
  );
  const next = saveBriefing(disk, updated, NOW);
  assert.equal(next.briefings.length, 3);
  assert.equal(next.briefings[0].place.name, 'Updated place');
});

test('save does not overwrite corrupted, unknown-version or oversized stored data', () => {
  for (const raw of [
    '{bad',
    '{}',
    '{"version":2,"briefings":[]}',
    'x'.repeat(MAX_BRIEFING_BYTES + 1),
    encoded([pack(), pack()]),
  ]) {
    const disk = storage(raw);
    assert.ok(saveBriefing(disk, pack(), NOW).error);
    assert.equal(disk.getItem(OFFLINE_PACK_KEY), raw);
  }
});

test('storage byte limit includes multibyte warning text and preserves prior snapshots on overflow', () => {
  const multibyte = '漢'.repeat(Math.ceil(MAX_BRIEFING_BYTES / 3) + 1);
  assert.ok(multibyte.length < MAX_BRIEFING_BYTES);
  assert.ok(loadBriefings(storage(multibyte), NOW).error);
  const manyWarnings = {
    ...alerts,
    alerts: Array.from({ length: 5 }, (_, i) => ({
      ...alerts.alerts[0],
      id: `long-${i}`,
      description: '漢'.repeat(20000),
      instruction: '漢'.repeat(20000),
    })),
  };
  const disk = storage();
  const first = createBriefing(place, forecast, manyWarnings, NOW);
  assert.equal(saveBriefing(disk, first, NOW).error, null);
  const original = disk.getItem(OFFLINE_PACK_KEY);
  const second = createBriefing({ ...place, latitude: 2 }, forecast, manyWarnings, NOW);
  const result = saveBriefing(disk, second, NOW);
  assert.match(result.error || '', /too large/);
  assert.equal(result.briefings.length, 1);
  assert.equal(result.briefings[0].id, first.id);
  assert.equal(disk.getItem(OFFLINE_PACK_KEY), original);
});

test('quota and blocked storage errors preserve the prior list and never report a successful save', () => {
  const disk = storage(encoded());
  const full: StorageAccess = {
    ...disk,
    setItem() {
      throw new DOMException('Quota exceeded');
    },
  };
  const next = createBriefing({ ...place, latitude: 2 }, forecast, alerts, NOW);
  const result = saveBriefing(full, next, NOW);
  assert.ok(result.error);
  assert.equal(result.briefings.length, 1);
  assert.equal(result.briefings[0].id, pack().id);
  assert.equal(disk.getItem(OFFLINE_PACK_KEY), encoded());
  const blocked: StorageAccess = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  assert.ok(loadBriefings(blocked, NOW).error);
  assert.ok(saveBriefing(blocked, pack(), NOW).error);
  assert.ok(clearBriefings(blocked).error);
});

test('removal and explicit clearing touch only the briefing storage key', () => {
  const disk = storage(encoded());
  disk.setItem('unrelated-key', 'retained');
  assert.equal(removeBriefing(disk, pack().id, NOW).briefings.length, 0);
  assert.equal(disk.getItem('unrelated-key'), 'retained');
  saveBriefing(disk, pack(), NOW);
  assert.equal(clearBriefings(disk).error, null);
  assert.equal(disk.getItem(OFFLINE_PACK_KEY), null);
  assert.equal(disk.getItem('unrelated-key'), 'retained');
});

test('text export includes original source times, location, warning instructions and no current-status claim', () => {
  const text = briefingText(pack(), NOW + 1000);
  assert.match(text, /25.7743, -80.1937/);
  assert.match(text, /Forecast retrieved: 2026-11-01 03:00:00 UTC/);
  assert.match(text, /SAVED COPY; CURRENT STATUS UNKNOWN/);
  assert.match(text, /Do not enter floodwater/);
  assert.match(text, /Stated expiry/);
  assert.match(text, /internet required/);
  assert.doesNotMatch(text, /ACTIVE ALERT|ALL CLEAR/);
});
