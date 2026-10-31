import type {
  AirQuality,
  AlertResult,
  AlertSourceCheck,
  Day,
  Forecast,
  Hour,
  ModelForecast,
  Place,
  WeatherAlert,
} from './types';

// All providers are fixed allowlisted public endpoints. No credentials are required.
// Current weather and air quality are model estimates, not on-site observations.
const WEATHER = 'https://api.open-meteo.com/v1/forecast';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const NWS = 'https://api.weather.gov/alerts/active';
const MAX_BYTES = 2_000_000;
const MAX_CACHE_ENTRIES = 80;
const cache = new Map<string, { value: unknown; fetchedAt: number; expires: number }>();
type RecordValue = Record<string, unknown>;
type Received = { value: unknown; fetchedAt: number };

export class WeatherDataError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'WeatherDataError';
  }
}

/** Only cache successful responses in memory. Do not revive stale warnings offline. */
export function clearRequestCache(): void {
  cache.clear();
}

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function nonnegative(value: unknown): number | null {
  const n = number(value);
  return n !== null && n >= 0 ? n : null;
}
function percent(value: unknown): number | null {
  const n = nonnegative(value);
  return n !== null && n <= 100 ? n : null;
}
const WEATHER_CODES = new Set([
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86,
  95, 96, 99,
]);
function weatherCode(value: unknown): number | null {
  const n = number(value);
  return n !== null && WEATHER_CODES.has(n) ? n : null;
}
function str(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}
function at(values: unknown, index: number): number | null {
  return Array.isArray(values) ? number(values[index]) : null;
}
function epoch(value: unknown): number | null {
  const n = number(value);
  return n !== null && n >= 946684800 && n < 7258118400 ? n * 1000 : null;
}
function stamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}
function timezone(value: unknown): string {
  const zone = str(value);
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
    return zone;
  } catch {
    return 'UTC';
  }
}
function coordinates(place: Place): Record<string, string> {
  if (
    !Number.isFinite(place.latitude) ||
    Math.abs(place.latitude) > 90 ||
    !Number.isFinite(place.longitude) ||
    Math.abs(place.longitude) > 180
  ) {
    throw new WeatherDataError('This location has invalid coordinates. Choose another place.');
  }
  return { latitude: place.latitude.toFixed(4), longitude: place.longitude.toFixed(4) };
}
function url(base: string, params: Record<string, string>): string {
  return `${base}?${new URLSearchParams(params)}`;
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES)
    throw new WeatherDataError('The provider response is too large. Try again later.');
  if (!response.body) throw new WeatherDataError('The provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new WeatherDataError('The provider response is too large. Try again later.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WeatherDataError('The provider returned an unreadable response.');
  }
}

async function requestJson(target: string, ttl: number, signal?: AbortSignal): Promise<Received> {
  signal?.throwIfAborted();
  const existing = cache.get(target);
  if (existing && existing.expires > Date.now()) return existing;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    target.startsWith('/api/alerts') ? 25_000 : 15_000,
  );
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      headers: { Accept: 'application/geo+json, application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok && target.startsWith('/api/alerts')) {
      const failure = record(await boundedJson(response));
      throw new WeatherDataError(
        str(failure.reason, 400) || 'Official warning sources could not be checked.',
        response.status,
      );
    }
    if (!response.ok)
      throw new WeatherDataError(
        response.status === 429
          ? 'The weather provider is busy. Please wait before retrying.'
          : `Weather provider unavailable (HTTP ${response.status}). Check the official source and retry later.`,
        response.status,
      );
    const value = await boundedJson(response);
    if (record(value).error === true)
      throw new WeatherDataError(
        `The provider could not supply this data: ${str(record(value).reason, 200)}`,
      );
    const fetchedAt = Date.now();
    // Bound the browser session cache; it contains only public weather data.
    for (const [key, entry] of cache) if (entry.expires <= fetchedAt) cache.delete(key);
    while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(target, { value, fetchedAt, expires: fetchedAt + ttl });
    return { value, fetchedAt };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (timedOut)
      throw new WeatherDataError(
        'The weather provider timed out. Check your connection or try again later.',
      );
    if (error instanceof WeatherDataError) throw error;
    throw new WeatherDataError(
      'Unable to reach the weather provider. Check your connection or use the official source.',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const trimmed = query.trim().slice(0, 120);
  if (trimmed.length < 2) return [];
  const result = await requestJson(
    url(GEO, { name: trimmed, count: '8', language: 'en', format: 'json' }),
    24 * 60 * 60 * 1000,
    signal,
  );
  const data = record(result.value);
  if (data.results === undefined) return [];
  if (!Array.isArray(data.results))
    throw new WeatherDataError('Location search returned an unexpected response.');
  return data.results.slice(0, 8).flatMap((item) => {
    const p = record(item),
      latitude = number(p.latitude),
      longitude = number(p.longitude),
      name = str(p.name);
    if (
      latitude === null ||
      longitude === null ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180 ||
      !name
    )
      return [];
    return [
      {
        id: str(p.id) || String(number(p.id) ?? `${latitude},${longitude}`),
        name,
        latitude,
        longitude,
        country: str(p.country),
        countryCode: str(p.country_code, 2).toUpperCase(),
        admin: str(p.admin1),
        timezone: timezone(p.timezone),
      },
    ];
  });
}

