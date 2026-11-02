import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  clearRequestCache,
  fetchAirQuality,
  fetchAlerts,
  fetchForecast,
  fetchCompactForecast,
  fetchModels,
  searchPlaces,
  weatherLabel,
} from '../src/data';
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

test('data saver requests only 24 hours and current conditions without daily payload', async () => {
  globalThis.fetch = async (target) => {
    const params = new URL(String(target)).searchParams;
    assert.equal(params.get('forecast_hours'), '24');
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
    assert.equal(params.get('forecast_hours'), '72');
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

test('malformed warning feed is an error rather than an all-clear', async () => {
  globalThis.fetch = async () => json({ features: null });
  await assert.rejects(fetchAlerts({ ...place, countryCode: 'US' }), /warning feed is unavailable/);
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
