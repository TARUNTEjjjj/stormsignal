import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  alertOutline,
  clearRequestCache,
  WeatherDataError,
  fetchAirQuality,
  fetchAlerts,
  fetchForecast,
  fetchCompactForecast,
  fetchModels,
  searchPlaces,
  weatherLabel,
} from '../src/data';
import { alertCheckIsRecent, unexpiredAlerts } from '../src/connectivity';
import { briefingText, createBriefing } from '../src/offline';
import { clockNotice } from '../src/presentation';
import { deriveHazards, getOutlook, FORECAST_STALE_MS } from '../src/risk';
import { capAreaGeometry } from '../server/global';
import type { Place } from '../src/types';

const place: Place = {
  id: 'chennai',
  name: 'Chennai',
  country: 'India',
  countryCode: 'IN',
  latitude: 13.08,
  longitude: 80.27,
};
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
beforeEach(() => clearRequestCache());
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  clearRequestCache();
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const sec = () => Math.floor(Date.now() / 1000);
function forecastPayload() {
  const time = sec();
  return {
    timezone: 'Asia/Kolkata',
    current: { time, temperature_2m: 28, precipitation: 0, weather_code: 0 },
    hourly: {
      time: [time, time + 3600],
      temperature_2m: [28, null],
      precipitation: [0, null],
      precipitation_probability: [0, 80],
    },
    daily: {
      time: [time],
      temperature_2m_max: [31],
      temperature_2m_min: [24],
      sunrise: [time - 3600],
      sunset: [time + 3600],
    },
  };
}
function alert(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'https://api.weather.gov/alerts/test',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-81, 25],
          [-80, 25],
          [-80, 26],
          [-81, 25],
        ],
      ],
    },
    properties: {
      id: 'https://api.weather.gov/alerts/test',
      status: 'Actual',
      messageType: 'Alert',
      headline: 'Test headline',
      event: 'Flood Warning',
      severity: 'Severe',
      sent: new Date(now - 60_000).toISOString(),
      effective: new Date(now - 30_000).toISOString(),
      expires: new Date(now + 3_600_000).toISOString(),
      description: 'Test description',
      instruction: 'Official instruction text',
      ...overrides,
    },
  };
}

test('forecast converts UTC epoch seconds to milliseconds and preserves absent values', async () => {
  globalThis.fetch = async (target) => {
    const requested = new URL(String(target));
    assert.equal(requested.searchParams.get('timeformat'), 'unixtime');
    assert.equal(requested.searchParams.get('timezone'), 'auto');
    assert.equal(requested.searchParams.get('forecast_days'), '7');
    return json(forecastPayload());
  };
  const f = await fetchForecast(place);
  assert.ok(f.current.time > 1e12);
  assert.equal(f.current.temperature, 28);
  assert.equal(f.current.precipitation, 0);
  assert.equal(f.current.wind, null);
  assert.equal(f.hours[1].temperature, null);
  assert.equal(f.hours[1].precipitation, null);
  assert.equal(f.hours[1].probability, 80);
  assert.equal(f.timezone, 'Asia/Kolkata');
  assert.ok(f.days[0].sunrise! > 1e12);
});

test('cache keeps original retrieval time instead of making cached data appear fresh', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json(forecastPayload());
  };
  const a = await fetchForecast(place);
  const b = await fetchForecast(place);
  assert.equal(calls, 1);
  assert.equal(a.fetchedAt, b.fetchedAt);
});

test('data saver requests only the next 24 hours and current conditions without daily payload', async () => {
  globalThis.fetch = async (target) => {
    const params = new URL(String(target)).searchParams;
    // 24 hours, and three steps for a window that starts early and is used for up to an hour.
    assert.equal(params.get('forecast_hours'), '27');
    assert.equal(params.has('forecast_days'), false);
    assert.equal(params.has('daily'), false);
    assert.ok(params.get('current')?.includes('wind_gusts_10m'));
    const { daily, ...compact } = forecastPayload();
    return json(compact);
  };
  const result = await fetchCompactForecast(place);
  assert.equal(result.current.temperature, 28);
  assert.equal(result.hours[1].precipitation, null);
  assert.deepEqual(result.days, []);
});

test('compact and full forecasts do not share a truncated cached response', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (target) => {
    calls.push(String(target));
    return json(forecastPayload());
  };
  await fetchCompactForecast(place);
  await fetchForecast(place);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1]);
});

// Open-Meteo starts a `forecast_hours` window at the UTC hour of the request, shifted by the part
// of an hour in the place's UTC offset, so the first steps can already be past. Seen live on 15 and
// 16 November 2026: Chennai (UTC+5:30) at 19:55Z from 18:30Z, Jakarta (UTC+7) at 02:34Z from
// 02:00Z, Kathmandu (UTC+5:45) at 02:45Z from 01:15Z, and St. John's (UTC-3:30) at 02:45Z from
// 02:30Z and at 03:00Z from 03:30Z.
const HOUR = 3_600_000;
const windowStart = (requested: number, offsetMinutes: number) =>
  Math.floor(requested / HOUR) * HOUR - (offsetMinutes % 60) * 60_000;
/** Answer a `forecast_hours` request as the provider does for a place at this UTC offset. */
function hourlyWindow(target: unknown, offsetMinutes: number, rainAt?: number) {
  const start = windowStart(Date.now(), offsetMinutes) / 1000;
  const time = Array.from(
    { length: Number(new URL(String(target)).searchParams.get('forecast_hours')) },
    (_, i) => start + i * 3600,
  );
  return json({
    timezone: 'UTC',
    current: { time: sec(), temperature_2m: 28 },
    hourly: {
      time,
      temperature_2m: time.map(() => 28),
      precipitation: time.map((t) => (t * 1000 === rainAt ? 20 : 0)),
      wind_speed_10m: time.map(() => 9),
    },
  });
}
const UTC_OFFSET_MINUTES = [330, 420, 345, -210];
const requestTimes = Array.from(
  { length: 60 },
  (_, minute) => Date.parse('2026-11-16T02:00:00Z') + minute * 60_000,
);

test('data saver forecast holds every hourly step of the next 24 hours while it is current', async () => {
  for (const [requested, offset, start] of [
    ['2026-11-15T19:55:00Z', 330, '2026-11-15T18:30:00Z'],
    ['2026-11-16T02:34:47Z', 420, '2026-11-16T02:00:00Z'],
    ['2026-11-16T02:45:03Z', 345, '2026-11-16T01:15:00Z'],
    ['2026-11-16T02:45:04Z', -210, '2026-11-16T02:30:00Z'],
    ['2026-11-16T03:00:00Z', -210, '2026-11-16T03:30:00Z'],
  ] as const)
    assert.equal(windowStart(Date.parse(requested), offset), Date.parse(start));
  for (const offset of UTC_OFFSET_MINUTES) {
    for (const fetched of requestTimes) {
      clearRequestCache();
      Date.now = () => fetched;
      globalThis.fetch = async (target) => hourlyWindow(target, offset);
      const times = new Set((await fetchCompactForecast(place)).hours.map((h) => h.time));
      // Signals screen [now, now + 24 h) every minute, until the forecast is an hour old.
      for (let now = fetched; now <= fetched + FORECAST_STALE_MS; now += 60_000)
        for (let step = windowStart(fetched, offset); step < now + 24 * HOUR; step += HOUR)
          if (step >= now && !times.has(step))
            assert.fail(
              `UTC offset ${offset} min, fetched ${new Date(fetched).toISOString()}, ` +
                `${(now - fetched) / 60_000} min old: no step at ${new Date(step).toISOString()}`,
            );
    }
  }
  // The live Chennai case: heavy rain in the last hour of the window is a signal in Data saver too.
  const fetched = Date.parse('2026-11-15T19:55:00Z');
  const lastStep = Date.parse('2026-11-16T19:30:00Z');
  clearRequestCache();
  Date.now = () => fetched;
  globalThis.fetch = async (target) => hourlyWindow(target, 330, lastStep);
  const forecast = await fetchCompactForecast(place);
  assert.deepEqual(
    deriveHazards(forecast, fetched).map((h) => [h.kind, h.level, h.time]),
    [['rain', 'high', lastStep]],
  );
  assert.equal(getOutlook(forecast.hours, fetched).level, 'high');
});

