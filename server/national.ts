import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { AlertResult, Place, WeatherAlert } from '../src/types.ts';
import {
  activeCapRecords,
  capAreaText,
  capReferencesInForce,
  newestFirst,
  parseCap,
  parseRss,
  upcomingCapNote,
  upcomingCapRecords,
  type CapArea,
  type CapDocument,
} from './cap.ts';
import { capAreaGeometry, capPolygonContains } from './global.ts';
import { LIVE_TTL_MS, requestText, type TextOptions, type TextResult } from './http.ts';

type RequestText = (url: string, options?: TextOptions) => Promise<TextResult>;
export interface NationalAlertResult extends AlertResult {
  /**
   * Exact verified document/reference prefixes supersede possibly older WMO copies. A current
   * document this check could not evaluate at the point (an area without polygon or circle) is
   * left out, so WMO's area-description/geocode match for it stays visible. An Update's
   * references are listed once it is in effect.
   */
  excludedCapKeys: string[];
  /** Matched documents that take effect later; disclosed in coverage, never listed as current. */
  upcomingDocuments: number;
  /** The earliest time one of them takes effect. */
  upcomingAt?: number;
}
const SOURCES = {
  PH: {
    name: 'PAGASA',
    feed: 'https://publicalert.pagasa.dost.gov.ph/feeds/',
    officialUrl: 'https://www.pagasa.dost.gov.ph/',
    limitation:
      'The PAGASA CAP feed does not include every local thunderstorm or rainfall advisory. Check the PAGASA regional warning page too.',
  },
  ID: {
    name: 'BMKG',
    feed: 'https://www.bmkg.go.id/alerts/nowcast/en',
    officialUrl: 'https://www.bmkg.go.id/cuaca/peringatan-dini-cuaca',
    limitation:
      'This BMKG feed covers short-term weather nowcasts, not every earthquake, tsunami, flood or other emergency warning.',
  },
} as const;
const MAX_DOCUMENTS = 20;
const MAX_FEED_BYTES = 256_000;
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  // XML numeric character references (&#39;, &#xA;) must be decoded. DOCTYPE and
  // ENTITY declarations are rejected before parsing, so no custom entity expands.
  htmlEntities: true,
});
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ['__proto__', 'constructor', 'prototype'].some((key) => Object.hasOwn(value, key))
  )
    throw new Error('Unexpected official feed structure.');
  return value as RecordValue;
}
function list(value: unknown, maximum: number): unknown[] {
  const result = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (result.length > maximum) throw new Error('Official feed exceeds its entry limit.');
  return result;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum)
    throw new Error('Invalid official feed text.');
  return value;
}
function timestamp(value: unknown, now: number): number | null {
  if (value === undefined || value === '') return null;
  const raw = text(value, 100);
  // Atom timestamps must carry a timezone; never interpret a publisher's clock as local time.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw))
    throw new Error('Invalid official feed timestamp.');
  const result = Date.parse(raw);
  if (!Number.isFinite(result) || result < Date.UTC(2000, 0, 1) || result > now + 300_000)
    throw new Error('Invalid official feed timestamp.');
  return result;
}
function detailUrl(raw: string, country: 'PH' | 'ID'): string {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.search ||
    /%(?:2f|5c|2e|25)/i.test(raw) ||
    raw.includes('\\')
  )
    throw new Error('Unsupported official bulletin URL.');
  const allowed =
    country === 'PH'
      ? url.hostname === 'publicalert.pagasa.dost.gov.ph' &&
        /^\/output\/(?:gfa|acp|wcp)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.cap$/i.test(
          url.pathname,
        )
      : url.hostname === 'www.bmkg.go.id' &&
        /^\/alerts\/nowcast\/en\/[A-Z0-9]{3,40}_alert\.xml$/.test(url.pathname);
  if (!allowed) throw new Error('Unsupported official bulletin URL.');
  return url.href;
}
interface Feed {
  items: Array<{ url: string; publishedAt: number | null; order: number | null }>;
  /** RSS only: some publication times name no time zone, so they order entries but are no instants. */
  unzonedTimes?: boolean;
}
function feedItems(raw: string, country: 'PH' | 'ID', now: number): Feed {
  if (country === 'ID') return parseRss(raw);
  if (
    new TextEncoder().encode(raw).byteLength > MAX_FEED_BYTES ||
    /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw) ||
    XMLValidator.validate(raw) !== true
  )
    throw new Error('Invalid official Atom feed.');
  const feed = record(record(parser.parse(raw)).feed);
  if (feed['@_xmlns'] !== 'http://www.w3.org/2005/Atom')
    throw new Error('Expected an official Atom feed.');
  timestamp(feed.updated, now);
  if (Object.keys(feed).some((name) => name.endsWith(':entry')))
    throw new Error('Unexpected namespaced official feed entry.');
  // Every entry is kept, as in parseRss: the newest are chosen once the entries are ordered.
  const items = list(feed.entry, 1000).map((value) => {
    const entry = record(value);
    if (
      (entry['@_xmlns'] !== undefined && entry['@_xmlns'] !== 'http://www.w3.org/2005/Atom') ||
      Object.keys(entry).some((name) => name.endsWith(':link'))
    )
      throw new Error('Unexpected official feed entry namespace.');
    const links = list(entry.link, 10).map(record);
    if (
      links.some(
        (link) =>
          link['@_xmlns'] !== undefined && link['@_xmlns'] !== 'http://www.w3.org/2005/Atom',
      )
    )
      throw new Error('Unexpected official feed link namespace.');
    const cap = links.find((link) => link['@_type'] === 'application/cap+xml');
    if (!cap) throw new Error('Official feed entry has no CAP bulletin link.');
    const publishedAt = timestamp(entry.updated ?? entry.published, now);
    return { url: text(cap['@_href'], 4000), publishedAt, order: publishedAt };
  });
  return { items };
}
function contains(area: CapArea, place: Place): boolean {
  return (
    area.polygons.some((polygon) => capPolygonContains(polygon, place.latitude, place.longitude)) ||
    area.circles.some((circle) => {
      const rad = Math.PI / 180;
      const a =
        Math.sin(((place.latitude - circle.latitude) * rad) / 2) ** 2 +
        Math.cos(place.latitude * rad) *
          Math.cos(circle.latitude * rad) *
          Math.sin(((place.longitude - circle.longitude) * rad) / 2) ** 2;
      return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) <= circle.radiusKm;
    })
  );
}
const key = (document: Pick<CapDocument, 'sender' | 'identifier'>) =>
  `${document.sender}/${document.identifier}/`;