const hourFields = {
  temperature: 'temperature_2m',
  apparent: 'apparent_temperature',
  precipitation: 'precipitation',
  probability: 'precipitation_probability',
  wind: 'wind_speed_10m',
  gust: 'wind_gusts_10m',
  humidity: 'relative_humidity_2m',
  code: 'weather_code',
  uv: 'uv_index',
} as const;

function makeHour(data: RecordValue, time: number, index?: number): Hour {
  const value = (field: string) =>
    index === undefined ? number(data[field]) : at(data[field], index);
  return {
    time,
    temperature: value(hourFields.temperature),
    apparent: value(hourFields.apparent),
    precipitation: nonnegative(value(hourFields.precipitation)),
    probability: percent(value(hourFields.probability)),
    wind: nonnegative(value(hourFields.wind)),
    gust: nonnegative(value(hourFields.gust)),
    humidity: percent(value(hourFields.humidity)),
    code: weatherCode(value(hourFields.code)),
    uv: nonnegative(value(hourFields.uv)),
  };
}

export async function fetchForecast(place: Place, signal?: AbortSignal): Promise<Forecast> {
  return forecastRequest(place, signal, false);
}

/** Only the next 24 hourly steps; no weekly/daily payload or comparison models. */
export async function fetchCompactForecast(place: Place, signal?: AbortSignal): Promise<Forecast> {
  return forecastRequest(place, signal, true);
}

async function forecastRequest(
  place: Place,
  signal: AbortSignal | undefined,
  compact: boolean,
): Promise<Forecast> {
  const result = await requestJson(
    url(WEATHER, {
      ...coordinates(place),
      hourly: Object.values(hourFields).join(','),
      current: Object.values(hourFields).join(','),
      ...(compact
        ? { forecast_hours: '24' }
        : {
            daily:
              'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max,weather_code,sunrise,sunset',
            forecast_days: '7',
          }),
      timezone: 'auto',
      timeformat: 'unixtime',
      wind_speed_unit: 'kmh',
      temperature_unit: 'celsius',
      precipitation_unit: 'mm',
    }),
    10 * 60_000,
    signal,
  );
  const data = record(result.value),
    hourly = record(data.hourly),
    current = record(data.current),
    daily = record(data.daily);
  const currentTime = epoch(current.time);
  if (!Array.isArray(hourly.time) || hourly.time.length < 2 || currentTime === null)
    throw new WeatherDataError('The forecast is incomplete. Try again later.');
  const hours: Hour[] = hourly.time.slice(0, 200).flatMap((t, i) => {
    const time = epoch(t);
    return time === null ? [] : [makeHour(hourly, time, i)];
  });
  if (hours.length < 2 || !hours.some((h) => h.temperature !== null || h.precipitation !== null))
    throw new WeatherDataError('No usable forecast values are available for this location.');
  const days: Day[] = Array.isArray(daily.time)
    ? daily.time.slice(0, 7).flatMap((t, i) => {
        const time = epoch(t);
        if (time === null) return [];
        return [
          {
            time,
            high: at(daily.temperature_2m_max, i),
            low: at(daily.temperature_2m_min, i),
            rain: nonnegative(at(daily.precipitation_sum, i)),
            probability: percent(at(daily.precipitation_probability_max, i)),
            gust: nonnegative(at(daily.wind_gusts_10m_max, i)),
            code: weatherCode(at(daily.weather_code, i)),
            sunrise: epoch(Array.isArray(daily.sunrise) ? daily.sunrise[i] : undefined),
            sunset: epoch(Array.isArray(daily.sunset) ? daily.sunset[i] : undefined),
          },
        ];
      })
    : [];
  return {
    fetchedAt: result.fetchedAt,
    timezone: timezone(data.timezone),
    current: makeHour(current, currentTime),
    hours,
    days,
    source: 'Open-Meteo · weather model estimates',
  };
}