test('comparison models reach the final hour of the 72-hour explorer', async () => {
  for (const offset of UTC_OFFSET_MINUTES) {
    for (const fetched of requestTimes) {
      clearRequestCache();
      Date.now = () => fetched;
      globalThis.fetch = async (target) => hourlyWindow(target, offset);
      const models = await fetchModels(place);
      assert.equal(models.length, 2);
      for (const model of models) {
        const times = new Set(model.hours.map((h) => h.time));
        // The explorer plots 72 hourly steps from the first forecast step at most 30 minutes old. A
        // model response is used for about 45 minutes (30-minute cache, 15-minute refresh); an hour
        // is checked, as for the forecast.
        for (let now = fetched; now <= fetched + HOUR; now += 60_000) {
          let first = windowStart(fetched, offset) - HOUR;
          while (first < now - 30 * 60_000) first += HOUR;
          if (!times.has(first + 71 * HOUR))
            assert.fail(
              `${model.name}, UTC offset ${offset} min, fetched ${new Date(fetched).toISOString()}, ` +
                `${(now - fetched) / 60_000} min old: no reading at ${new Date(first + 71 * HOUR).toISOString()}`,
            );
        }
      }
    }
  }
});

test('unknown weather code and absent code are not displayed as clear weather', () => {
  assert.equal(weatherLabel(null), 'Conditions unavailable');
  assert.equal(weatherLabel(undefined), 'Conditions unavailable');
  assert.equal(weatherLabel(1234), 'Conditions unavailable');
  assert.equal(weatherLabel(0), 'Clear sky');
  assert.equal(weatherLabel(99), 'Thunderstorm');
});

test('geocoding validates coordinates and keeps API country metadata', async () => {
  globalThis.fetch = async (target) => {
    assert.equal(new URL(String(target)).searchParams.get('name'), 'Chennai');
    return json({
      results: [
        {
          id: 1,
          name: 'Chennai',
          latitude: 13.08,
          longitude: 80.27,
          country: 'India',
          country_code: 'IN',
          admin1: 'Tamil Nadu',
          timezone: 'Asia/Kolkata',
        },
        { name: 'bad', latitude: 500, longitude: 20 },
      ],
    });
  };
  const results = await searchPlaces('  Chennai  ');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, '1');
  assert.equal(results[0].countryCode, 'IN');
});

test('empty and single-character search does not call provider', async () => {
  globalThis.fetch = async () => {
    throw Error('Should not call');
  };
  assert.deepEqual(await searchPlaces('a'), []);
  assert.deepEqual(await searchPlaces(' '), []);
});

test('malformed forecast and invalid coordinate are rejected', async () => {
  globalThis.fetch = async () => json({ hourly: { time: [] } });
  await assert.rejects(fetchForecast(place), /incomplete/);
  await assert.rejects(fetchForecast({ ...place, latitude: NaN }), /invalid coordinates/);
  // A coordinate off the globe is refused on its own, before any provider is asked.
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return json(forecastPayload());
  };
  for (const coordinates of [
    { latitude: 91 },
    { latitude: -91 },
    { longitude: 181 },
    { longitude: -181 },
  ]) {
    const note = JSON.stringify(coordinates);
    await assert.rejects(fetchForecast({ ...place, ...coordinates }), /invalid coordinates/, note);
    await assert.rejects(fetchAlerts({ ...place, ...coordinates }), /invalid coordinates/, note);
  }
  assert.equal(requests, 0);
  // The poles and the antimeridian are on it.
  await fetchForecast({ ...place, latitude: 90, longitude: -180 });
  assert.equal(requests, 1);
});

test('upstream rate limit is explicit rather than replaced with demo data', async () => {
  globalThis.fetch = async () => json({}, 429);
  await assert.rejects(fetchForecast(place), /provider is busy/);
});

test('oversized and invalid JSON responses are rejected', async () => {
  globalThis.fetch = async () => new Response('{}', { headers: { 'content-length': '3000000' } });
  await assert.rejects(searchPlaces('Chennai'), /too large/);
  globalThis.fetch = async () => new Response('<html>offline</html>');
  await assert.rejects(searchPlaces('Chennai'), /unreadable/);
});

test('aborted callers do not use cached responses', async () => {
  globalThis.fetch = async () => json(forecastPayload());
  await fetchForecast(place);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchForecast(place, controller.signal), { name: 'AbortError' });
});

test('model comparison retains successful model when another fails', async () => {
  globalThis.fetch = async (target) => {
    const params = new URL(String(target)).searchParams;
    assert.equal(params.get('forecast_hours'), '75');
    assert.equal(params.has('forecast_days'), false);
    if (params.get('models') === 'gfs_seamless') return json({}, 503);
    const time = sec();
    return json({
      hourly: {
        time: [time, time + 3600],
        temperature_2m: [20, 21],
        precipitation: [0, null],
        wind_speed_10m: [10, 11],
      },
    });
  };
  const models = await fetchModels(place);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'ecmwf_ifs025');
  assert.equal(models[0].hours[1].precipitation, null);
});

test('model comparison rejects if both providers are unavailable', async () => {
  globalThis.fetch = async () => json({}, 503);
  await assert.rejects(fetchModels(place), /Neither comparison model/);
});

test('air quality carries estimate time and preserves missing pollutant', async () => {
  globalThis.fetch = async () =>
    json({ current: { time: sec(), us_aqi: 50, pm2_5: null, pm10: 13 } });
  const air = await fetchAirQuality(place);
  assert.equal(air.usAqi, 50);
  assert.equal(air.pm25, null);
  assert.equal(air.pm10, 13);
  assert.ok(air.time > 1e12);
});

test('India uses the owned warning API and preserves incomplete regional coverage', async () => {
  globalThis.fetch = async (target) => {
    const params = new URL(String(target), 'https://stormsignal.invalid').searchParams;
    assert.equal(params.get('country'), 'IN');
    assert.equal(params.get('name'), 'Chennai');
    return json({
      status: 'available',
      alerts: [],
      fetchedAt: Date.now(),
      source: 'NDMA SACHET',
      officialUrl: 'https://sachet.ndma.gov.in/',
      scope: 'region',
      scopeLabel: 'Tamil Nadu',
      partial: true,
      feedUpdatedAt: Date.now() - 86400000,
      coverage: 'Regional feed is incomplete; missing warnings do not mean safe conditions.',
    });
  };
  const result = await fetchAlerts(place);
  assert.equal(result.status, 'available');
  assert.equal(result.officialUrl, 'https://sachet.ndma.gov.in/');
  assert.equal(result.scope, 'region');
  assert.equal(result.partial, true);
  assert.match(result.coverage, /missing warnings do not mean safe/);
});

