import type { Place } from './types';

/** GDACS is global humanitarian-impact awareness, not a local warning service.
 * API: https://www.gdacs.org/gdacsapi/swagger/index.html
 * Pagination: https://www.gdacs.org/Documents/2025/GDACS_API_quickstart_v1.pdf
 */
export const GDACS_SOURCE = 'https://www.gdacs.org/';
export const GDACS_RECENT_DAYS = 14;
export const GDACS_STALE_MS = 30 * 60_000;
const ENDPOINT = 'https://www.gdacs.org/gdacsapi/api/Events/geteventlist/SEARCH';
const DAY = 86_400_000;
const CACHE_MS = 10 * 60_000;
const MAX_BYTES = 2_000_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
export type DisasterKind = 'TC' | 'FL' | 'WF';
export interface DisasterEvent {
  id: string;
  kind: DisasterKind;
  title: string;
  country: string;
  latitude: number;
  longitude: number;
  impact: 'Red' | 'Orange' | 'Green' | 'Unknown';
  startsAt: number;
  endsAt: number;
  updatedAt: number | null;
  source: string;
  reportUrl: string;
  provisional: boolean;
}
export interface DisasterFeed {
  events: DisasterEvent[];
  fetchedAt: number;
  since: number;
  truncated: boolean;
  partial: boolean;
  recordsRead: number;
}
export interface NearbyDisaster extends DisasterEvent {
  distanceKm: number;
}
let cached: DisasterFeed | null = null;

export function clearDisasterCache(): void {
  cached = null;
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : '');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function validCoordinates(lat: unknown, lon: unknown): lat is number {
  return finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** GDACS event pages label matching report-period values UTC. Their JSON omits Z.
 * Normalize explicitly instead of letting the visitor's local timezone reinterpret it.
 */
export function gdacsTimestamp(value: unknown): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
  )
    return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms >= Date.UTC(2200, 0, 1)) return null;
  // Date.parse normalizes impossible dates even when a timezone is present.
  // Check the original calendar date, not the UTC date shifted by its offset.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value.slice(0, 10))
    return null;
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    return null;
  return ms;
}

export function parseDisasterFeatures(value: unknown): DisasterEvent[] {
  const data = obj(value);
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features))
    throw new Error('GDACS returned an unexpected report format. Use the official GDACS site.');
  return data.features.slice(0, PAGE_SIZE).flatMap((raw) => {
    const feature = obj(raw),
      p = obj(feature.properties),
      geometry = obj(feature.geometry);
    const kind = text(p.eventtype);
    if (
      !['TC', 'FL', 'WF'].includes(kind) ||
      geometry.type !== 'Point' ||
      !Array.isArray(geometry.coordinates)
    )
      return [];
    const [longitude, latitude] = geometry.coordinates;
    if (!validCoordinates(latitude, longitude)) return [];
    const eventId =
      typeof p.eventid === 'number' && Number.isSafeInteger(p.eventid) && p.eventid > 0
        ? String(p.eventid)
        : /^\d{1,16}$/.test(text(p.eventid))
          ? String(p.eventid)
          : '';
    const startsAt = gdacsTimestamp(p.fromdate),
      endsAt = gdacsTimestamp(p.todate);
    if (!eventId || startsAt === null || endsAt === null || startsAt > endsAt) return [];
    const impact = text(p.alertlevel);
    // Build the official report URL from validated identifiers. Never trust API HTML or arbitrary URLs.
    const params = new URLSearchParams({ eventtype: kind, eventid: eventId });
    if (Number.isSafeInteger(p.episodeid) && Number(p.episodeid) > 0)
      params.set('episodeid', String(p.episodeid));
    return [
      {
        id: `${kind}-${eventId}`,
        kind: kind as DisasterKind,
        title:
          text(p.name) ||
          `${kind === 'TC' ? 'Tropical cyclone' : kind === 'FL' ? 'Flood' : 'Wildfire'} report`,
        country: text(p.country, 500),
        latitude,
        longitude: longitude as number,
        impact: (['Red', 'Orange', 'Green'].includes(impact)
          ? impact
          : 'Unknown') as DisasterEvent['impact'],
        startsAt,
        endsAt,
        updatedAt: gdacsTimestamp(p.datemodified),
        source: text(p.source, 100) || 'GDACS',
        reportUrl: `https://www.gdacs.org/report.aspx?${params}`,
        provisional: p.istemporary === 'true' || p.istemporary === true,
      },
    ];
  });
}