const models = [
  { id: 'ecmwf_ifs025', name: 'ECMWF IFS 0.25°' },
  { id: 'gfs_seamless', name: 'NOAA GFS' },
];
export async function fetchModels(place: Place, signal?: AbortSignal): Promise<ModelForecast[]> {
  const location = coordinates(place);
  const results = await Promise.allSettled(
    models.map(async (model) => {
      const result = await requestJson(
        url(WEATHER, {
          ...location,
          models: model.id,
          hourly: 'temperature_2m,precipitation,wind_speed_10m',
          forecast_hours: '72',
          timeformat: 'unixtime',
          timezone: 'auto',
          wind_speed_unit: 'kmh',
          temperature_unit: 'celsius',
          precipitation_unit: 'mm',
        }),
        30 * 60_000,
        signal,
      );
      const data = record(result.value),
        hourly = record(data.hourly);
      if (!Array.isArray(hourly.time)) throw new WeatherDataError(`${model.name} is unavailable.`);
      const hours = hourly.time.slice(0, 96).flatMap((t, i) => {
        const time = epoch(t);
        if (time === null) return [];
        return [
          {
            time,
            temperature: at(hourly.temperature_2m, i),
            precipitation: nonnegative(at(hourly.precipitation, i)),
            wind: nonnegative(at(hourly.wind_speed_10m, i)),
          },
        ];
      });
      if (!hours.some((h) => h.temperature !== null))
        throw new WeatherDataError(`${model.name} has no values for this location.`);
      return { ...model, hours, fetchedAt: result.fetchedAt };
    }),
  );
  signal?.throwIfAborted();
  const available = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (!available.length)
    throw new WeatherDataError('Neither comparison model is available. Try again later.');
  return available;
}

export async function fetchAirQuality(place: Place, signal?: AbortSignal): Promise<AirQuality> {
  const result = await requestJson(
    url(AIR, {
      ...coordinates(place),
      current: 'us_aqi,pm2_5,pm10',
      timeformat: 'unixtime',
      timezone: 'auto',
    }),
    20 * 60_000,
    signal,
  );
  const current = record(record(result.value).current),
    time = epoch(current.time);
  if (
    time === null ||
    [current.us_aqi, current.pm2_5, current.pm10].every((x) => nonnegative(x) === null)
  )
    throw new WeatherDataError('Air-quality estimates are unavailable for this location.');
  return {
    time,
    fetchedAt: result.fetchedAt,
    usAqi: nonnegative(current.us_aqi),
    pm25: nonnegative(current.pm2_5),
    pm10: nonnegative(current.pm10),
    source: 'CAMS via Open-Meteo · model estimate',
  };
}

function officialLink(candidate: unknown, fallback: string): string {
  try {
    const parsed = new URL(str(candidate, 2000));
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'weather.gov' ||
        parsed.hostname.endsWith('.weather.gov') ||
        parsed.hostname === 'noaa.gov' ||
        parsed.hostname.endsWith('.noaa.gov'))
      ? parsed.href
      : fallback;
  } catch {
    return fallback;
  }
}
function alertGeometry(value: unknown): unknown | null {
  const geometry = record(value);
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
  const isPoint = (v: unknown) =>
    Array.isArray(v) &&
    v.length >= 2 &&
    number(v[0]) !== null &&
    number(v[1]) !== null &&
    Math.abs(v[0] as number) <= 180 &&
    Math.abs(v[1] as number) <= 90;
  const isRing = (v: unknown) =>
    Array.isArray(v) && v.length >= 4 && v.length <= 10_000 && v.every(isPoint);
  const isPolygon = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(isRing);
  return (
    geometry.type === 'Polygon'
      ? isPolygon(geometry.coordinates)
      : Array.isArray(geometry.coordinates) &&
        geometry.coordinates.length <= 100 &&
        geometry.coordinates.every(isPolygon)
  )
    ? value
    : null;
}