test('international warnings keep the original server check time across client cache hits', async () => {
  const checked = Date.now() - 30_000;
  globalThis.fetch = async () =>
    json({
      status: 'available',
      alerts: [],
      fetchedAt: checked,
      source: 'WMO SWIC',
      officialUrl: 'https://severeweather.wmo.int/',
      scope: 'point',
      scopeLabel: 'Tokyo',
      partial: true,
      coverage: 'Participating sources only.',
    });
  const first = await fetchAlerts({ ...place, countryCode: 'JP' });
  const second = await fetchAlerts({ ...place, countryCode: 'JP' });
  assert.equal(first.fetchedAt, checked);
  assert.equal(second.fetchedAt, checked);
});

test('alert checks one minute apart reach the network again after a slow response', async () => {
  let now = Date.now();
  Date.now = () => now;
  for (const target of [{ ...place, countryCode: 'US' }, place]) {
    clearRequestCache();
    let calls = 0;
    globalThis.fetch = async (input) => {
      calls++;
      now += 400; // the response arrives after a short network delay
      if (!String(input).startsWith('/api/alerts')) return json({ features: [] });
      return json({
        status: 'available',
        alerts: [],
        fetchedAt: now,
        source: 'NDMA SACHET',
        officialUrl: 'https://sachet.ndma.gov.in/',
        scope: 'region',
        scopeLabel: 'Tamil Nadu',
        partial: true,
        coverage: 'Regional feed is incomplete.',
      });
    };
    const start = now;
    await fetchAlerts(target);
    now = start + 60_000;
    await fetchAlerts(target);
    assert.equal(calls, 2, target.countryCode);
  }
});

test('a device clock set back does not keep answering from the request cache', async () => {
  const real = Date.now();
  let t = real; // true time; the providers answer on it
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    const target = String(input);
    if (target.startsWith('/api/alerts'))
      return json({
        status: 'available',
        alerts: [],
        fetchedAt: t,
        servedAt: t,
        source: 'NDMA SACHET',
        officialUrl: 'https://sachet.ndma.gov.in/',
        scope: 'region',
        scopeLabel: 'Tamil Nadu',
        partial: true,
        coverage: 'Regional feed is incomplete.',
      });
    if (target.includes('api.weather.gov')) return json({ features: [] });
    return json(forecastPayload());
  };
  const loaders: [string, () => Promise<{ fetchedAt: number }>][] = [
    ['NWS', () => fetchAlerts({ ...place, countryCode: 'US' })],
    ['gateway', () => fetchAlerts(place)],
    ['forecast', () => fetchForecast(place)],
  ];
  for (const [label, load] of loaders) {
    clearRequestCache();
    calls = 0;
    t = real;
    Date.now = () => t + 3_600_000; // the device clock runs one hour fast
    await load();
    t = real + 60_000;
    Date.now = () => t; // corrected; the next check comes one minute after the first
    const result = await load();
    assert.equal(calls, 2, `${label}: the request reaches the network`);
    assert.equal(result.fetchedAt, t, `${label}: the fetch time is on the corrected clock`);
  }
});

test('a cached response is not reused past its lifetime after the device clock is set back', async () => {
  const real = Date.now();
  const monotonic = performance.now;
  let t = real;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json(forecastPayload());
  };
  try {
    performance.now = () => t - real; // the monotonic clock follows true time
    Date.now = () => t + 3_600_000; // one hour fast
    await fetchForecast(place);
    // 62 minutes later, on a corrected clock, the entry's stamp is two minutes in the past.
    t = real + 62 * 60_000;
    Date.now = () => t;
    const result = await fetchForecast(place);
    assert.equal(calls, 2);
    assert.equal(result.fetchedAt, t);
    // A steady clock still answers from memory within the entry's lifetime.
    t += 9 * 60_000;
    Date.now = () => t;
    await fetchForecast(place);
    assert.equal(calls, 2);
  } finally {
    performance.now = monotonic;
  }
});

test('international checks accept a device clock running a few seconds behind the server', async () => {
  const ahead = Date.now() + 10_000;
  globalThis.fetch = async () =>
    json({
      status: 'available',
      alerts: [],
      fetchedAt: ahead,
      source: 'BMKG direct + WMO SWIC',
      officialUrl: 'https://www.bmkg.go.id/peringatan-dini',
      scope: 'point',
      scopeLabel: 'Jakarta',
      partial: true,
      coverage: 'Incomplete coverage.',
      checks: [
        {
          id: 'national',
          name: 'BMKG CAP feed · direct',
          url: 'https://www.bmkg.go.id/peringatan-dini',
          status: 'available',
          fetchedAt: ahead,
          coverage: 'Partial nowcasts.',
        },
      ],
    });
  const result = await fetchAlerts({ ...place, name: 'Jakarta', countryCode: 'ID' });
  assert.equal(result.fetchedAt, ahead);
  assert.equal(result.checks?.[0].fetchedAt, ahead);
});

test('a device clock running fast or slow does not make a fresh gateway check stale', async () => {
  const real = Date.now();
  // The gateway answers at `real` on its own clock with a provider read `age` ms old.
  const answer = (age: number) => ({
    status: 'available',
    alerts: [],
    fetchedAt: real - age,
    servedAt: real,
    source: 'IMD Kolkata + NDMA SACHET',
    officialUrl: 'https://sachet.ndma.gov.in/',
    scope: 'region',
    scopeLabel: 'Kolkata district + West Bengal',
    partial: true,
    coverage: 'Limited feeds.',
    checks: [
      {
        id: 'imd-kolkata',
        name: 'IMD district nowcast',
        url: 'https://mausam.imd.gov.in/kolkata/',
        status: 'available',
        fetchedAt: real - age,
        coverage: 'District nowcast.',
      },
    ],
  });
  for (const [skew, age] of [
    [125_000, 0],
    [75_000, 50_000],
    [65_000, 58_000],
    [-75_000, 0],
    [-600_000, 30_000],
  ]) {
    clearRequestCache();
    Date.now = () => real + skew;
    globalThis.fetch = async () => json(answer(age));
    const result = await fetchAlerts(place);
    // Read times are moved onto this device's clock, so the dashboard measures their true age.
    assert.equal(result.fetchedAt, real - age + skew, `device ${skew} ms, read ${age} ms old`);
    assert.equal(result.checks?.[0].fetchedAt, real - age + skew);
    assert.equal(alertCheckIsRecent(result.fetchedAt, Date.now(), true), true);
    assert.equal(alertCheckIsRecent(result.fetchedAt, Date.now() + 120_001 - age, true), false);
  }
  // A read that is really older than two minutes, or later than the gateway's own answer, is
  // refused whatever the device clock says.
  for (const skew of [0, 125_000, -125_000]) {
    Date.now = () => real + skew;
    for (const value of [
      answer(120_001),
      { ...answer(0), fetchedAt: real + 60_001 },
      { ...answer(0), checks: [{ ...answer(0).checks[0], fetchedAt: real - 120_001 }] },
    ]) {
      clearRequestCache();
      globalThis.fetch = async () => json(value);
      await assert.rejects(fetchAlerts(place), /incomplete or stale|incomplete source checks/);
    }
  }
});

