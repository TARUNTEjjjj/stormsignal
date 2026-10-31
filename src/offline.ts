import type { AlertResult, Forecast, Place, WeatherAlert } from './types';

export const OFFLINE_PACK_KEY = 'stormsignal:offline-packs:v1';
export const MAX_BRIEFINGS = 3;
export const MAX_BRIEFING_BYTES = 750_000;
const HOUR = 3_600_000;
const MIN_TIME = Date.UTC(2000, 0, 1);
const MAX_TIME = Date.UTC(2100, 0, 1);
const NWS_COUNTRIES = ['US', 'PR', 'VI', 'GU', 'AS', 'MP'];
export type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface BriefingHour {
  time: number;
  temperature: number | null;
  apparent: number | null;
  precipitation: number | null;
  probability: number | null;
  gust: number | null;
}
export type BriefingAlert = Omit<WeatherAlert, 'geometry'>;
export interface OfflineBriefingData {
  version: 1;
  id: string;
  savedAt: number;
  place: Place;
  forecast: {
    fetchedAt: number;
    timezone: string;
    source: string;
    current: BriefingHour;
    hours: BriefingHour[];
  };
  warnings: {
    status: 'available' | 'unsupported' | 'unavailable';
    fetchedAt: number | null;
    source: string;
    coverage: string;
    officialUrl: string;
    alerts: BriefingAlert[];
    omitted: number;
  };
}
export interface BriefingResult {
  briefings: OfflineBriefingData[];
  error: string | null;
}

const record = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('Invalid record');
  if (['__proto__', 'prototype', 'constructor'].some((key) => Object.hasOwn(value, key)))
    throw new Error('Invalid record keys');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()))
    throw new Error('Invalid text');
  return value;
};
const time = (value: unknown): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_TIME ||
    value >= MAX_TIME
  )
    throw new Error('Invalid timestamp');
  return value;
};
function quantity(value: unknown, min: number, max: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error('Invalid weather value');
  return value;
}
function zone(value: unknown): string {
  const result = text(value, 100);
  new Intl.DateTimeFormat('en', { timeZone: result });
  return result;
}
function cleanPlace(value: unknown): Place {
  const p = record(value);
  const latitude = quantity(p.latitude, -90, 90);
  const longitude = quantity(p.longitude, -180, 180);
  if (latitude === null || longitude === null) throw new Error('Missing coordinates');
  const countryCode = text(p.countryCode, 2, true).toUpperCase();
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) throw new Error('Invalid country');
  return {
    id: text(p.id, 300),
    name: text(p.name, 150),
    country: text(p.country, 200, true),
    countryCode,
    latitude,
    longitude,
    ...(p.timezone == null ? {} : { timezone: zone(p.timezone) }),
    ...(p.admin == null ? {} : { admin: text(p.admin, 200, true) }),
  };
}
function cleanHour(value: unknown): BriefingHour {
  const h = record(value);
  return {
    time: time(h.time),
    temperature: quantity(h.temperature, -150, 100),
    apparent: quantity(h.apparent, -200, 150),
    precipitation: quantity(h.precipitation, 0, 2000),
    probability: quantity(h.probability, 0, 100),
    gust: quantity(h.gust, 0, 1000),
  };
}
export function briefingId(place: Place): string {
  return `${place.latitude.toFixed(4)},${place.longitude.toFixed(4)}`;
}
export function officialBriefingUrl(place: Place): string {
  return NWS_COUNTRIES.includes(place.countryCode)
    ? 'https://www.weather.gov/'
    : place.countryCode === 'IN'
      ? 'https://mausam.imd.gov.in/'
      : 'https://severeweather.wmo.int/';
}
function safeUrl(value: unknown, place: Place): string {
  const candidate = text(value, 4000);
  const u = new URL(candidate);
  const hosts = ['weather.gov', 'mausam.imd.gov.in', 'severeweather.wmo.int'];
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    !hosts.some(
      (host) =>
        u.hostname === host || (host === 'weather.gov' && u.hostname.endsWith('.weather.gov')),
    )
  )
    throw new Error('Invalid source URL');
  return u.href;
}
function cleanAlert(value: unknown, place: Place, savedAt: number): BriefingAlert {
  const a = record(value);
  const sent = time(a.sent),
    effective = time(a.effective),
    expires = time(a.expires);
  if (sent > savedAt + 300000 || expires <= effective || expires <= sent)
    throw new Error('Invalid warning timing');
  return {
    id: text(a.id, 2000),
    title: text(a.title, 1000),
    event: text(a.event, 400),
    severity: text(a.severity, 100),
    area: text(a.area, 4000, true),
    sent,
    effective,
    expires,
    description: text(a.description, 20000, true),
    instruction: text(a.instruction, 20000, true),
    source: text(a.source, 400),
    url: safeUrl(a.url, place),
  };
}

