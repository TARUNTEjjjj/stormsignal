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

test('India and global official warnings round-trip with scope and incomplete-feed limitations', () => {
  const fixtures = [
    {
      place: {
        ...place,
        name: 'Chennai',
        country: 'India',
        countryCode: 'IN',
        latitude: 13,
        longitude: 80,
      },
      url: 'https://sachet.ndma.gov.in/',
      source: 'NDMA Sachet',
      scope: 'region' as const,
      scopeLabel: 'Tamil Nadu',
    },
    {
      place: {
        ...place,
        name: 'Paris',
        country: 'France',
        countryCode: 'FR',
        latitude: 48.85,
        longitude: 2.35,
      },
      url: 'https://severeweather.wmo.int/',
      source: 'WMO severe weather feed',
      scope: 'country' as const,
      scopeLabel: 'France',
    },
  ];
  const disk = storage();
  for (const fixture of fixtures) {
    const input = {
      ...alerts,
      source: fixture.source,
      officialUrl: fixture.url,
      coverage: 'Regional bulletins; incomplete feed. Not an exact point match or an all-clear.',
      partial: true,
      scope: fixture.scope,
      scopeLabel: fixture.scopeLabel,
      feedUpdatedAt: NOW - 24 * HOUR,
      alerts: [{ ...alerts.alerts[0], source: fixture.source, url: fixture.url }],
    };
    const item = createBriefing(fixture.place, forecast, input, NOW);
    assert.equal(item.warnings.status, 'available');
    assert.equal(item.warnings.partial, true);
    assert.equal(item.warnings.scope, fixture.scope);
    assert.equal(item.warnings.scopeLabel, fixture.scopeLabel);
    assert.equal(item.warnings.feedUpdatedAt, NOW - 24 * HOUR);
    assert.equal(item.warnings.fetchedAt, NOW);
    assert.equal(item.warnings.alerts[0].url, fixture.url);
    assert.equal(saveBriefing(disk, item, NOW).error, null);
    const reloaded = loadBriefings(disk, NOW + 10 * 86400000).briefings.find(
      (b) => b.id === item.id,
    );
    assert.deepEqual(reloaded, item);
    const exported = briefingText(reloaded!, NOW + 10 * 86400000);
    assert.match(exported, /NOT LIVE/);
    assert.match(exported, /Incomplete warning feed at save/);
    assert.match(exported, /Warning scope saved: (REGION|COUNTRY)/);
    assert.match(exported, /Authority feed update time saved: 2026-10-31 03:00:00 UTC/);
    assert.match(exported, /Warning feed retrieved: 2026-11-01 03:00:00 UTC/);
    assert.match(exported, /Do not enter floodwater/);
  }
});

test('old packs remain readable without inventing optional warning metadata', () => {
  const original = pack();
  const item = loadBriefings(storage(encoded([original])), NOW + HOUR).briefings[0];
  assert.deepEqual(item, original);
  for (const key of ['partial', 'scope', 'scopeLabel', 'feedUpdatedAt'])
    assert.equal(Object.hasOwn(item.warnings, key), false);
  assert.doesNotMatch(briefingText(item, NOW + HOUR), /Authority feed update time saved/);
});

test('explicit unknown feed times and complete point metadata are preserved without new timestamps', () => {
  const input = { ...alerts, partial: false, scope: 'point' as const, feedUpdatedAt: null };
  const item = createBriefing(place, forecast, input, NOW);
  assert.equal(item.warnings.partial, false);
  assert.equal(item.warnings.scope, 'point');
  assert.equal(item.warnings.feedUpdatedAt, null);
  assert.match(briefingText(item, NOW + HOUR), /Authority feed update time was not available/);
  assert.doesNotMatch(briefingText(item, NOW + HOUR), /Incomplete warning feed at save/);
});