test('a slow device clock does not hide a warning that has just taken effect', async () => {
  const real = Date.now();
  Date.now = () => real - 10_000; // the device clock runs 10 seconds slow
  const bulletin = {
    id: 'bmkg:thunderstorm:0',
    title: 'Thunderstorm',
    event: 'Thunderstorm',
    severity: 'Severe',
    area: 'DKI Jakarta',
    sent: real - 2_000,
    effective: real - 2_000,
    expires: real + 3_600_000,
    description: 'Official text',
    instruction: 'Stay indoors.',
    source: 'BMKG',
    url: 'https://www.bmkg.go.id/alerts/nowcast/en/ABC123_alert.xml',
    geometry: null,
  };
  // The gateway listed the bulletin because it took effect 2 s before its own check.
  globalThis.fetch = async () =>
    json({
      status: 'available',
      alerts: [bulletin, { ...bulletin, id: 'later', sent: real, effective: real + 60_000 }],
      fetchedAt: real - 1_000,
      servedAt: real,
      source: 'BMKG direct + WMO SWIC',
      officialUrl: 'https://www.bmkg.go.id/peringatan-dini',
      scope: 'point',
      scopeLabel: 'Jakarta',
      partial: true,
      coverage: 'Incomplete coverage.',
    });
  const jakarta = await fetchAlerts({ ...place, name: 'Jakarta', countryCode: 'ID' });
  assert.deepEqual(
    jakarta.alerts.map((item) => item.id),
    ['bmkg:thunderstorm:0'],
  );
  // NWS has no gateway clock: a warning effective when issued gets the issue-time allowance.
  clearRequestCache();
  const iso = (time: number) => new Date(time).toISOString();
  globalThis.fetch = async () =>
    json({
      features: [
        alert({ id: 'tornado', sent: iso(real - 2_000), effective: iso(real - 2_000) }),
        alert({ id: 'not-effective', effective: iso(real + 600_000) }),
      ],
    });
  const miami = await fetchAlerts({ ...place, countryCode: 'US' });
  assert.deepEqual(
    miami.alerts.map((item) => item.id),
    ['tornado'],
  );
});

test('a warning with less time left than the device clock runs fast stays listed until it expires', async () => {
  const real = Date.now();
  // The gateway answers at `real` on its own clock with a warning that has `left` ms to run.
  const answer = (left: number) => ({
    status: 'available',
    alerts: [
      {
        id: 'pagasa:rainfall:0',
        title: 'Red rainfall warning',
        event: 'Rainfall warning',
        severity: 'Extreme',
        area: 'Metro Manila',
        sent: real - 600_000,
        effective: real - 600_000,
        expires: real + left,
        description: 'Official text',
        instruction: 'Evacuate low-lying areas.',
        source: 'PAGASA',
        url: 'https://publicalert.pagasa.dost.gov.ph/output/gfa/00000000-0000-4000-8000-000000000001.cap',
        geometry: null,
      },
    ],
    fetchedAt: real - 1_000,
    servedAt: real,
    source: 'PAGASA direct + WMO SWIC',
    officialUrl: 'https://www.pagasa.dost.gov.ph/',
    scope: 'point',
    scopeLabel: 'Manila',
    partial: true,
    coverage: 'Incomplete coverage.',
  });
  const manila = { ...place, name: 'Manila', countryCode: 'PH' };
  const MINUTE = 60_000;
  for (const [skew, left] of [
    [10 * MINUTE, 5 * MINUTE],
    [60 * MINUTE, 30 * MINUTE],
    [24 * 60 * MINUTE, 120 * MINUTE],
    [-60 * MINUTE, 5 * MINUTE],
  ]) {
    clearRequestCache();
    Date.now = () => real + skew;
    globalThis.fetch = async () => json(answer(left));
    const result = await fetchAlerts(manila);
    const note = `device ${skew / MINUTE} min, ${left / MINUTE} min left`;
    // The measured difference travels with the check: device clock minus gateway clock.
    assert.equal(result.clockOffset, skew, note);
    // The dashboard calls the check current and lists the warning, as the gateway did.
    assert.equal(alertCheckIsRecent(result.fetchedAt, Date.now(), true), true, note);
    assert.deepEqual(
      unexpiredAlerts(result, Date.now()).map((item) => item.id),
      ['pagasa:rainfall:0'],
      note,
    );
    // It stays listed until its stated expiry on the gateway's clock, and not after it.
    assert.equal(unexpiredAlerts(result, Date.now() + left - 1).length, 1, note);
    assert.equal(unexpiredAlerts(result, Date.now() + left).length, 0, note);
  }
  // An NWS answer that states no clock is judged on the device clock as before.
  clearRequestCache();
  Date.now = () => real;
  globalThis.fetch = async () => json({ features: [alert()] });
  const miami = await fetchAlerts({ ...place, countryCode: 'US' });
  assert.equal(miami.clockOffset, undefined);
  assert.equal(unexpiredAlerts(miami, real + 3_600_000 - 1).length, 1);
  assert.equal(unexpiredAlerts(miami, real + 3_600_000).length, 0);
});

test('a device clock running fast or slow does not hide a current NWS warning', async () => {
  // NWS states its clock in its cache headers, as its live answers do: `Expires` is `max-age`
  // after the answer and, unlike `Date`, a page may read it across origins.
  const real = Math.floor(Date.now() / 1000) * 1000; // HTTP dates carry whole seconds
  const MINUTE = 60_000;
  const iso = (time: number) => new Date(time).toISOString();
  const stated = {
    'Cache-Control': 'public, max-age=5, s-maxage=5',
    Expires: new Date(real + 5_000).toUTCString(),
  };
  // A Tornado Warning issued 4 minutes ago with 41 minutes left, in an answer NWS made at `real`.
  const answer = (headers: Record<string, string>, updated?: string) =>
    new Response(
      JSON.stringify({
        type: 'FeatureCollection',
        updated,
        features: [
          alert({
            id: 'tornado',
            event: 'Tornado Warning',
            severity: 'Extreme',
            sent: iso(real - 4 * MINUTE),
            effective: iso(real - 4 * MINUTE),
            expires: iso(real + 41 * MINUTE),
          }),
        ],
      }),
      { headers: { 'Content-Type': 'application/geo+json', ...headers } },
    );
  const oklahomaCity = { ...place, name: 'Oklahoma City', countryCode: 'US' };
  for (const skew of [45 * MINUTE, 60 * MINUTE, -10 * MINUTE, -60 * MINUTE, 0]) {
    clearRequestCache();
    Date.now = () => real + skew;
    globalThis.fetch = async () => answer(stated, iso(real - 2 * MINUTE));
    const result = await fetchAlerts(oklahomaCity);
    const note = `device ${skew / MINUTE} min`;
    // The measured difference travels with the check: device clock minus NWS's clock.
    assert.equal(result.clockOffset, skew, note);
    assert.equal(alertCheckIsRecent(result.fetchedAt, Date.now(), true), true, note);
    assert.deepEqual(
      unexpiredAlerts(result, Date.now()).map((item) => item.id),
      ['tornado'],
      note,
    );
    // It stays listed until its stated expiry on NWS's clock, and not after it.
    assert.equal(unexpiredAlerts(result, Date.now() + 41 * MINUTE - 1).length, 1, note);
    assert.equal(unexpiredAlerts(result, Date.now() + 41 * MINUTE).length, 0, note);
    // The warning panel says when the two clocks differ.
    assert.equal(clockNotice(result.clockOffset) !== '', skew !== 0, note);
  }
  // A stated time is used only with a lifetime, and only when it is no earlier than the feed's own
  // update time and within an hour of it; otherwise the two clocks are taken to agree.
  Date.now = () => real + 45 * MINUTE;
  for (const [headers, updated] of [
    [{}, iso(real - 2 * MINUTE)],
    [{ 'Cache-Control': 'no-cache', Expires: stated.Expires }, iso(real - 2 * MINUTE)],
    [{ ...stated, Expires: '0' }, iso(real - 2 * MINUTE)],
    [{ ...stated, Expires: 'Thu, 01 Jan 1970 00:00:00 GMT' }, iso(real - 2 * MINUTE)],
    [stated, undefined],
    [stated, iso(real + 2 * MINUTE)],
    [stated, iso(real - 2 * 60 * MINUTE)],
  ] as const) {
    clearRequestCache();
    globalThis.fetch = async () => answer(headers, updated);
    const result = await fetchAlerts(oklahomaCity);
    assert.equal(result.clockOffset, undefined, JSON.stringify([headers, updated]));
  }
});

