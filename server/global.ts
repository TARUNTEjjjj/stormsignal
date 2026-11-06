import type { AlertResult, Place, WeatherAlert } from '../src/types.ts';
import { activeCapRecords, parseCap, type CapArea, type CapDocument, type CapInfo } from './cap.ts';
import { requestText, type TextOptions, type TextResult } from './http.ts';

const ORIGIN = 'https://severeweather.wmo.int';
const SOURCES = `${ORIGIN}/json/sources.json`;
const MAX_FEATURES = 40;
const MAX_DOCUMENTS = 6;
type RequestText = (url: string, options?: TextOptions) => Promise<TextResult>;
type RecordValue = Record<string, unknown>;
type Source = { id: string; member: string; name: string; englishId?: string };
type Candidate = {
  path: string;
  englishPath?: string;
  areas: Set<string>;
  geocodes: Set<string>;
  source: Source;
};
const CAP_PATH = /^[a-z0-9_-]+\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/[A-Za-z0-9_-]+\.xml$/;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown, max = 1000) => (typeof value === 'string' ? value.slice(0, max) : '');
const clean = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');

function sourcesFor(raw: string, country: string): Source[] {
  const list = record(JSON.parse(raw)).sources;
  if (!Array.isArray(list) || list.length > 1000)
    throw Error('The official warning source registry is unavailable.');
  return list.flatMap((item) => {
    const source = record(record(item).source);
    if (
      text(source.authorityCountry).toUpperCase() !== country ||
      source.sourceIsOfficial !== true ||
      source.capAlertFeedStatus !== 'operating'
    )
      return [];
    const id = text(source.sourceId, 100),
      member = text(source.memID, 10);
    if (!/^[a-z0-9_-]+$/.test(id) || !/^\d{1,4}$/.test(member)) return [];
    const languages = Array.isArray(source.byLanguage) ? source.byLanguage.map(record) : [];
    const preferred = languages.find((entry) => text(entry.code).startsWith('en')) ?? languages[0];
    return [
      {
        id,
        member,
        name: text(preferred?.name) || text(source.countryName),
        // SWIC's BMKG registry combines Indonesian and English feeds under its Indonesian ID.
        // Keep this an explicit issuer alias, never infer trust from an arbitrary similar prefix.
        englishId:
          country === 'ID' &&
          id === 'id-inatews-id' &&
          languages.some((entry) => text(entry.code) === 'en')
            ? 'id-inatews-en'
            : undefined,
      },
    ];
  });
}