/** Great-circle distance to an event representative point, never a hazard radius. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  if (!validCoordinates(lat1, lon1) || !validCoordinates(lat2, lon2))
    throw new Error('Invalid coordinates for regional report search.');
  const rad = Math.PI / 180,
    dLat = (lat2 - lat1) * rad,
    dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return (
    6371.0088 *
    2 *
    Math.atan2(Math.sqrt(Math.max(0, Math.min(1, a))), Math.sqrt(Math.max(0, 1 - a)))
  );
}

export function nearbyDisasters(
  events: DisasterEvent[],
  place: Pick<Place, 'latitude' | 'longitude'>,
  radiusKm: number,
  now = Date.now(),
): NearbyDisaster[] {
  if (![250, 1000, 5000].includes(radiusKm))
    throw new Error('Choose a supported report-search radius.');
  if (!validCoordinates(place.latitude, place.longitude)) return [];
  return events
    .filter((e) => e.endsAt >= now - GDACS_RECENT_DAYS * DAY && e.startsAt <= now + DAY)
    .map((e) => ({
      ...e,
      distanceKm: distanceKm(place.latitude, place.longitude, e.latitude, e.longitude),
    }))
    .filter((e) => e.distanceKm <= radiusKm)
    .sort((a, b) => (b.updatedAt ?? b.endsAt) - (a.updatedAt ?? a.endsAt));
}

async function page(target: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 12_000);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/geo+json, application/json' },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(
        `GDACS reports are unavailable (HTTP ${response.status}). Check the official source.`,
      );
    }
    // GDACS can return an HTTP 200 HTML page to cross-origin browser requests.
    // That is a provider response, not an empty or malformed disaster snapshot.
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
      void response.body?.cancel().catch(() => {});
      throw new Error(
        'GDACS returned a web page instead of report data. Open the official GDACS source or try again later.',
      );
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new Error('The GDACS response could not be safely read. Use the official source.');
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) {
          throw new Error('The GDACS response exceeded the size limit.');
        }
        chunks.push(part.value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(all));
    } catch {
      throw new Error('GDACS returned an unreadable report. Use the official source.');
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (timedOut)
      throw new Error('GDACS reports timed out. Retry later or open the official source.');
    if (error instanceof TypeError)
      throw new Error('Cannot reach GDACS. Check your connection or use the official source.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function fetchDisasters(signal?: AbortSignal, force = false): Promise<DisasterFeed> {
  signal?.throwIfAborted();
  const now = Date.now();
  if (!force && cached && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < CACHE_MS)
    return cached;
  const since = now - GDACS_RECENT_DAYS * DAY;
  const events = new Map<string, DisasterEvent>();
  let recordsRead = 0,
    truncated = false,
    partial = false;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const params = new URLSearchParams({
      eventlist: 'TC;FL;WF',
      alertlevel: 'red;orange;green',
      fromDate: new Date(since).toISOString().slice(0, 10),
      toDate: new Date(now + DAY).toISOString().slice(0, 10),
      pageSize: String(PAGE_SIZE),
      pageNumber: String(pageNumber),
    });
    let raw: unknown, parsed: DisasterEvent[];
    try {
      raw = await page(`${ENDPOINT}?${params}`, signal);
      parsed = parseDisasterFeatures(raw);
    } catch (error) {
      if (signal?.aborted || pageNumber === 1) throw error;
      partial = true;
      break;
    }
    const count = (obj(raw).features as unknown[]).length;
    recordsRead += Math.min(count, PAGE_SIZE);
    for (const event of parsed) {
      const previous = events.get(event.id);
      if (!previous || (event.updatedAt ?? event.endsAt) > (previous.updatedAt ?? previous.endsAt))
        events.set(event.id, event);
    }
    if (count < PAGE_SIZE) break;
    if (pageNumber === MAX_PAGES) truncated = true;
  }
  const result: DisasterFeed = {
    events: [...events.values()],
    fetchedAt: Date.now(),
    since,
    truncated,
    partial,
    recordsRead,
  };
  cached = result;
  return result;
}