test('stale international checks and incomplete response shapes fail closed', async () => {
  for (const value of [
    { status: 'available' },
    {
      status: 'available',
      alerts: [],
      fetchedAt: Date.now() - 300_000,
      scope: 'point',
      partial: true,
    },
  ]) {
    clearRequestCache();
    globalThis.fetch = async () => json(value);
    await assert.rejects(fetchAlerts(place), /incomplete or stale/);
  }
});

test('international warning API failures retain actionable source failure messages', async () => {
  globalThis.fetch = async () =>
    json(
      { error: true, reason: 'Official warnings could not be verified. Source timed out.' },
      503,
    );
  await assert.rejects(fetchAlerts(place), /Source timed out/);
});

test('international warning API gateway pages keep the warning failure message and status', async () => {
  for (const body of ['<html>502 Bad Gateway</html>', '']) {
    clearRequestCache();
    globalThis.fetch = async () =>
      new Response(body, { status: 502, headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(fetchAlerts(place), (error: unknown) => {
      assert.ok(error instanceof WeatherDataError);
      assert.equal(error.message, 'Official warning sources could not be checked.');
      assert.equal(error.status, 502);
      return true;
    });
  }
});

test('international warning links are allowlisted and expired bulletins are excluded', async () => {
  const now = Date.now();
  const valid = {
    id: 'sachet:123',
    title: 'Official title',
    event: 'Rain',
    severity: 'Severe',
    area: 'Named district',
    sent: now - 60000,
    effective: now - 60000,
    expires: now + 60000,
    description: 'Source text',
    instruction: 'Source instruction',
    source: 'IMD',
    url: 'https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=123',
    geometry: null,
  };
  const response = {
    status: 'available',
    alerts: [
      valid,
      { ...valid, id: 'old', expires: now - 1 },
      { ...valid, id: 'not-effective', effective: now + 60_000, expires: now + 600_000 },
    ],
    fetchedAt: now,
    source: 'NDMA SACHET',
    officialUrl: 'https://sachet.ndma.gov.in/',
    scope: 'region',
    scopeLabel: 'Maharashtra',
    partial: true,
    coverage: 'Limited regional feed.',
  };
  globalThis.fetch = async () => json(response);
  assert.equal((await fetchAlerts(place)).alerts.length, 1);
  clearRequestCache();
  globalThis.fetch = async () =>
    json({ ...response, alerts: [{ ...valid, url: 'https://evil.example/' }] });
  await assert.rejects(fetchAlerts(place), /invalid source link/);
});

test('direct-source check metadata preserves partial failures and verified authority URLs', async () => {
  const now = Date.now();
  const response = {
    status: 'available',
    alerts: [],
    fetchedAt: now - 1000,
    source: 'BMKG direct + WMO SWIC',
    officialUrl: 'https://www.bmkg.go.id/peringatan-dini',
    scope: 'point',
    scopeLabel: 'Jakarta',
    partial: true,
    coverage: 'Incomplete coverage.',
    checks: [
      {
        id: 'national',
        name: 'BMKG CAP feed · direct',
        url: 'https://www.bmkg.go.id/peringatan-dini',
        status: 'available',
        fetchedAt: now - 1000,
        feedUpdatedAt: now - 300000,
        coverage: 'Partial nowcasts.',
      },
      {
        id: 'wmo',
        name: 'WMO SWIC',
        url: 'https://severeweather.wmo.int/',
        status: 'unavailable',
        fetchedAt: null,
        coverage: 'Could not verify.',
      },
    ],
  };
  globalThis.fetch = async () => json(response);
  const received = await fetchAlerts({ ...place, name: 'Jakarta', countryCode: 'ID' });
  assert.equal(received.checks?.[0].fetchedAt, now - 1000);
  assert.equal(received.checks?.[0].feedUpdatedAt, now - 300000);
  assert.equal(received.checks?.[1].status, 'unavailable');
  assert.equal(received.checks?.[1].fetchedAt, null);
  assert.equal(received.partial, true);
  for (const checks of [
    {},
    Array.from({ length: 5 }, () => response.checks[0]),
    [{ ...response.checks[0], status: 'safe' }],
    [{ ...response.checks[0], fetchedAt: now - 300000 }],
    [{ ...response.checks[0], fetchedAt: now + 300000 }],
    [{ ...response.checks[0], name: '' }],
    [{ ...response.checks[0], url: 'https://www.bmkg.go.id.evil.example/' }],
    [{ ...response.checks[0], url: 'https://user:pass@www.bmkg.go.id/' }],
  ]) {
    clearRequestCache();
    globalThis.fetch = async () => json({ ...response, checks });
    await assert.rejects(fetchAlerts(place), /source (checks|link)/);
  }
});

test('PAGASA and BMKG bulletin URLs are accepted while credentialed and lookalike URLs fail closed', async () => {
  const now = Date.now();
  const bulletin = {
    id: 'agency/123/0',
    title: 'Official title',
    event: 'Thunderstorm',
    severity: 'Moderate',
    area: 'Named area',
    sent: now - 60000,
    effective: now - 60000,
    expires: now + 60000,
    description: 'Official text',
    instruction: 'Official instructions',
    source: 'Weather authority',
    geometry: null,
  };
  const response = {
    status: 'available',
    fetchedAt: now,
    source: 'Direct authority',
    scope: 'point',
    scopeLabel: 'Test city',
    partial: true,
    coverage: 'Incomplete.',
  };
  for (const url of [
    'https://publicalert.pagasa.dost.gov.ph/output/gfa/12345678-1234-1234-1234-123456789abc.cap',
    'https://www.bmkg.go.id/alerts/nowcast/en/ABC123_alert.xml',
  ]) {
    clearRequestCache();
    globalThis.fetch = async () =>
      json({ ...response, officialUrl: url, alerts: [{ ...bulletin, url }] });
    const received = await fetchAlerts(place);
    assert.equal(received.alerts[0].url, url);
  }
  for (const url of [
    'https://publicalert.pagasa.dost.gov.ph.evil.example/alert.cap',
    'https://www.bmkg.go.id.evil.example/alert.xml',
    'https://user:secret@publicalert.pagasa.dost.gov.ph/alert.cap',
    'http://www.bmkg.go.id/alert.xml',
  ]) {
    clearRequestCache();
    globalThis.fetch = async () =>
      json({ ...response, officialUrl: 'https://www.bmkg.go.id/', alerts: [{ ...bulletin, url }] });
    await assert.rejects(fetchAlerts(place), /invalid source link/);
  }
});

test('NWS filters expired, cancelled, test, duplicate, and already-ended warnings', async () => {
  globalThis.fetch = async () =>
    json({
      features: [
        alert(),
        alert(),
        alert({ id: 'expired', expires: new Date(Date.now() - 1).toISOString() }),
        alert({ id: 'cancelled', messageType: 'Cancel' }),
        alert({ id: 'test', status: 'Test' }),
        alert({ id: 'ended', ends: new Date(Date.now() - 1).toISOString() }),
      ],
    });
  const result = await fetchAlerts({ ...place, countryCode: 'US' });
  assert.equal(result.status, 'available');
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].severity, 'Severe');
  assert.equal(result.alerts[0].instruction, 'Official instruction text');
  assert.ok(result.alerts[0].geometry);
});