/** Rebuild from a strict bounded shape. Never trust saved status as a live warning. */
export function validateBriefing(value: unknown, now = Date.now()): OfflineBriefingData {
  time(now);
  const v = record(value);
  if (v.version !== 1) throw new Error('Unknown briefing version');
  const place = cleanPlace(v.place),
    savedAt = time(v.savedAt);
  if (savedAt > now + 300000 || v.id !== briefingId(place))
    throw new Error('Invalid briefing identity');
  const f = record(v.forecast),
    fetchedAt = time(f.fetchedAt),
    current = cleanHour(f.current);
  if (
    fetchedAt > savedAt + 300000 ||
    savedAt - fetchedAt > HOUR ||
    Math.abs(current.time - fetchedAt) > 2 * HOUR
  )
    throw new Error('Invalid forecast timing');
  if (!Array.isArray(f.hours) || !f.hours.length || f.hours.length > 24)
    throw new Error('Invalid hourly sample');
  const hours = f.hours.map(cleanHour);
  if (
    hours.some(
      (h, i) =>
        h.time < savedAt - HOUR ||
        h.time > savedAt + 24 * HOUR ||
        (i > 0 && h.time <= hours[i - 1].time),
    )
  )
    throw new Error('Invalid forecast sequence');
  const w = record(v.warnings);
  if (!['available', 'unsupported', 'unavailable'].includes(w.status as string))
    throw new Error('Invalid warning coverage');
  const warningFetchedAt = w.fetchedAt === null ? null : time(w.fetchedAt);
  if (
    warningFetchedAt !== null &&
    (warningFetchedAt > savedAt + 300000 || savedAt - warningFetchedAt > 5 * 60000)
  )
    throw new Error('Invalid warning retrieval time');
  if (
    !Array.isArray(w.alerts) ||
    w.alerts.length > 5 ||
    !Number.isInteger(w.omitted) ||
    (w.omitted as number) < 0 ||
    (w.omitted as number) > 100
  )
    throw new Error('Invalid warning list');
  if (
    w.status === 'available' &&
    (!NWS_COUNTRIES.includes(place.countryCode) || warningFetchedAt === null)
  )
    throw new Error('Invalid automatic coverage');
  if (w.status !== 'available' && (w.alerts.length || w.omitted))
    throw new Error('Unsupported warning content');
  if (w.status === 'unavailable' && warningFetchedAt !== null)
    throw new Error('Unverified retrieval time');
  const alerts = w.alerts.map((a) => cleanAlert(a, place, savedAt));
  if (new Set(alerts.map((a) => a.id)).size !== alerts.length) throw new Error('Duplicate warning');
  return {
    version: 1,
    id: briefingId(place),
    savedAt,
    place,
    forecast: {
      fetchedAt,
      timezone: zone(f.timezone),
      source: text(f.source, 400),
      current,
      hours,
    },
    warnings: {
      status: w.status as OfflineBriefingData['warnings']['status'],
      fetchedAt: warningFetchedAt,
      source: text(w.source, 400),
      coverage: text(w.coverage, 1500),
      officialUrl: safeUrl(w.officialUrl, place),
      alerts,
      omitted: w.omitted as number,
    },
  };
}

/** Called only for a deliberate save, after fresh data has actually arrived. */
export function createBriefing(
  place: Place,
  forecast: Forecast,
  alerts: AlertResult | null,
  now = Date.now(),
): OfflineBriefingData {
  const p = cleanPlace(place);
  const warningFresh =
    alerts && alerts.fetchedAt <= now + 300000 && now - alerts.fetchedAt <= 5 * 60000;
  const warnings: OfflineBriefingData['warnings'] = warningFresh
    ? {
        status: alerts.status,
        fetchedAt: alerts.fetchedAt,
        source: alerts.source,
        coverage: alerts.coverage,
        officialUrl: alerts.officialUrl,
        alerts: alerts.alerts.slice(0, 5).map(({ geometry: _geometry, ...a }) => a),
        omitted: Math.max(0, alerts.alerts.length - 5),
      }
    : {
        status: 'unavailable',
        fetchedAt: null,
        source: 'Official warning feed not verified',
        coverage:
          'No fresh warning snapshot was available when this briefing was saved. This is not an all-clear.',
        officialUrl: officialBriefingUrl(p),
        alerts: [],
        omitted: 0,
      };
  return validateBriefing(
    {
      version: 1,
      id: briefingId(p),
      savedAt: now,
      place: p,
      forecast: {
        fetchedAt: forecast.fetchedAt,
        timezone: forecast.timezone,
        source: forecast.source,
        current: cleanHour(forecast.current),
        hours: forecast.hours
          .filter((h) => h.time >= now - HOUR && h.time <= now + 24 * HOUR)
          .slice(0, 24)
          .map(cleanHour),
      },
      warnings,
    },
    now,
  );
}