export async function fetchAlerts(place: Place, signal?: AbortSignal): Promise<AlertResult> {
  const location = coordinates(place);
  const code = place.countryCode.toUpperCase();
  if (!['US', 'PR', 'VI', 'GU', 'AS', 'MP'].includes(code))
    return fetchInternationalAlerts(place, signal);
  const result = await requestJson(
    url(NWS, { point: `${location.latitude},${location.longitude}` }),
    60_000,
    signal,
  );
  const features = record(result.value).features;
  if (!Array.isArray(features))
    throw new WeatherDataError(
      'The warning feed is unavailable. Check weather.gov for current warnings.',
    );
  const now = Date.now(),
    seen = new Set<string>();
  const fallback = `https://forecast.weather.gov/MapClick.php?lat=${location.latitude}&lon=${location.longitude}`;
  const alerts: WeatherAlert[] = [];
  for (const raw of features.slice(0, 100)) {
    const feature = record(raw),
      p = record(feature.properties);
    if (p.status !== 'Actual' || !['Alert', 'Update'].includes(String(p.messageType))) continue;
    const expires = stamp(p.expires),
      ends = stamp(p.ends),
      effective = stamp(p.effective),
      sent = stamp(p.sent);
    if (
      expires === null ||
      expires <= now ||
      (ends !== null && ends <= now) ||
      sent === null ||
      effective === null ||
      effective > now ||
      sent > now + 300_000 ||
      expires <= sent ||
      expires <= effective
    )
      continue;
    const id = str(p.id, 2000) || str(feature.id, 2000);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    alerts.push({
      id,
      title: str(p.headline, 1000) || str(p.event),
      event: str(p.event),
      severity: str(p.severity),
      area: str(p.areaDesc, 4000),
      sent,
      effective,
      expires: Math.min(expires, ends ?? expires),
      description: str(p.description, 20_000),
      instruction: str(p.instruction, 20_000),
      source: str(p.senderName) || 'National Weather Service',
      url: officialLink(p.web, officialLink(id, fallback)),
      geometry: alertGeometry(feature.geometry),
    });
  }
  const order: Record<string, number> = {
    Extreme: 0,
    Severe: 1,
    Moderate: 2,
    Minor: 3,
    Unknown: 4,
  };
  alerts.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4));
  return {
    status: 'available',
    alerts,
    fetchedAt: result.fetchedAt,
    source: 'US National Weather Service',
    officialUrl: fallback,
    scope: 'point',
    scopeLabel: place.name,
    partial: false,
    coverage:
      'NWS point warnings in the United States and supported territories. An empty response is not a safety guarantee.',
  };
}

function warningLink(candidate: unknown): string {
  const u = new URL(str(candidate, 4000));
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    ![
      'severeweather.wmo.int',
      'sachet.ndma.gov.in',
      'mausam.imd.gov.in',
      'publicalert.pagasa.dost.gov.ph',
      'pagasa.dost.gov.ph',
      'www.pagasa.dost.gov.ph',
      'www.bmkg.go.id',
    ].includes(u.hostname)
  )
    throw new WeatherDataError('The warning service returned an invalid source link.');
  return u.href;
}

