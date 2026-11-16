import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFLINE_PACK_KEY,
  MAX_BRIEFING_BYTES,
  createBriefing,
  briefingId,
  validateBriefing,
  loadBriefings,
  saveBriefing,
  removeBriefing,
  clearBriefings,
  briefingText,
  officialBriefingUrl,
  pastStatedExpiry,
  savedClockNote,
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
  for (const [key, value, reason] of [
    ['partial', 'false', /Invalid partial coverage/],
    ['scope', 'world', /Invalid warning scope/],
    ['scope', null, /Invalid warning scope/],
    ['scopeLabel', '', /Invalid text/],
    ['scopeLabel', 'x'.repeat(401), /Invalid text/],
    ['feedUpdatedAt', NOW + 300001, /Invalid feed update time/],
    ['feedUpdatedAt', 'today', /Invalid timestamp/],
    ['feedUpdatedAt', NaN, /Invalid timestamp/],
  ] as const) {
    const item = pack();
    Object.assign(item.warnings, { [key]: value });
    assert.throws(() => validateBriefing(item, NOW), reason, key);
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

test('saved briefings stay readable, removable and downloadable after the device clock is set back', () => {
  const disk = storage();
  // Miami is saved with a correct clock, a second place while the clock ran 30 minutes fast.
  const fast = NOW + 30 * 60000;
  const ahead = createBriefing(
    { ...place, name: 'Fort Lauderdale', latitude: 26.1224 },
    { ...forecast, fetchedAt: fast, current: hour(fast) },
    { ...alerts, fetchedAt: fast },
    fast,
  );
  assert.equal(saveBriefing(disk, pack(), NOW).error, null);
  assert.equal(saveBriefing(disk, ahead, fast).error, null);
  // Network time corrects the clock, or it resets after the battery runs out.
  for (const clock of [NOW + 2 * 60000, NOW - 10 * 60000, Date.UTC(2026, 2, 1), 86400000]) {
    const loaded = loadBriefings(disk, clock);
    assert.equal(loaded.error, null, new Date(clock).toISOString());
    assert.deepEqual(loaded.briefings, [ahead, pack()]);
    assert.match(briefingText(loaded.briefings[1], clock), /Do not enter floodwater/);
  }
  // Saving and removing still work, and keep the stored briefings.
  const earlier = NOW - 10 * 60000;
  const next = createBriefing(
    { ...place, name: 'Key West', latitude: 24.5551 },
    { ...forecast, fetchedAt: earlier, current: hour(earlier) },
    { ...alerts, fetchedAt: earlier },
    earlier,
  );
  assert.deepEqual(
    saveBriefing(disk, next, earlier).briefings.map((b) => b.place.name),
    ['Key West', 'Fort Lauderdale', 'Miami'],
  );
  const removed = removeBriefing(disk, ahead.id, earlier);
  assert.equal(removed.error, null);
  assert.deepEqual(
    loadBriefings(disk, earlier).briefings.map((b) => b.place.name),
    ['Key West', 'Miami'],
  );
  // A new briefing still needs a plausible device clock.
  assert.throws(() => createBriefing(place, forecast, alerts, 86400000));
});

test('a briefing saved on a device whose clock runs slow or fast keeps a just-issued bulletin', () => {
  const MINUTE = 60_000;
  const manila: Place = {
    id: 'manila',
    name: 'Manila',
    country: 'Philippines',
    countryCode: 'PH',
    latitude: 14.6042,
    longitude: 120.9822,
    timezone: 'Asia/Manila',
  };
  // NOW is the gateway's clock; the device reads NOW + skew. The feed and its bulletin are `issued`
  // ms old, and the check itself arrived a second ago.
  const check = (skew: number, issued: number): AlertResult => ({
    status: 'available',
    fetchedAt: NOW + skew - 1_000,
    source: 'PAGASA direct + WMO SWIC',
    coverage: 'Incomplete coverage; an empty list is not an all-clear.',
    officialUrl: 'https://www.pagasa.dost.gov.ph/',
    scope: 'point',
    scopeLabel: 'Manila',
    partial: true,
    feedUpdatedAt: NOW - issued,
    clockOffset: skew,
    alerts: [
      {
        ...alerts.alerts[0],
        id: 'pagasa:rainfall:0',
        sent: NOW - issued,
        effective: NOW - issued,
        expires: NOW + 3 * HOUR,
        url: 'https://publicalert.pagasa.dost.gov.ph/output/gfa/00000000-0000-4000-8000-000000000001.cap',
      },
    ],
  });
  const local = (skew: number): Forecast => ({
    ...forecast,
    fetchedAt: NOW + skew,
    current: hour(NOW),
  });
  for (const [skew, issued] of [
    [-10 * MINUTE, MINUTE],
    [-60 * MINUTE, 20 * MINUTE],
    [30 * MINUTE, MINUTE],
    [0, MINUTE],
  ]) {
    const note = `device ${skew / MINUTE} min, issued ${issued / MINUTE} min ago`;
    const device = NOW + skew;
    const item = createBriefing(manila, local(skew), check(skew, issued), device);
    assert.equal(item.savedAt, device, note);
    assert.equal(item.warnings.status, 'available', note);
    assert.equal(item.warnings.alerts[0].sent, NOW - issued, note);
    assert.equal(item.warnings.feedUpdatedAt, NOW - issued, note);
    assert.equal(item.warnings.clockOffset, skew, note);
    // It is stored, and read back whatever the device clock shows later.
    const disk = storage();
    assert.equal(saveBriefing(disk, item, device).error, null, note);
    for (const later of [device, NOW, NOW + 30 * 86_400_000]) {
      const loaded = loadBriefings(disk, later);
      assert.equal(loaded.error, null, note);
      assert.deepEqual(loaded.briefings, [item], note);
    }
    const exported = briefingText(item, device);
    assert.match(exported, /Do not enter floodwater/, note);
    // Device-clock and authority times differ visibly, so the copy says which is which.
    assert.equal(/the device clock was about \d+ minutes/.test(exported), skew !== 0, note);
  }
  assert.match(
    savedClockNote(createBriefing(manila, local(-600_000), check(-600_000, MINUTE), NOW - 600_000)),
    /^When this was saved, the device clock was about 10 minutes behind the warning service’s clock\./,
  );
  // Authority times are still checked, on the gateway's clock: none may be later than the save.
  const slow = -10 * MINUTE;
  for (const issued of [-5 * MINUTE - 1, -HOUR])
    assert.throws(
      () => createBriefing(manila, local(slow), check(slow, issued), NOW + slow),
      /Invalid feed update time|Invalid warning timing/,
    );
  const late = check(slow, MINUTE);
  late.alerts[0].sent = NOW + 5 * MINUTE + 1;
  assert.throws(
    () => createBriefing(manila, local(slow), late, NOW + slow),
    /Invalid warning timing/,
  );
  // Without a stated service clock the device clock is the reference, as before.
  const direct = { ...check(slow, MINUTE), clockOffset: undefined };
  assert.throws(() => createBriefing(manila, local(slow), direct, NOW + slow));
  // A stored offset is bounded metadata; anything else is unreadable.
  for (const offset of [0.5, NaN, Infinity, '600000', null, 4e12, -4e12]) {
    const item = createBriefing(manila, local(0), check(0, MINUTE), NOW);
    Object.assign(item.warnings, { clockOffset: offset });
    assert.throws(() => validateBriefing(item, NOW, true), /Invalid clock offset/, String(offset));
  }
  // A saved warning is called past its stated expiry only once both the device clock and the
  // service's clock have passed it. Saved on a device an hour fast, with 30 minutes left:
  const fast = 60 * MINUTE;
  const ending = check(fast, MINUTE);
  ending.alerts[0].expires = NOW + 30 * MINUTE;
  const saved = createBriefing(manila, local(fast), ending, NOW + fast);
  const past = (device: number) => /PAST STATED EXPIRY/.test(briefingText(saved, device));
  // The device clock still runs an hour fast: the copy is not called expired before the warning ends.
  assert.equal(past(NOW + fast), false);
  assert.equal(past(NOW + fast + 30 * MINUTE - 1), false);
  assert.equal(past(NOW + fast + 30 * MINUTE), true);
  // The device clock was corrected after the save: the copy stays "status unknown" a while longer.
  assert.equal(past(NOW + 30 * MINUTE), false);
  assert.equal(pastStatedExpiry(saved, saved.warnings.alerts[0], NOW + fast - 1), false);
  assert.equal(pastStatedExpiry(saved, saved.warnings.alerts[0], NOW + fast + 30 * MINUTE), true);
  // Without a measured offset (older briefings, checks that state no clock) the device clock
  // decides, as before.
  const plain = pack();
  assert.equal(pastStatedExpiry(plain, plain.warnings.alerts[0], NOW + HOUR - 1), false);
  assert.equal(pastStatedExpiry(plain, plain.warnings.alerts[0], NOW + HOUR), true);
});

test('invalid coordinates, dates, timezones, arrays, and nonfinite weather are rejected', () => {
  // Each change breaks one thing, and the reason is checked. A changed coordinate keeps an identity
  // that matches it, so only the coordinate range can reject it.
  const mutate: [(p: any) => void, RegExp][] = [
    [
      (p) => {
        p.place.latitude = 100;
        p.id = briefingId(p.place);
      },
      /Invalid weather value/,
    ],
    [
      (p) => {
        p.place.longitude = 181;
        p.id = briefingId(p.place);
      },
      /Invalid weather value/,
    ],
    [
      (p) => {
        p.place.countryCode = 'USA';
      },
      /Invalid text/,
    ],
    [
      (p) => {
        p.place.timezone = 'not/a-zone';
      },
      /Invalid time zone/,
    ],
    [
      (p) => {
        p.id = 'different-place';
      },
      /Invalid briefing identity/,
    ],
    [
      (p) => {
        p.forecast.current.gust = Infinity;
      },
      /Invalid weather value/,
    ],
    [
      (p) => {
        p.forecast.current.temperature = undefined;
      },
      /Invalid weather value/,
    ],
    [
      (p) => {
        p.forecast.hours = [];
      },
      /Invalid hourly sample/,
    ],
    [
      (p) => {
        p.forecast.hours.reverse();
      },
      /Invalid forecast sequence/,
    ],
    [
      (p) => {
        p.forecast.hours[0].time = NOW - 2 * HOUR;
      },
      /Invalid forecast sequence/,
    ],
    [
      (p) => {
        p.forecast.hours[1].probability = 101;
      },
      /Invalid weather value/,
    ],
    [
      (p) => {
        p.warnings.status = 'safe';
      },
      /Invalid warning coverage/,
    ],
    [
      (p) => {
        p.warnings.alerts[0].expires = p.warnings.alerts[0].effective;
      },
      /Invalid warning timing/,
    ],
    [
      (p) => {
        p.warnings.alerts[0].sent = NOW + 6 * 60000;
      },
      /Invalid warning timing/,
    ],
    [
      (p) => {
        p.warnings.fetchedAt = NOW + 6 * 60000;
      },
      /Invalid warning retrieval time/,
    ],
    [
      (p) => {
        p.warnings.alerts.push(p.warnings.alerts[0]);
      },
      /Duplicate warning/,
    ],
  ];
  for (const [change, reason] of mutate) {
    const item = pack();
    change(item);
    assert.throws(() => validateBriefing(item, NOW), reason, String(change));
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
    'https://evilweather.gov/alert',
    'https://notnoaa.gov/',
  ]) {
    const item = pack();
    item.warnings.alerts[0].url = bad;
    assert.throws(() => validateBriefing(item, NOW), /Invalid source URL/, bad);
    const other = pack();
    other.warnings.officialUrl = bad;
    assert.throws(() => validateBriefing(other, NOW), /Invalid source URL/, bad);
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
    assert.throws(() => validateBriefing(item, NOW), /Invalid source URL/, url);
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

test('text export calls each hourly amount precipitation, since it includes snow', () => {
  // Open-Meteo's precipitation and its probability cover rain, showers and snow as liquid water.
  const text = briefingText(pack(), NOW + 1000);
  assert.match(text, /^Saved hourly forecast \(each precipitation value is for one hour\):$/m);
  assert.match(
    text,
    /^2026-11-01 03:00:00 UTC: 25 °C; feels like 27 °C; precipitation 0 mm; chance 20%; gust 25 km\/h$/m,
  );
  assert.doesNotMatch(text, /\brain/i);
});

test('text export prints whole-second UTC times when real clocks carry milliseconds', () => {
  const saved = NOW + 123;
  const item = createBriefing(
    place,
    { ...forecast, fetchedAt: saved - 456, current: hour(saved - 1000) },
    { ...alerts, fetchedAt: saved - 789 },
    saved,
  );
  const text = briefingText(item, saved + 5000);
  assert.match(text, /Saved: 2026-11-01 03:00:00 UTC \| Exported: 2026-11-01 03:00:05 UTC/);
  assert.match(text, /Forecast retrieved: 2026-11-01 02:59:59 UTC/);
  assert.match(text, /Warning feed retrieved: 2026-11-01 02:59:59 UTC/);
  assert.doesNotMatch(text, /\d{2}:\d{2}:\d{2}\.\d+Z/);
});