test('optional coverage metadata rejects malformed scope and falsely future source timestamps', () => {
  for (const [key, value] of [
    ['partial', 'false'],
    ['scope', 'world'],
    ['scope', null],
    ['scopeLabel', ''],
    ['scopeLabel', 'x'.repeat(401)],
    ['feedUpdatedAt', NOW + 300001],
    ['feedUpdatedAt', 'today'],
    ['feedUpdatedAt', NaN],
  ] as const) {
    const item = pack();
    Object.assign(item.warnings, { [key]: value });
    assert.throws(() => validateBriefing(item, NOW), key);
  }
});

test('global available coverage still requires a real retrieval time', () => {
  const item = pack();
  item.place.countryCode = 'FR';
  item.warnings.fetchedAt = null;
  assert.throws(() => validateBriefing(item, NOW), /Invalid automatic coverage/);
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
    'https://sachet.ndma.gov.in.evil.example/',
    'https://user:pass@sachet.ndma.gov.in/',
    'https://sachet.ndma.gov.in:8443/',
    'http://sachet.ndma.gov.in/',
    'https://subdomain.sachet.ndma.gov.in/',
    'https://severeweather.wmo.int.evil.example/',
    'https://evil.noaa.gov.evil.example/',
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

test('approved NOAA and official global URLs survive both live snapshot creation and loading', () => {
  for (const url of [
    'https://noaa.gov/',
    'https://www.nhc.noaa.gov/',
    'https://sachet.ndma.gov.in/',
    'https://severeweather.wmo.int/',
  ]) {
    const input = { ...alerts, officialUrl: url, alerts: [{ ...alerts.alerts[0], url }] };
    const item = createBriefing(place, forecast, input, NOW);
    const reloaded = loadBriefings(storage(encoded([item])), NOW).briefings[0];
    assert.equal(reloaded.warnings.officialUrl, url);
    assert.equal(reloaded.warnings.alerts[0].url, url);
  }
});

test('direct PAGASA and BMKG source bulletins survive historical snapshot round trips', () => {
  for (const fixture of [
    {
      code: 'PH',
      name: 'Manila',
      official: 'https://pagasa.dost.gov.ph/regional-forecast/ncrprsd',
      bulletin:
        'https://publicalert.pagasa.dost.gov.ph/output/gfa/12345678-1234-1234-1234-123456789abc.cap',
    },
    {
      code: 'ID',
      name: 'Jakarta',
      official: 'https://www.bmkg.go.id/peringatan-dini',
      bulletin: 'https://www.bmkg.go.id/alerts/nowcast/en/ABC123_alert.xml',
    },
  ]) {
    const input = {
      ...alerts,
      partial: true,
      scope: 'point' as const,
      scopeLabel: fixture.name,
      source: 'Direct authority + WMO SWIC',
      coverage: 'Direct and supplementary coverage remains incomplete.',
      officialUrl: fixture.official,
      alerts: [{ ...alerts.alerts[0], url: fixture.bulletin }],
    };
    const item = createBriefing(
      { ...place, countryCode: fixture.code, name: fixture.name },
      forecast,
      input,
      NOW,
    );
    const reloaded = loadBriefings(storage(encoded([item])), NOW).briefings[0];
    assert.equal(reloaded.warnings.officialUrl, fixture.official);
    assert.equal(reloaded.warnings.alerts[0].url, fixture.bulletin);
    assert.equal(reloaded.warnings.partial, true);
    assert.match(briefingText(reloaded, NOW), /CURRENT STATUS UNKNOWN/);
  }
});

test('direct-authority snapshot URLs reject lookalikes, credentials and unapproved subdomains', () => {
  for (const url of [
    'https://publicalert.pagasa.dost.gov.ph.evil.example/',
    'https://www.bmkg.go.id.evil.example/',
    'https://user:password@www.bmkg.go.id/',
    'http://publicalert.pagasa.dost.gov.ph/',
    'https://other.pagasa.dost.gov.ph/',
    'https://www.bmkg.go.id:8443/',
  ]) {
    const item = pack();
    item.warnings.alerts[0].url = url;
    assert.throws(() => validateBriefing(item, NOW), url);
  }
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