export function loadBriefings(
  storage: Pick<StorageAccess, 'getItem'>,
  now = Date.now(),
): BriefingResult {
  try {
    const raw = storage.getItem(OFFLINE_PACK_KEY);
    if (raw === null) return { briefings: [], error: null };
    if (new TextEncoder().encode(raw).byteLength > MAX_BRIEFING_BYTES)
      throw new Error('Oversized storage');
    const value = record(JSON.parse(raw));
    if (
      value.version !== 1 ||
      !Array.isArray(value.briefings) ||
      value.briefings.length > MAX_BRIEFINGS
    )
      throw new Error('Invalid storage');
    const briefings = value.briefings.map((item) => validateBriefing(item, now));
    if (new Set(briefings.map((b) => b.id)).size !== briefings.length)
      throw new Error('Duplicate location');
    return { briefings, error: null };
  } catch {
    return {
      briefings: [],
      error:
        'Saved briefings could not be read. Browser storage may be blocked or the saved data is invalid. Download any open briefing before clearing saved briefings.',
    };
  }
}
function writeBriefings(storage: StorageAccess, briefings: OfflineBriefingData[]): BriefingResult {
  const raw = JSON.stringify({ version: 1, briefings });
  if (new TextEncoder().encode(raw).byteLength > MAX_BRIEFING_BYTES)
    return {
      briefings,
      error: 'This briefing is too large to save. Download a text copy instead.',
    };
  try {
    storage.setItem(OFFLINE_PACK_KEY, raw);
    return { briefings, error: null };
  } catch {
    return {
      briefings,
      error:
        'Browser storage is unavailable or full. The change was not saved. Download a text briefing instead.',
    };
  }
}
export function saveBriefing(
  storage: StorageAccess,
  briefing: OfflineBriefingData,
  now = Date.now(),
): BriefingResult {
  const existing = loadBriefings(storage, now);
  if (existing.error) return existing;
  try {
    const clean = validateBriefing(briefing, now);
    const next = [clean, ...existing.briefings.filter((b) => b.id !== clean.id)].slice(
      0,
      MAX_BRIEFINGS,
    );
    const result = writeBriefings(storage, next);
    return result.error ? { ...existing, error: result.error } : result;
  } catch {
    return {
      ...existing,
      error: 'The briefing is invalid and was not saved. Refresh the forecast before trying again.',
    };
  }
}
export function removeBriefing(
  storage: StorageAccess,
  id: string,
  now = Date.now(),
): BriefingResult {
  const existing = loadBriefings(storage, now);
  if (existing.error) return existing;
  const result = writeBriefings(
    storage,
    existing.briefings.filter((b) => b.id !== id),
  );
  return result.error ? { ...existing, error: result.error } : result;
}
export function clearBriefings(storage: StorageAccess): BriefingResult {
  try {
    storage.removeItem(OFFLINE_PACK_KEY);
    return { briefings: [], error: null };
  } catch {
    return { briefings: [], error: 'Browser storage could not be cleared.' };
  }
}
const utc = (value: number) =>
  new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
const numberText = (value: number | null, suffix: string) =>
  value === null ? 'unavailable' : `${value}${suffix}`;
export function briefingText(briefing: OfflineBriefingData, now = Date.now()): string {
  const b = validateBriefing(briefing, now);
  const lines = [
    'STORMSIGNAL — SAVED HISTORICAL BRIEFING',
    'NOT LIVE. Warnings may have changed or been cancelled. This is not a safety clearance.',
    `Location: ${b.place.name}, ${b.place.country} (${b.place.latitude}, ${b.place.longitude})`,
    `Saved: ${utc(b.savedAt)} | Exported: ${utc(now)}`,
    `Forecast retrieved: ${utc(b.forecast.fetchedAt)} | ${b.forecast.source}`,
    'The values below are the model forecast saved at that time, not current observations.',
    '',
    'Saved hourly forecast (each rainfall value is for one hour):',
    ...b.forecast.hours.map(
      (h) =>
        `${utc(h.time)}: ${numberText(h.temperature, ' °C')}; feels like ${numberText(h.apparent, ' °C')}; rain ${numberText(h.precipitation, ' mm')}; chance ${numberText(h.probability, '%')}; gust ${numberText(h.gust, ' km/h')}`,
    ),
    '',
    `Warning coverage at save: ${b.warnings.status.toUpperCase()}`,
    b.warnings.coverage,
    b.warnings.fetchedAt === null
      ? 'Warning feed was not verified.'
      : `Warning feed retrieved: ${utc(b.warnings.fetchedAt)}`,
    `Official source (internet required): ${b.warnings.officialUrl}`,
  ];
  if (!b.warnings.alerts.length)
    lines.push('No warning text was saved. This does not mean no danger.');
  for (const a of b.warnings.alerts)
    lines.push(
      '',
      `${a.event} — ${a.severity} — ${a.expires <= now ? 'PAST STATED EXPIRY' : 'SAVED COPY; CURRENT STATUS UNKNOWN'}`,
      a.title,
      `Area: ${a.area}`,
      `Issued: ${utc(a.sent)} | Effective: ${utc(a.effective)} | Stated expiry: ${utc(a.expires)}`,
      a.description,
      `Instructions as saved: ${a.instruction || 'No instructions were supplied; check the issuing authority.'}`,
      `Source: ${a.source} | ${a.url}`,
    );
  if (b.warnings.omitted)
    lines.push(
      `${b.warnings.omitted} additional warning(s) were not included in this limited snapshot.`,
    );
  lines.push(
    '',
    'For immediate danger, follow local authorities and local emergency services. A saved briefing cannot detect changing conditions, locate shelters, or choose safe routes.',
  );
  return lines.join('\n');
}