test('San Francisco warnings use the NWS latitude-longitude point and retain the official area', async () => {
  const sanFrancisco: Place = {
    id: '5391959',
    name: 'San Francisco',
    country: 'United States',
    countryCode: 'US',
    admin: 'California',
    latitude: 37.77493,
    longitude: -122.41942,
    timezone: 'America/Los_Angeles',
  };
  globalThis.fetch = async (target) => {
    const requested = new URL(String(target));
    assert.equal(requested.origin, 'https://api.weather.gov');
    assert.equal(requested.pathname, '/alerts/active');
    assert.equal(requested.searchParams.get('point'), '37.7749,-122.4194');
    return json({
      features: [
        alert({
          event: 'Coastal Flood Advisory',
          severity: 'Minor',
          areaDesc: 'San Francisco Bay Shoreline',
          senderName: 'NWS San Francisco CA',
        }),
      ],
    });
  };
  const result = await fetchAlerts(sanFrancisco);
  assert.equal(result.scopeLabel, 'San Francisco');
  assert.equal(result.scope, 'point');
  assert.equal(result.partial, false);
  assert.equal(result.alerts[0].source, 'NWS San Francisco CA');
  assert.equal(result.alerts[0].area, 'San Francisco Bay Shoreline');
  const official = new URL(result.officialUrl);
  assert.equal(official.hostname, 'forecast.weather.gov');
  assert.equal(official.searchParams.get('lat'), '37.7749');
  assert.equal(official.searchParams.get('lon'), '-122.4194');
});

test('U.S. territories are checked with NWS point warnings, not the international gateway', async () => {
  for (const [countryCode, name, latitude, longitude] of [
    ['PR', 'San Juan', 18.4655, -66.1057],
    ['VI', 'Charlotte Amalie', 18.3419, -64.9307],
    ['GU', 'Hagåtña', 13.4757, 144.7489],
    ['AS', 'Pago Pago', -14.2756, -170.702],
    ['MP', 'Saipan', 15.185, 145.7467],
  ] as const) {
    clearRequestCache();
    const requested: string[] = [];
    globalThis.fetch = async (target) => {
      requested.push(String(target));
      return json({ features: [alert()] });
    };
    const result = await fetchAlerts({ ...place, name, countryCode, latitude, longitude });
    assert.equal(requested.length, 1, name);
    const url = new URL(requested[0]);
    assert.equal(`${url.origin}${url.pathname}`, 'https://api.weather.gov/alerts/active', name);
    assert.equal(
      url.searchParams.get('point'),
      `${latitude.toFixed(4)},${longitude.toFixed(4)}`,
      name,
    );
    assert.equal(result.source, 'US National Weather Service', name);
    assert.equal(result.scope, 'point', name);
    assert.equal(result.alerts.length, 1, name);
  }
});

test('a long NWS area list keeps whole zone names and states how many more there are', async () => {
  // About 6,000 characters of zone names: more than the 4,000 shown and kept in saved briefings.
  const zones = Array.from({ length: 250 }, (_, i) =>
    i === 249 ? 'Miami-Dade County' : `Fixture Zone ${i + 1} County`,
  );
  globalThis.fetch = async () =>
    json({
      features: [
        alert({ id: 'long', areaDesc: zones.join('; ') }),
        alert({ id: 'short', areaDesc: 'Coastal Broward County; Inland Broward County' }),
        alert({ id: 'none', areaDesc: undefined }),
      ],
    });
  const result = await fetchAlerts({ ...place, countryCode: 'US' });
  const [long, short, none] = result.alerts.map((item) => item.area);
  assert.equal(short, 'Coastal Broward County; Inland Broward County');
  assert.equal(none, '');
  assert.ok(long.length <= 4000, String(long.length));
  const [shown, note] = long.split(' … ');
  const kept = shown.split('; ');
  // Never cut inside a name, and never silently: the last zone is counted, not dropped.
  assert.deepEqual(kept, zones.slice(0, kept.length));
  assert.ok(kept.length > 150 && kept.length < 250, String(kept.length));
  assert.equal(note, `[${250 - kept.length} more area(s) named in the official bulletin]`);
});

test('NWS excludes future-effective records but retains current warnings for future hazards', async () => {
  const now = Date.now();
  globalThis.fetch = async () =>
    json({
      features: [
        alert({ id: 'not-effective', effective: new Date(now + 600_000).toISOString() }),
        alert({ id: 'future-onset', onset: new Date(now + 600_000).toISOString() }),
      ],
    });
  const result = await fetchAlerts({ ...place, countryCode: 'US' });
  assert.deepEqual(
    result.alerts.map((item) => item.id),
    ['future-onset'],
  );
});

test('NWS warns when a bounded response omits records or additional pages', async () => {
  for (const payload of [
    { features: Array.from({ length: 101 }, (_, i) => alert({ id: `alert-${i}` })) },
    {
      features: [alert()],
      pagination: { next: 'https://api.weather.gov/alerts/active?cursor=next' },
    },
  ]) {
    clearRequestCache();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return json(payload);
    };
    const result = await fetchAlerts({ ...place, countryCode: 'US' });
    assert.equal(result.partial, true);
    assert.match(result.coverage, /incomplete/i);
    assert.equal(result.alerts.length, Math.min(payload.features.length, 100));
    assert.equal(calls, 1, 'Provider pagination must not trigger an unbounded fetch chain.');
  }
});

test('NWS allows complete responses at the local record limit', async () => {
  globalThis.fetch = async () =>
    json({
      features: Array.from({ length: 100 }, (_, i) => alert({ id: `alert-${i}` })),
    });
  const result = await fetchAlerts({ ...place, countryCode: 'US' });
  assert.equal(result.alerts.length, 100);
  assert.equal(result.partial, false);
});

test('NWS valid hazard end shortens expiry and missing validity never becomes a warning', async () => {
  const now = Date.now();
  const ends = new Date(now + 300_000).toISOString();
  globalThis.fetch = async () =>
    json({
      features: [
        alert({ id: 'ends-first', ends }),
        alert({ id: 'no-expiry', expires: null }),
        alert({ id: 'bad-effective', effective: 'not a date' }),
        alert({ id: 'bad-sent', sent: null }),
      ],
    });
  const result = await fetchAlerts({ ...place, countryCode: 'US' });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].id, 'ends-first');
  assert.equal(result.alerts[0].expires, Date.parse(ends));
});

test('NWS warnings are listed most severe first, so a saved briefing keeps the most severe', async () => {
  const now = Date.now();
  Date.now = () => now;
  // Six current advisories come first in the feed, the warning that matters most near the end.
  const advisories = Array.from({ length: 6 }, (_, i) => `advisory-${i}`);
  globalThis.fetch = async () =>
    json({
      features: [
        ...advisories.map((id) =>
          alert({ id, event: 'Coastal Flood Advisory', severity: 'Minor' }),
        ),
        alert({ id: 'unknown', event: 'Special Weather Statement', severity: 'Unknown' }),
        alert({ id: 'moderate', event: 'Flood Watch', severity: 'Moderate' }),
        alert({ id: 'tornado', event: 'Tornado Warning', severity: 'Extreme' }),
        alert({ id: 'severe', event: 'Severe Thunderstorm Warning', severity: 'Severe' }),
      ],
    });
  const miami = { ...place, name: 'Miami', countryCode: 'US', latitude: 25.77, longitude: -80.19 };
  const result = await fetchAlerts(miami);
  assert.deepEqual(
    result.alerts.map((item) => item.id),
    ['tornado', 'severe', 'moderate', ...advisories, 'unknown'],
  );
  // A saved briefing keeps the first five warnings and only counts the others.
  const hour = {
    time: now,
    temperature: 25,
    apparent: 27,
    precipitation: 0,
    probability: 20,
    wind: 10,
    gust: 25,
    humidity: 60,
    code: 3,
    uv: 2,
  };
  const forecast = {
    fetchedAt: now,
    timezone: 'America/New_York',
    current: hour,
    hours: [hour],
    days: [],
    source: 'Open-Meteo',
  };
  const briefing = createBriefing(miami, forecast, result, now);
  assert.deepEqual(
    briefing.warnings.alerts.map((item) => item.id),
    ['tornado', 'severe', 'moderate', 'advisory-0', 'advisory-1'],
  );
  assert.equal(briefing.warnings.omitted, 5);
  assert.match(briefingText(briefing, now), /Tornado Warning — Extreme/);
});

