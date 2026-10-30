import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  clearRequestCache,
  fetchAirQuality,
  fetchAlerts,
  fetchForecast,
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
beforeEach(() => clearRequestCache());
afterEach(() => {
  globalThis.fetch = originalFetch;
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

test('unsupported alert regions do not make requests or imply safe conditions', async () => {
  globalThis.fetch = async () => {
    throw Error('Should not call');
  };
  const result = await fetchAlerts(place);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.officialUrl, 'https://mausam.imd.gov.in/');
  assert.match(result.coverage, /missing warnings do not mean safe/);
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