async function fetchInternationalAlerts(place: Place, signal?: AbortSignal): Promise<AlertResult> {
  const params = new URLSearchParams({
    lat: place.latitude.toFixed(4),
    lon: place.longitude.toFixed(4),
    country: place.countryCode.toUpperCase(),
    admin: (place.admin ?? '').slice(0, 100),
    name: place.name.slice(0, 100),
  });
  const response = await requestJson(`/api/alerts?${params}`, 60_000, signal);
  const result = record(response.value);
  const fetchedAt = number(result.fetchedAt),
    now = Date.now();
  if (
    !['available', 'unsupported'].includes(String(result.status)) ||
    !Array.isArray(result.alerts) ||
    result.alerts.length > 100 ||
    fetchedAt === null ||
    fetchedAt > now + 5000 ||
    (result.status === 'available' && now - fetchedAt > 120_000) ||
    !['point', 'region', 'country'].includes(String(result.scope)) ||
    typeof result.partial !== 'boolean'
  )
    throw new WeatherDataError('The warning service returned an incomplete or stale response.');
  const alerts: WeatherAlert[] = [];
  const seen = new Set<string>();
  for (const raw of result.alerts) {
    const a = record(raw),
      sent = number(a.sent),
      effective = number(a.effective),
      expires = number(a.expires),
      id = str(a.id, 2000);
    if (
      !id ||
      seen.has(id) ||
      sent === null ||
      effective === null ||
      expires === null ||
      effective > now ||
      sent > now + 300000 ||
      expires <= now ||
      expires <= sent ||
      expires <= effective
    )
      continue;
    seen.add(id);
    alerts.push({
      id,
      sent,
      effective,
      expires,
      title: str(a.title, 1000),
      event: str(a.event),
      severity: str(a.severity, 100),
      area: str(a.area, 4000),
      description: str(a.description, 20000),
      instruction: str(a.instruction, 20000),
      source: str(a.source),
      url: warningLink(a.url),
      geometry: alertGeometry(a.geometry),
    });
  }
  const feedUpdatedAt = number(result.feedUpdatedAt);
  let checks: AlertSourceCheck[] | undefined;
  if (result.checks !== undefined) {
    if (!Array.isArray(result.checks) || result.checks.length > 4)
      throw new WeatherDataError('The warning service returned invalid source checks.');
    checks = result.checks.map((raw) => {
      const check = record(raw),
        checkedAt = number(check.fetchedAt),
        published = number(check.feedUpdatedAt);
      if (
        !['available', 'unavailable', 'unsupported'].includes(String(check.status)) ||
        !str(check.id, 80) ||
        !str(check.name, 200) ||
        (check.status === 'available' &&
          (checkedAt === null || checkedAt > now + 5000 || now - checkedAt > 120000))
      )
        throw new WeatherDataError('The warning service returned incomplete source checks.');
      return {
        id: str(check.id, 80),
        name: str(check.name, 200),
        url: warningLink(check.url),
        status: check.status as AlertSourceCheck['status'],
        fetchedAt: checkedAt,
        feedUpdatedAt: published !== null && published <= now + 300000 ? published : null,
        coverage: str(check.coverage, 2500),
      };
    });
  }
  return {
    status: result.status as AlertResult['status'],
    alerts: result.status === 'available' ? alerts : [],
    fetchedAt,
    source: str(result.source),
    coverage: str(result.coverage, 4000),
    officialUrl: warningLink(result.officialUrl),
    scope: result.scope as AlertResult['scope'],
    scopeLabel: str(result.scopeLabel),
    partial: result.partial,
    feedUpdatedAt: feedUpdatedAt !== null && feedUpdatedAt <= now + 300000 ? feedUpdatedAt : null,
    ...(checks ? { checks } : {}),
  };
}

export function weatherLabel(code: number | null | undefined): string {
  if (code === null || code === undefined || !Number.isFinite(code))
    return 'Conditions unavailable';
  if (code === 0) return 'Clear sky';
  if (code === 1) return 'Mainly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if ([45, 48].includes(code)) return 'Fog';
  if ([51, 53, 55].includes(code)) return 'Drizzle';
  if ([56, 57].includes(code)) return 'Freezing drizzle';
  if ([61, 63, 65].includes(code)) return 'Rain';
  if ([66, 67].includes(code)) return 'Freezing rain';
  if ([71, 73, 75, 77].includes(code)) return 'Snow';
  if ([80, 81, 82].includes(code)) return 'Rain showers';
  if ([85, 86].includes(code)) return 'Snow showers';
  if ([95, 96, 99].includes(code)) return 'Thunderstorm';
  return 'Conditions unavailable';
}