/** Point matching here uses polygons and circles only; such an area cannot be evaluated. */
const withoutGeometry = (area: CapArea) => !area.polygons.length && !area.circles.length;

/** Direct national CAP check supplements WMO; bounded history is always incomplete. */
export function createNationalAlertAdapter(
  request: RequestText,
  options: { now?: () => number; deadlineMs?: number } = {},
) {
  return async (place: Place, signal?: AbortSignal): Promise<NationalAlertResult> => {
    const country = place.countryCode.toUpperCase();
    if (country !== 'PH' && country !== 'ID')
      throw new Error('No direct CAP feed is configured for this country.');
    if (
      !Number.isFinite(place.latitude) ||
      !Number.isFinite(place.longitude) ||
      Math.abs(place.latitude) > 90 ||
      Math.abs(place.longitude) > 180
    )
      throw new Error('Invalid official warning location.');
    const now = options.now ?? Date.now;
    const source = SOURCES[country];
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('Direct official warning check timed out.')),
      Math.min(Math.max(options.deadlineMs ?? 14_000, 1), 14_000),
    );
    const read = async (url: string): Promise<TextResult> => {
      controller.signal.throwIfAborted();
      let remove = () => {};
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          const stop = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', stop, { once: true });
          remove = () => controller.signal.removeEventListener('abort', stop);
        });
        return await Promise.race([
          request(url, { maxBytes: MAX_FEED_BYTES, ttlMs: LIVE_TTL_MS, signal: controller.signal }),
          interrupted,
        ]);
      } finally {
        remove();
      }
    };
    try {
      const received = await read(source.feed);
      const feed = feedItems(received.text, country, now());
      if (
        feed.items.some((item) => item.publishedAt !== null && item.publishedAt > now() + 300_000)
      )
        throw new Error('Official feed publication time is in the future.');
      // The most recently published entries are read first. Times without a zone (RSS) still
      // order the entries of one feed; entries with no usable time follow in feed order.
      const newest = newestFirst(feed.items);
      const unique = [...new Map(newest.items.map((item) => [item.url, item])).values()];
      const candidates = unique.slice(0, MAX_DOCUMENTS);
      const unordered = unique.length > candidates.length && !newest.certain;
      const loaded: Array<{ document: CapDocument; url: string; fetchedAt: number }> = [];
      let failed = 0,
        attempted = 0,
        next = 0;
      // Reuse each free slot immediately; a stalled bulletin must not hold up
      // later source entries while the overall verification deadline runs down.
      await Promise.all(
        Array.from({ length: Math.min(4, candidates.length) }, async () => {
          while (next < candidates.length && !controller.signal.aborted) {
            const item = candidates[next++];
            attempted++;
            try {
              const url = detailUrl(item.url, country);
              const result = await read(url);
              loaded.push({
                document: parseCap(result.text, now()),
                url,
                fetchedAt: result.fetchedAt,
              });
            } catch {
              failed++;
            }
          }
        }),
      );
      signal?.throwIfAborted();
      if (candidates.length && !loaded.length)
        throw new Error(
          `${source.name}'s feed was reached but its bulletin details could not be verified.`,
        );
      const checked = loaded.map((item) => item.document);
      const actual = checked.filter(
        (document) => document.status === 'Actual' && document.scope === 'Public',
      );
      const active = activeCapRecords(checked, now());
      // A current document with an area this check cannot evaluate must not suppress WMO's copy,
      // which may match that area by its description or geocode. References still supersede.
      const unevaluated = new Set(
        active
          .filter((document) => document.infos.some((info) => info.areas.some(withoutGeometry)))
          .map(key),
      );
      const excludedCapKeys = [
        ...new Set(
          actual.flatMap((document) => [
            ...(unevaluated.has(key(document)) ? [] : [key(document)]),
            ...(capReferencesInForce(document, now()) ? document.references.map(key) : []),
          ]),
        ),
      ];
      const upcoming = upcomingCapRecords(checked, now()).flatMap((document) => {
        const matched = document.infos.filter((info) =>
          info.areas.some((area) => contains(area, place)),
        );
        return matched.length ? [Math.min(...matched.map((info) => info.effective))] : [];
      });
      const alerts: WeatherAlert[] = [];
      let unmapped = 0;
      for (const document of active) {
        const matching = document.infos.filter((info) => {
          // CAP allows information with no area at all; it cannot be matched to a point either.
          if (!info.areas.length || info.areas.some(withoutGeometry)) unmapped++;
          return info.areas.some((area) => contains(area, place));
        });
        const preferred = matching.some((info) => /^en(?:-|$)/i.test(info.language))
          ? matching.filter((info) => /^en(?:-|$)/i.test(info.language))
          : matching.filter((info) => info.language === matching[0]?.language);
        const url = loaded.find(
          (item) => key(item.document) === key(document) && item.document.sent === document.sent,
        )!.url;
        for (const info of preferred) {
          const areas = info.areas.filter((area) => contains(area, place));
          alerts.push({
            // WMO matches blocks this check cannot evaluate, so both number a block by its place
            // in the document: one id then names the same block in each source.
            id: `${key(document)}${info.position}`.slice(0, 2000),
            title: info.headline || info.event,
            event: info.event,
            severity: info.severity,
            area: capAreaText(areas),
            sent: document.sent,
            effective: info.effective,
            expires: info.expires!,
            description: info.description,
            instruction: info.instruction,
            source: info.senderName || source.name,
            url,
            // Preserve boundaries exactly; omit large map geometry to conserve mobile transfer.
            geometry: capAreaGeometry(areas),
          });
        }
      }
      const severity: Record<string, number> = {
        Extreme: 0,
        Severe: 1,
        Moderate: 2,
        Minor: 3,
        Unknown: 4,
      };
      alerts.sort(
        (a, b) => (severity[a.severity] ?? 4) - (severity[b.severity] ?? 4) || b.sent - a.sent,
      );
      const missingExpiry = actual.reduce(
        (sum, document) => sum + document.infos.filter((info) => info.expires === null).length,
        0,
      );
      const omitted = unique.length - attempted;
      return {
        status: 'available',
        alerts: alerts.slice(0, 30),
        excludedCapKeys,
        upcomingDocuments: upcoming.length,
        ...(upcoming.length ? { upcomingAt: Math.min(...upcoming) } : {}),
        fetchedAt: Math.min(received.fetchedAt, ...loaded.map((item) => item.fetchedAt)),
        source: `${source.name} · direct official CAP feed`,
        officialUrl: source.officialUrl,
        scope: 'point',
        scopeLabel: place.name,
        partial: true,
        // RSS build times may simply reflect the request; only original CAP sent proves issuance.
        feedUpdatedAt: actual.length ? Math.max(...actual.map((document) => document.sent)) : null,
        coverage:
          `Direct ${source.name} check: ${loaded.length} of ${candidates.length} selected recent bulletins verified. Only unexpired original warning polygons or circles containing this point are included. ${source.limitation} Coverage is incomplete; an empty result is not an all-clear.` +
          (failed ? ` ${failed} selected bulletin(s) could not be verified.` : '') +
          (omitted ? ` ${omitted} additional feed entries were not checked.` : '') +
          (unordered
            ? ' Some feed entries have no usable publication time, so the bulletins checked may not be the most recent.'
            : '') +
          (feed.unzonedTimes
            ? ' Some feed publication times have no time zone; they only set the order in which bulletins are read.'
            : '') +
          (unmapped ? ' Some warning areas have no usable point geometry and were omitted.' : '') +
          upcomingCapNote(upcoming, 'matched bulletin(s)') +
          (missingExpiry
            ? ' Bulletins without a stated expiry were not treated as current warnings.'
            : '') +
          (alerts.length > 30
            ? ' Additional matched warning text was omitted from this response.'
            : ''),
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  };
}
export const fetchNationalAlerts = createNationalAlertAdapter(requestText);