/** Fixed-origin WFS read; coordinates are validated before interpolation. No arbitrary URL proxy. */
export function globalPointUrl(place: Pick<Place, 'latitude' | 'longitude'>): string {
  const { latitude, longitude } = place;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    throw Error('Invalid warning location.');
  const point = `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
  const filter =
    '<Filter xmlns="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml"><And><Intersects><PropertyName>wkb_geometry</PropertyName><gml:Point><gml:coordinates>' +
    point +
    '</gml:coordinates></gml:Point></Intersects><PropertyIsNotEqualTo><PropertyName>mem</PropertyName><Literal>0</Literal></PropertyIsNotEqualTo></And></Filter>';
  const url = new URL(`${ORIGIN}/f/ows/point-${longitude.toFixed(6)}-${latitude.toFixed(6)}.json`);
  url.search = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: 'local_postgis:postgis_geojsons',
    outputFormat: 'application/json',
    propertyName: 'event,areadesc,mem,gc,capurl,s,rlink',
    filter,
    maxFeatures: String(MAX_FEATURES + 1),
    sortBy: 's D',
  }).toString();
  return url.href;
}

function candidatesFor(raw: string, sources: Source[]): Candidate[] {
  const data = record(JSON.parse(raw));
  if (
    data.type !== 'FeatureCollection' ||
    !Array.isArray(data.features) ||
    data.features.length > MAX_FEATURES + 1
  )
    throw Error('The global warning query is unavailable.');
  const candidates = new Map<string, Candidate>();
  for (const feature of data.features.slice(0, MAX_FEATURES)) {
    const p = record(record(feature).properties),
      path = text(p.capurl, 300);
    if (!CAP_PATH.test(path)) continue;
    const source = sources.find(
      (source) => path.startsWith(`${source.id}/`) && source.member === text(p.mem),
    );
    if (!source) continue;
    let candidate = candidates.get(path);
    if (!candidate) {
      candidate = { path, areas: new Set<string>(), geocodes: new Set<string>(), source };
      candidates.set(path, candidate);
    }
    const related = text(p.rlink, 300);
    if (
      source.englishId &&
      CAP_PATH.test(related) &&
      related.startsWith(`${source.englishId}/`) &&
      related.slice(related.indexOf('/'), related.lastIndexOf('/')) ===
        path.slice(path.indexOf('/'), path.lastIndexOf('/'))
    )
      candidate.englishPath = related;
    const area = clean(text(p.areadesc, 8000));
    if (area) candidate.areas.add(area);
    for (const code of text(p.gc, 1000).split(/[;,]/))
      if (code.trim()) candidate.geocodes.add(code.trim());
  }
  return [...candidates.values()].slice(0, MAX_DOCUMENTS);
}

/** Inclusive boundary test; unwrap longitudes around the selected point for dateline crossings. */
export function capPolygonContains(
  polygon: number[][],
  latitude: number,
  longitude: number,
): boolean {
  if (polygon.length < 4) return false;
  let previous = ((polygon[0][1] - longitude + 540) % 360) - 180;
  const points = polygon.map(([lat, lon]) => {
    let x = ((lon - longitude + 540) % 360) - 180;
    while (x - previous > 180) x -= 360;
    while (x - previous < -180) x += 360;
    previous = x;
    return [x, lat - latitude];
  });
  return [0, -360, 360].some((origin) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [rawXi, yi] = points[i],
        [rawXj, yj] = points[j],
        xi = rawXi - origin,
        xj = rawXj - origin;
      const cross = xi * yj - xj * yi;
      if (
        Math.abs(cross) < 1e-10 &&
        Math.min(xi, xj) <= 0 &&
        Math.max(xi, xj) >= 0 &&
        Math.min(yi, yj) <= 0 &&
        Math.max(yi, yj) >= 0
      )
        return true;
      if (yi > 0 !== yj > 0 && 0 < xi + ((xj - xi) * -yi) / (yj - yi)) inside = !inside;
    }
    return inside;
  });
}

function areaMatches(area: CapArea, candidate: Candidate, place: Place): boolean {
  const circles = area.circles ?? [];
  if (area.polygons.length || circles.length) {
    return (
      area.polygons.some((polygon) =>
        capPolygonContains(polygon, place.latitude, place.longitude),
      ) ||
      circles.some((circle) => {
        const rad = Math.PI / 180,
          dLat = (place.latitude - circle.latitude) * rad,
          dLon = (place.longitude - circle.longitude) * rad;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(place.latitude * rad) *
            Math.cos(circle.latitude * rad) *
            Math.sin(dLon / 2) ** 2;
        return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) <= circle.radiusKm;
      })
    );
  }
  return (
    candidate.areas.has(clean(area.description)) ||
    area.geocodes.some((code) => candidate.geocodes.has(code.value))
  );
}

/** Translation must describe the same CAP identity, validity and original boundaries. */
function equivalentEnglish(original: CapDocument, translated: CapDocument): CapDocument | null {
  if (
    ['sender', 'identifier', 'sent', 'status', 'scope', 'msgType'].some(
      (key) => original[key as keyof CapDocument] !== translated[key as keyof CapDocument],
    ) ||
    JSON.stringify(original.references) !== JSON.stringify(translated.references)
  )
    return null;
  const signature = (info: CapInfo) =>
    JSON.stringify({
      effective: info.effective,
      onset: info.onset,
      expires: info.expires,
      severity: info.severity,
      urgency: info.urgency,
      certainty: info.certainty,
      areas: info.areas.map((area) => ({
        // Without geometry/geocodes only an identical area label is independently comparable.
        description:
          area.polygons.length || area.circles.length || area.geocodes.length
            ? ''
            : area.description,
        polygons: area.polygons,
        circles: area.circles,
        geocodes: area.geocodes,
      })),
    });
  const counts = (infos: CapInfo[]) => {
    const result = new Map<string, number>();
    for (const info of infos) {
      const value = signature(info);
      result.set(value, (result.get(value) ?? 0) + 1);
    }
    return result;
  };
  const originals = counts(original.infos);
  const infos = translated.infos.filter(
    (info) => /^en(?:-|$)/i.test(info.language) && originals.has(signature(info)),
  );
  const translatedCounts = counts(infos);
  // Distinct hazards may share time, severity and area; preserve every original info block.
  return infos.length &&
    [...originals].every(([value, count]) => translatedCounts.get(value) === count)
    ? { ...translated, infos }
    : null;
}

function toAlert(
  document: CapDocument,
  info: CapInfo,
  index: number,
  candidate: Candidate,
  place: Place,
): WeatherAlert {
  const matching = info.areas.filter((area) => areaMatches(area, candidate, place));
  const polygons = matching.flatMap((area) =>
    area.polygons.map((polygon) => [polygon.map(([lat, lon]) => [lon, lat])]),
  );
  const capUrl = `${ORIGIN}/v2/cap-alerts/${candidate.path}`;
  return {
    id: `${document.sender}/${document.identifier}/${index}`.slice(0, 2000),
    title: info.headline || info.event,
    event: info.event,
    severity: info.severity,
    area: matching
      .map((area) => area.description)
      .filter(Boolean)
      .join('; ')
      .slice(0, 8000),
    sent: document.sent,
    effective: info.effective,
    expires: info.expires!,
    description: info.description,
    instruction: info.instruction,
    source: info.senderName || candidate.source.name || document.sender,
    url: capUrl,
    // Avoid transferring large map outlines on a weak connection; never simplify an official boundary.
    geometry:
      polygons.length && polygons.reduce((count, polygon) => count + polygon[0].length, 0) <= 1000
        ? { type: 'MultiPolygon', coordinates: polygons }
        : null,
  };
}

export function createGlobalAlertAdapter(request: RequestText) {
  return async (
    place: Place,
    signal?: AbortSignal,
  ): Promise<AlertResult & { revokedCapKeys?: string[] }> => {
    const queryUrl = globalPointUrl(place);
    const code = place.countryCode.toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) throw Error('A valid country is required for official warnings.');
    const startedAt = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('The global warning check timed out.')),
      16_000,
    );
    const options = { signal: controller.signal };
    // A shared HTTP cache fill may continue for other callers; this location check still has a hard deadline.
    const read = (url: string, limits: TextOptions): Promise<TextResult> => {
      controller.signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const interrupted = () =>
          reject(controller.signal.reason ?? Error('Warning check interrupted.'));
        controller.signal.addEventListener('abort', interrupted, { once: true });
        request(url, { ...limits, ...options })
          .then(resolve, reject)
          .finally(() => controller.signal.removeEventListener('abort', interrupted));
      });
    };
    try {
      const registry = await read(SOURCES, {
        ...options,
        ttlMs: 6 * 60 * 60_000,
        maxBytes: 500_000,
      });
      const sources = sourcesFor(registry.text, code);
      const base = {
        source: sources.some((source) => source.id === 'ph-pagasa-en')
          ? 'PAGASA via WMO SWIC'
          : sources.some((source) => source.id === 'id-inatews-id')
            ? 'BMKG via WMO SWIC'
            : 'Official issuing authorities via WMO SWIC',
        officialUrl: `${ORIGIN}/`,
        scope: 'point' as const,
        scopeLabel: place.name,
        partial: true,
        feedUpdatedAt: null,
      };
      if (!sources.length)
        return {
          ...base,
          status: 'unsupported',
          alerts: [],
          fetchedAt: Date.now(),
          coverage:
            'No operating official CAP source for this country is listed in the connected WMO registry. Check the official authority. Missing warnings never mean safe conditions.',
        };
      const query = await read(queryUrl, { ...options, ttlMs: 60_000, maxBytes: 250_000 });
      const candidates = candidatesFor(query.text, sources);
      const loaded: { document: CapDocument; candidate: Candidate; fetchedAt: number }[] = [];
      let failed = 0;
      for (let i = 0; i < candidates.length; i += 3) {
        const batch = await Promise.allSettled(
          candidates.slice(i, i + 3).map(async (candidate) => {
            const result = await read(`${ORIGIN}/v2/cap-alerts/${candidate.path}`, {
              ...options,
              ttlMs: 60_000,
              maxBytes: 256_000,
            });
            return { document: parseCap(result.text), candidate, fetchedAt: result.fetchedAt };
          }),
        );
        for (const result of batch)
          if (result.status === 'fulfilled') loaded.push(result.value);
          else failed++;
      }
      if (controller.signal.aborted)
        throw controller.signal.reason ?? Error('The warning check was interrupted.');
      if (candidates.length && !loaded.length)
        throw Error(
          'Official warning details could not be verified. Check WMO SWIC and your local authority.',
        );
      const now = Date.now(),
        alerts: WeatherAlert[] = [];
      const active = activeCapRecords(
        loaded.map((item) => item.document),
        now,
      );
      const translations = new Map<
        string,
        { document: CapDocument; path: string; fetchedAt: number }
      >();
      const identity = (document: CapDocument) =>
        `${document.sender}\u0000${document.identifier}\u0000${document.sent}`;
      const translate = async (document: CapDocument) => {
        const candidate = loaded.find(
          (item) => identity(item.document) === identity(document),
        )?.candidate;
        if (
          !candidate?.englishPath ||
          document.infos.some((info) => /^en(?:-|$)/i.test(info.language)) ||
          !document.infos.some((info) =>
            info.areas.some((area) => areaMatches(area, candidate, place)),
          ) ||
          Date.now() - startedAt > 14_000 ||
          controller.signal.aborted
        )
          return;
        const optional = new AbortController();
        const stop = () => optional.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', stop, { once: true });
        const timeout = setTimeout(
          () => optional.abort(new Error('Optional translation timed out.')),
          1_500,
        );
        let removeAbort = () => {};
        try {
          const interrupted = new Promise<never>((_resolve, reject) => {
            const abort = () => reject(optional.signal.reason);
            optional.signal.addEventListener('abort', abort, { once: true });
            removeAbort = () => optional.signal.removeEventListener('abort', abort);
          });
          const result = await Promise.race([
            request(`${ORIGIN}/v2/cap-alerts/${candidate.englishPath}`, {
              signal: optional.signal,
              ttlMs: 60_000,
              maxBytes: 256_000,
            }),
            interrupted,
          ]);
          const translated = equivalentEnglish(document, parseCap(result.text));
          if (translated)
            translations.set(identity(document), {
              document: translated,
              path: candidate.englishPath,
              fetchedAt: result.fetchedAt,
            });
        } catch {
          // An optional language failure must preserve the verified original warning.
        } finally {
          clearTimeout(timeout);
          removeAbort();
          controller.signal.removeEventListener('abort', stop);
        }
      };
      for (let i = 0; i < active.length; i += 3)
        await Promise.all(active.slice(i, i + 3).map(translate));
      signal?.throwIfAborted();
      for (const original of active) {
        const translation = translations.get(identity(original));
        const document = translation?.document ?? original;
        const candidate = loaded.find(
          (item) =>
            item.document.identifier === document.identifier &&
            item.document.sender === document.sender &&
            item.document.sent === document.sent,
        )?.candidate;
        if (!candidate) continue;
        const matching = document.infos.filter(
          (info) =>
            info.expires !== null &&
            info.expires > Date.now() &&
            info.areas.some((area) => areaMatches(area, candidate, place)),
        );
        const preferred = matching.some((info) => /^en(?:-|$)/i.test(info.language))
          ? matching.filter((info) => /^en(?:-|$)/i.test(info.language))
          : matching.filter((info) => info.language === matching[0]?.language);
        for (const [index, info] of preferred.entries())
          alerts.push(
            toAlert(
              document,
              info,
              index,
              translation ? { ...candidate, path: translation.path } : candidate,
              place,
            ),
          );
      }
      const order: Record<string, number> = {
        Extreme: 0,
        Severe: 1,
        Moderate: 2,
        Minor: 3,
        Unknown: 4,
      };
      alerts.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4) || b.sent - a.sent);
      return {
        ...base,
        status: 'available',
        alerts: alerts.slice(0, 30),
        // Internal merge metadata: a second source must not revive a superseded CAP bulletin.
        revokedCapKeys: [
          ...new Set(
            loaded.flatMap(({ document }) =>
              document.status === 'Actual' &&
              document.scope === 'Public' &&
              ['Update', 'Cancel'].includes(document.msgType)
                ? document.references.map((ref) => `${ref.sender}/${ref.identifier}/`)
                : [],
            ),
          ),
        ],
        fetchedAt: Math.min(
          query.fetchedAt,
          ...loaded.map((item) => item.fetchedAt),
          ...[...translations.values()].map((item) => item.fetchedAt),
        ),
        coverage: `Partial official CAP coverage at this point via WMO SWIC. At most ${MAX_DOCUMENTS} current source documents are checked; missing feeds, unmapped areas and alerts without a verifiable expiry may be omitted.${failed ? ' Some warning details could not be loaded.' : ''} Each issue time comes from the issuing authority. Official English text is used only when verified against the original bulletin. An empty list is not an all-clear; check local official instructions.`,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

export const fetchGlobalAlerts = createGlobalAlertAdapter(requestText);
