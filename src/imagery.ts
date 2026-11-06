/** NASA GIBS WMTS imagery. Dates always come from the provider's advertised domains. */
export interface ImagerySource {
  id: string;
  name: string;
  kind: 'infrared' | 'daily';
  matrix: string;
  maxNativeZoom: number;
  format: 'png' | 'jpeg';
  resolution: string;
  coverage: string;
  cadence: string;
  attribution: string;
}
const NASA = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
export const DAILY_IMAGERY: ImagerySource = {
  id: 'MODIS_Terra_CorrectedReflectance_TrueColor',
  name: 'Terra MODIS · true color',
  kind: 'daily',
  matrix: 'GoogleMapsCompatible_Level9',
  maxNativeZoom: 9,
  format: 'jpeg',
  resolution: '250 m source imagery',
  coverage: 'Global daytime overpasses; clouds and missing swaths can obscure the surface.',
  cadence: 'Daily composite',
  attribution: 'NASA EOSDIS GIBS / Terra MODIS',
};
const GEO = [
  {
    id: 'GOES-East_ABI_Band13_Clean_Infrared',
    name: 'GOES-East · infrared',
    longitude: -75.2,
    coverage: 'Americas and adjacent Atlantic. Coverage degrades near the disk edge.',
    attribution: 'NASA GIBS / NOAA / NASA SPoRT',
  },
  {
    id: 'GOES-West_ABI_Band13_Clean_Infrared',
    name: 'GOES-West · infrared',
    longitude: -137.2,
    coverage: 'Pacific and western Americas. Coverage degrades near the disk edge.',
    attribution: 'NASA GIBS / NOAA / NASA SPoRT',
  },
  {
    id: 'Himawari_AHI_Band13_Clean_Infrared',
    name: 'Himawari · infrared',
    longitude: 140.7,
    coverage: 'Asia–Pacific. India is near the disk edge; coverage and resolution vary.',
    attribution: 'NASA GIBS / JMA / NASA SPoRT',
  },
];
export function normalizeLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) throw new Error('Invalid longitude');
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}
export function regionalImagery(latitude: number, longitude: number): ImagerySource | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 65)
    return null;
  const lat = (latitude * Math.PI) / 180;
  const candidates = GEO.map((source) => ({
    source,
    cosine:
      Math.cos(lat) * Math.cos((normalizeLongitude(longitude - source.longitude) * Math.PI) / 180),
  })).sort((a, b) => b.cosine - a.cosine);
  // Conservative useful disk coverage; these are display-selection bounds, not a warning area.
  if (candidates[0].cosine < Math.cos((72 * Math.PI) / 180)) return null;
  const source = candidates[0].source;
  return {
    ...source,
    kind: 'infrared',
    matrix: 'GoogleMapsCompatible_Level6',
    maxNativeZoom: 6,
    format: 'png',
    resolution: 'About 2 km at satellite nadir; coarser toward disk edge',
    cadence: '10-minute frames, with processing delay',
  };
}
export function imageryForPlace(latitude: number, longitude: number): ImagerySource[] {
  const regional = regionalImagery(latitude, longitude);
  return regional ? [regional, DAILY_IMAGERY] : [DAILY_IMAGERY];
}
function strictDate(text: string): number {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/.test(text)) return NaN;
  const value = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== text.slice(0, 10))
    return NaN;
  return value;
}
/** Expand only supported bounded intervals, respecting gaps and never inventing future frames. */
export function parseDomainTimes(xml: string, source: ImagerySource, now = Date.now()): string[] {
  if (xml.length > 200_000) throw new Error('Imagery metadata exceeded the size limit.');
  const match = xml.match(/<(?:\w+:)?Domain(?:\s[^>]*)?>([^<]*)<\/(?:\w+:)?Domain>/);
  if (!match) throw new Error('NASA did not return imagery time metadata.');
  const latest = new Set<number>();
  const period = source.kind === 'daily' ? 86400_000 : 600_000;
  const cutoff = now - (source.kind === 'daily' ? 7 * 86400_000 : 24 * 3600_000);
  for (const segment of match[1].split(',')) {
    const parts = segment.trim().split('/');
    const first = strictDate(parts[0]);
    if (!Number.isFinite(first)) continue;
    if (parts.length === 1) {
      if (first >= cutoff && first <= now) latest.add(first);
      continue;
    }
    if (parts.length !== 3 || parts[2] !== (source.kind === 'daily' ? 'P1D' : 'PT10M')) continue;
    const last = strictDate(parts[1]);
    if (!Number.isFinite(last) || last < first) continue;
    const start = first + Math.max(0, Math.ceil((cutoff - first) / period)) * period;
    for (
      let time = start, count = 0;
      time <= Math.min(last, now) && count < 150;
      time += period, count++
    )
      latest.add(time);
  }
  return [...latest]
    .sort((a, b) => a - b)
    .slice(source.kind === 'daily' ? -5 : -12)
    .map((time) =>
      source.kind === 'daily'
        ? new Date(time).toISOString().slice(0, 10)
        : new Date(time).toISOString().replace('.000Z', 'Z'),
    );
}
export function imageryTileUrl(source: ImagerySource, frame: string): string {
  if (!Number.isFinite(strictDate(frame))) throw new Error('Invalid imagery frame date.');
  if (!/^[A-Za-z0-9_-]+$/.test(source.id) || !/^GoogleMapsCompatible_Level\d+$/.test(source.matrix))
    throw new Error('Invalid imagery source.');
  if (source.kind === 'infrared' && frame.length === 10)
    throw new Error('Infrared imagery requires an observed timestamp.');
  return `${NASA}/${source.id}/default/${frame}/${source.matrix}/{z}/{y}/{x}.${source.format}`;
}
export function domainUrl(source: ImagerySource, now = Date.now()): string {
  // GIBS rejects fractional seconds. Snap query bounds to the product cadence,
  // so a clipped provider interval cannot imply observations between actual frames.
  const period = source.kind === 'daily' ? 86400_000 : 600_000;
  const endTime = Math.floor(now / period) * period;
  const format = (time: number) =>
    source.kind === 'daily'
      ? new Date(time).toISOString().slice(0, 10)
      : new Date(time).toISOString().replace('.000Z', 'Z');
  const start = format(endTime - (source.kind === 'daily' ? 7 * 86400_000 : 24 * 3600_000));
  const end = format(endTime);
  // GIBS' CGI requires literal ISO separators in TIME (percent-encoded ':'/'/' return 400).
  return `${NASA}/wmts.cgi?${new URLSearchParams({ SERVICE: 'WMTS', REQUEST: 'DescribeDomains', VERSION: '1.0.0', LAYER: source.id, TILEMATRIXSET: source.matrix })}&TIME=${start}/${end}`;
}
const domainCache = new Map<string, { at: number; frames: string[] }>();
export async function fetchImageryFrames(
  source: ImagerySource,
  signal?: AbortSignal,
  force = false,
): Promise<string[]> {
  const cached = domainCache.get(source.id);
  if (!force && cached && Date.now() - cached.at < 5 * 60_000) return cached.frames;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, 15_000);
  try {
    const response = await fetch(domainUrl(source), { signal: controller.signal });
    if (!response.ok) throw new Error(`NASA imagery metadata unavailable (${response.status}).`);
    const length = Number(response.headers.get('content-length'));
    if (length > 200_000) throw new Error('Imagery metadata exceeded the size limit.');
    const frames = parseDomainTimes(await response.text(), source);
    if (!frames.length) throw new Error('NASA has not advertised recent imagery for this layer.');
    domainCache.set(source.id, { at: Date.now(), frames });
    return frames;
  } catch (error) {
    // The map shows this message. A timeout abort or a network failure would
    // otherwise surface as "This operation was aborted" or "Failed to fetch".
    if (signal?.aborted) throw error;
    if (timedOut)
      throw new Error('NASA imagery metadata timed out. Check your connection or try again later.');
    if (error instanceof TypeError)
      throw new Error(
        'NASA imagery metadata could not be reached. Check your connection or try again later.',
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
export function frameLabel(frame: string, kind: ImagerySource['kind']): string {
  return kind === 'daily'
    ? `${frame} · daily composite`
    : new Date(frame).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      }) + ' UTC';
}
export function isFrameStale(
  frame: string,
  kind: ImagerySource['kind'],
  now = Date.now(),
): boolean {
  const time = strictDate(frame);
  return !Number.isFinite(time) || now - time > (kind === 'daily' ? 3 * 86400_000 : 90 * 60_000);
}