test('an issue time too far ahead, or an expiry not after issue and effect, is never listed', async () => {
  const now = Date.now();
  Date.now = () => now;
  const iso = (time: number) => new Date(time).toISOString();
  // An issue time up to five minutes ahead of the source clock is accepted, a later one is not.
  globalThis.fetch = async () =>
    json({
      features: [
        alert({ id: 'sent-ahead', sent: iso(now + 300_000) }),
        alert({ id: 'sent-later', sent: iso(now + 300_001) }),
        alert({ id: 'expires-at-sent', sent: iso(now + 120_000), expires: iso(now + 120_000) }),
        alert({
          id: 'expires-before-effective',
          sent: iso(now - 120_000),
          effective: iso(now + 120_000),
          expires: iso(now + 60_000),
        }),
      ],
    });
  assert.deepEqual(
    (await fetchAlerts({ ...place, countryCode: 'US' })).alerts.map((item) => item.id),
    ['sent-ahead'],
  );
  // The gateway's bulletins are judged the same way, on the gateway's clock.
  const bulletin = {
    title: 'Official title',
    event: 'Rain',
    severity: 'Severe',
    area: 'Named district',
    effective: now - 60_000,
    expires: now + 3_600_000,
    description: 'Source text',
    instruction: 'Source instruction',
    source: 'IMD',
    url: 'https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=123',
    geometry: null,
  };
  globalThis.fetch = async () =>
    json({
      status: 'available',
      alerts: [
        { ...bulletin, id: 'sent-ahead', sent: now + 300_000 },
        { ...bulletin, id: 'sent-later', sent: now + 300_001 },
        { ...bulletin, id: 'expires-at-sent', sent: now + 120_000, expires: now + 120_000 },
      ],
      fetchedAt: now,
      servedAt: now,
      source: 'NDMA SACHET',
      officialUrl: 'https://sachet.ndma.gov.in/',
      scope: 'region',
      scopeLabel: 'Tamil Nadu',
      partial: true,
      coverage: 'Limited regional feed.',
    });
  assert.deepEqual(
    (await fetchAlerts(place)).alerts.map((item) => item.id),
    ['sent-ahead'],
  );
});

test('Kolkata client carries West Bengal metadata without converting regional coverage into point coverage', async () => {
  globalThis.fetch = async (target) => {
    const requested = new URL(String(target), 'https://stormsignal.invalid');
    assert.equal(requested.pathname, '/api/alerts');
    assert.equal(requested.searchParams.get('lat'), '22.5626');
    assert.equal(requested.searchParams.get('lon'), '88.3630');
    assert.equal(requested.searchParams.get('admin'), 'West Bengal');
    assert.equal(requested.searchParams.get('name'), 'Kolkata');
    return json({
      status: 'available',
      alerts: [],
      fetchedAt: Date.now(),
      source: 'NDMA SACHET',
      officialUrl: 'https://sachet.ndma.gov.in/',
      scope: 'region',
      scopeLabel: 'West Bengal',
      partial: true,
      coverage: 'Regional coverage does not establish an all-clear for Kolkata.',
    });
  };
  const result = await fetchAlerts({
    ...place,
    name: 'Kolkata',
    admin: 'West Bengal',
    latitude: 22.56263,
    longitude: 88.36304,
  });
  assert.equal(result.scope, 'region');
  assert.equal(result.scopeLabel, 'West Bengal');
  assert.equal(result.partial, true);
  assert.match(result.coverage, /does not establish an all-clear/);
});

test('NWS discards malformed geometry and disallows unsafe outgoing alert links', async () => {
  const item = alert({ web: 'javascript:alert(1)' });
  item.geometry.coordinates = [
    [
      [400, 200],
      [400, 200],
      [400, 200],
      [400, 200],
    ],
  ];
  globalThis.fetch = async () => json({ features: [item] });
  const result = await fetchAlerts({ ...place, countryCode: 'US' });
  assert.equal(result.alerts[0].geometry, null);
  assert.match(result.alerts[0].url, /^https:\/\/api\.weather\.gov\//);
});

test('every official outline the gateway sends reaches the map, up to its 250-polygon bound', async () => {
  const now = Date.now();
  // A BMKG province bulletin: one area with many small district rings, as the gateway builds it.
  const rings = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const lon = 106 + (i % 50) * 0.02,
        lat = -6.4 + Math.floor(i / 50) * 0.02;
      return [
        [lat, lon],
        [lat, lon + 0.01],
        [lat + 0.01, lon + 0.01],
        [lat, lon],
      ];
    });
  const outline = (count: number) =>
    capAreaGeometry([
      { description: 'Province', polygons: rings(count), circles: [], geocodes: [] },
    ]);
  for (const count of [120, 250]) {
    clearRequestCache();
    const geometry = outline(count);
    assert.equal(geometry?.coordinates.length, count);
    globalThis.fetch = async () =>
      json({
        status: 'available',
        alerts: [
          {
            id: `bmkg:province:${count}`,
            title: 'Thunderstorm in DKI Jakarta',
            event: 'Thunderstorm',
            severity: 'Moderate',
            area: 'DKI Jakarta',
            sent: now - 60_000,
            effective: now - 60_000,
            expires: now + 3_600_000,
            description: 'Official text',
            instruction: 'Stay indoors.',
            source: 'BMKG',
            url: 'https://www.bmkg.go.id/alerts/nowcast/en/ABC123_alert.xml',
            geometry,
          },
        ],
        fetchedAt: now,
        source: 'BMKG direct + WMO SWIC',
        officialUrl: 'https://www.bmkg.go.id/peringatan-dini',
        scope: 'point',
        scopeLabel: 'Jakarta',
        partial: true,
        coverage: 'Incomplete coverage.',
      });
    const result = await fetchAlerts({ ...place, name: 'Jakarta', countryCode: 'ID' });
    assert.equal(result.alerts.length, 1);
    assert.deepEqual(result.alerts[0].geometry, geometry, `${count} polygons`);
  }
  // The gateway never sends more (1,000 positions in rings of four or more); larger is refused.
  assert.equal(outline(251), null);
  clearRequestCache();
  const oversized = alert();
  (oversized as { geometry: unknown }).geometry = {
    type: 'MultiPolygon',
    coordinates: Array.from({ length: 251 }, () => [oversized.geometry.coordinates[0]]),
  };
  globalThis.fetch = async () => json({ features: [oversized] });
  assert.equal((await fetchAlerts({ ...place, countryCode: 'US' })).alerts[0].geometry, null);
});

test('warning outlines are drawn whole around the selected place, also across 180°', () => {
  type Outline = NonNullable<ReturnType<typeof alertOutline>>;
  const inside = (outline: Outline, x: number, y: number) =>
    outline.coordinates.some(([ring]) => {
      let result = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i],
          [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) result = !result;
      }
      return result;
    });
  // Away from 180°, the supplied outline is drawn exactly as it is.
  const florida = {
    type: 'Polygon',
    coordinates: [
      [
        [-81, 25],
        [-80, 25],
        [-80, 26],
        [-81, 25],
      ],
    ],
  };
  assert.deepEqual(alertOutline(florida, -80.19), {
    type: 'MultiPolygon',
    coordinates: [florida.coordinates],
  });
  // A ring written across 180° is drawn as one area around the place, never around the world.
  const fiji = {
    type: 'Polygon',
    coordinates: [
      [
        [176, -15],
        [-178, -15],
        [-178, -21],
        [176, -21],
        [176, -15],
      ],
    ],
  };
  const suva = alertOutline(fiji, 178.44)!;
  assert.deepEqual(suva.coordinates, [
    [
      [
        [176, -15],
        [182, -15],
        [182, -21],
        [176, -21],
        [176, -15],
      ],
    ],
  ]);
  assert.ok(inside(suva, 178.44, -18.14));
  const lakeba = alertOutline(fiji, -178.8)!;
  assert.deepEqual(
    lakeba.coordinates[0][0].map(([x]) => x),
    [-184, -178, -178, -184, -184],
  );
  assert.ok(inside(lakeba, -178.8, -18.2));
  // The gateway's two parts, cut at 180°, are drawn side by side on the place's side of the map.
  const cut = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [178, -16],
          [180, -16],
          [180, -20],
          [178, -20],
          [178, -16],
        ],
      ],
      [
        [
          [-180, -16],
          [-178, -16],
          [-178, -20],
          [-180, -20],
          [-180, -16],
        ],
      ],
    ],
  };
  for (const [longitude, low, high] of [
    [-178.8, -182, -178],
    [179.2, 178, 182],
  ]) {
    const drawn = alertOutline(cut, longitude)!;
    const xs = drawn.coordinates.flat(2).map(([x]) => x);
    assert.deepEqual([Math.min(...xs), Math.max(...xs)], [low, high], String(longitude));
    assert.ok(inside(drawn, longitude, -18.2), String(longitude));
  }
  // An area just across 180° from the place is drawn beside it; a hole stays in its polygon.
  const across = alertOutline(
    {
      type: 'Polygon',
      coordinates: [
        [
          [-170, 0],
          [-160, 0],
          [-160, 5],
          [-170, 0],
        ],
        [
          [-169, 0.5],
          [-168, 0.5],
          [-168, 1],
          [-169, 0.5],
        ],
      ],
    },
    175,
  )!;
  assert.deepEqual(
    across.coordinates[0].map((ring) => ring.map(([x]) => x)),
    [
      [190, 200, 200, 190],
      [191, 192, 192, 191],
    ],
  );
  // A ring around a pole has no faithful outline, and invalid geometry none at all.
  assert.equal(
    alertOutline(
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 80],
            [120, 80],
            [-120, 80],
            [0, 80],
          ],
        ],
      },
      0,
    ),
    null,
  );
  assert.equal(alertOutline({ type: 'Point', coordinates: [0, 0] }, 0), null);
  assert.equal(alertOutline(fiji, NaN), null);
  // A polygon without rings has nothing to draw. It never throws, and the others are still drawn.
  const triangle = [
    [
      [10, 0],
      [11, 0],
      [11, 1],
      [10, 0],
    ],
  ];
  for (const empty of [
    { type: 'Polygon', coordinates: [] },
    { type: 'MultiPolygon', coordinates: [] },
    { type: 'MultiPolygon', coordinates: [[]] },
    { type: 'MultiPolygon', coordinates: [[], []] },
  ])
    assert.equal(alertOutline(empty, 10), null, JSON.stringify(empty));
  assert.deepEqual(alertOutline({ type: 'MultiPolygon', coordinates: [[], triangle, []] }, 10), {
    type: 'MultiPolygon',
    coordinates: [triangle],
  });
});

test('malformed warning feed is an error rather than an all-clear', async () => {
  globalThis.fetch = async () => json({ features: null });
  await assert.rejects(fetchAlerts({ ...place, countryCode: 'US' }), /warning feed is unavailable/);
});

test('NWS outgoing links reject credentials, nonstandard ports and lookalike hosts', async () => {
  for (const web of [
    'https://example-user:example-password@weather.gov/alert',
    'https://weather.gov:8443/alert',
    'https://weather.gov.example.com/alert',
    'https://evilweather.gov/alert',
    'https://notnoaa.gov/alert',
    'http://weather.gov/alert',
  ]) {
    clearRequestCache();
    globalThis.fetch = async () => json({ features: [alert({ web })] });
    const result = await fetchAlerts({ ...place, countryCode: 'US' });
    assert.equal(result.alerts[0].url, 'https://api.weather.gov/alerts/test');
  }
  clearRequestCache();
  globalThis.fetch = async () => json({ features: [alert({ web: 'https://www.noaa.gov/alert' })] });
  assert.equal(
    (await fetchAlerts({ ...place, countryCode: 'US' })).alerts[0].url,
    'https://www.noaa.gov/alert',
  );
});

test('physically invalid nonnegative fields and out-of-range percentages stay unavailable', async () => {
  const payload = forecastPayload();
  payload.current = { ...payload.current, precipitation: -1, weather_code: 222 };
  Object.assign(payload.current, {
    wind_speed_10m: -10,
    relative_humidity_2m: 130,
    precipitation_probability: -5,
    uv_index: -2,
  });
  globalThis.fetch = async () => json(payload);
  const result = await fetchForecast(place);
  assert.equal(result.current.precipitation, null);
  assert.equal(result.current.probability, null);
  assert.equal(result.current.wind, null);
  assert.equal(result.current.humidity, null);
  assert.equal(result.current.code, null);
  assert.equal(result.current.uv, null);
});

test('negative pollutant values do not appear as clean air', async () => {
  globalThis.fetch = async () =>
    json({ current: { time: sec(), us_aqi: -10, pm2_5: -2, pm10: 13 } });
  const result = await fetchAirQuality(place);
  assert.equal(result.usAqi, null);
  assert.equal(result.pm25, null);
  assert.equal(result.pm10, 13);
});

test('a coordinate-only location requires country metadata without blaming an upstream outage', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw Error('No upstream should be contacted');
  };
  await assert.rejects(
    fetchAlerts({ ...place, countryCode: '', country: '', name: 'Selected point' }),
    (error: unknown) => {
      assert.ok(error instanceof WeatherDataError);
      assert.equal(error.status, 400);
      assert.match(error.message, /Choose a city.*No warning source was checked/);
      return true;
    },
  );
  assert.equal(called, false);
});

test('heavy-thunderstorm code 97 survives all forecast views and has a readable label', async () => {
  const payload = forecastPayload();
  globalThis.fetch = async () =>
    json({
      ...payload,
      current: { ...payload.current, weather_code: 97 },
      hourly: { ...payload.hourly, weather_code: [97, 97] },
      daily: { ...payload.daily, weather_code: [97] },
    });
  const forecast = await fetchForecast(place);
  assert.equal(forecast.current.code, 97);
  assert.deepEqual(
    forecast.hours.map((hour) => hour.code),
    [97, 97],
  );
  assert.equal(forecast.days[0].code, 97);
  assert.equal(weatherLabel(97), 'Heavy thunderstorm');
});

test('rejected provider bodies are cancelled before returning the original error', async () => {
  for (const [status, headers, message] of [
    [429, {}, /provider is busy/],
    [503, {}, /HTTP 503/],
    [200, { 'content-length': '3000000' }, /too large/],
  ] as const) {
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status, headers },
      );
    await assert.rejects(fetchForecast(place), message);
    assert.equal(cancelled, true, `Release the unread HTTP ${status} body`);
  }
});
