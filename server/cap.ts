import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AREA_TEXT_LIMIT, areaNamesText } from '../src/presentation.ts';

export interface CapReference {
  sender: string;
  identifier: string;
  sent: number;
}
export interface CapArea {
  description: string;
  polygons: number[][][];
  circles: Array<{ latitude: number; longitude: number; radiusKm: number }>;
  geocodes: Array<{ name: string; value: string }>;
}
export interface CapInfo {
  language: string;
  event: string;
  severity: string;
  urgency: string;
  certainty: string;
  senderName: string;
  effective: number;
  onset: number | null;
  expires: number | null;
  headline: string;
  description: string;
  instruction: string;
  web: string;
  areas: CapArea[];
}
export interface CapDocument {
  identifier: string;
  sender: string;
  sent: number;
  status: string;
  msgType: string;
  scope: string;
  references: CapReference[];
  infos: CapInfo[];
}
export interface RssFeed {
  /**
   * `publishedAt` is the instant an item was published, known only when its time names a zone.
   * `order` places the item among the others of its feed, newest highest: that instant, or for a
   * time without a zone its clock reading, which is never used as an instant.
   */
  items: Array<{ url: string; publishedAt: number | null; order: number | null }>;
  updatedAt: number | null;
  truncated: boolean;
  /** Some publication times named no time zone, so their instants were left unknown (null). */
  unzonedTimes: boolean;
}

type RecordValue = Record<string, unknown>;
const MAX_XML_BYTES = 256_000;
const MIN_TIME = Date.UTC(2000, 0, 1),
  MAX_TIME = Date.UTC(2100, 0, 1);
const parserOptions = {
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  // XML numeric character references (&#39;, &#xA;) must be decoded. DOCTYPE and
  // ENTITY declarations are rejected before parsing, so no custom entity expands.
  htmlEntities: true,
};
const parser = new XMLParser({ ...parserOptions, removeNSPrefix: true });
const namespaceParser = new XMLParser({ ...parserOptions, removeNSPrefix: false });
const CAP_NAMESPACE = 'urn:oasis:names:tc:emergency:cap:1.2';
// Guard the fields this adapter consumes, not a full CAP schema. Unrelated
// extension elements can remain in a document without becoming CAP fields.
const CAP_CHILDREN: Record<string, Set<string>> = {
  alert: new Set([
    'identifier',
    'sender',
    'sent',
    'status',
    'msgType',
    'scope',
    'references',
    'info',
  ]),
  info: new Set([
    'language',
    'event',
    'severity',
    'urgency',
    'certainty',
    'senderName',
    'effective',
    'onset',
    'expires',
    'headline',
    'description',
    'instruction',
    'web',
    'area',
  ]),
  area: new Set(['areaDesc', 'polygon', 'circle', 'geocode']),
  geocode: new Set(['valueName', 'value']),
};
const record = (value: unknown): RecordValue => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('Unexpected XML structure.');
  if (['__proto__', 'constructor', 'prototype'].some((key) => Object.hasOwn(value, key)))
    throw new Error('Unsafe XML structure.');
  return value as RecordValue;
};
const text = (value: unknown, limit = 1000, required = false): string => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('Required CAP text is missing.');
    return '';
  }
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid CAP text.');
  return value;
};
const list = (value: unknown, max: number): unknown[] => {
  const values = value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value];
  if (values.length > max) throw new Error('XML list exceeds its bound.');
  return values;
};
function xml(raw: string, selectedParser = parser): RecordValue {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_XML_BYTES)
    throw new Error('XML exceeds its size limit.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw))
    throw new Error('XML entities and document types are not accepted.');
  if (XMLValidator.validate(raw) !== true) throw new Error('Malformed XML.');
  return record(selectedParser.parse(raw));
}

function validateCapNamespaces(root: RecordValue): void {
  const roots = Object.keys(root).filter((name) => !name.startsWith('?'));
  if (roots.length !== 1 || Array.isArray(root[roots[0]]))
    throw new Error('Expected one CAP 1.2 alert namespace.');
  function visit(name: string, value: unknown, inherited: Map<string, string>, expected: string) {
    const node = value && typeof value === 'object' ? record(value) : undefined;
    const namespaces = new Map(inherited);
    for (const [key, uri] of Object.entries(node ?? {})) {
      if (key === '@_xmlns' || key.startsWith('@_xmlns:')) {
        if (typeof uri !== 'string') throw new Error('Invalid CAP namespace declaration.');
        namespaces.set(key === '@_xmlns' ? '' : key.slice('@_xmlns:'.length), uri);
      }
    }
    const parts = name.split(':');
    const prefix = parts.length === 1 ? '' : parts[0];
    if (parts.length > 2 || parts.at(-1) !== expected || namespaces.get(prefix) !== CAP_NAMESPACE)
      throw new Error('Unexpected namespace on a CAP field.');
    for (const [childName, child] of Object.entries(node ?? {})) {
      if (childName.startsWith('@_') || childName.startsWith('?') || childName.startsWith('#'))
        continue;
      const localName = childName.split(':').at(-1)!;
      if (!CAP_CHILDREN[expected]?.has(localName)) continue;
      for (const item of Array.isArray(child) ? child : [child])
        visit(childName, item, namespaces, localName);
    }
  }
  visit(roots[0], root[roots[0]], new Map(), 'alert');
}
function capTime(value: unknown, required = true): number | null {
  const raw = text(value, 60, required);
  if (!raw && !required) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw))
    throw new Error('CAP timestamp needs an explicit timezone.');
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_TIME || parsed >= MAX_TIME)
    throw new Error('Invalid CAP timestamp.');
  // Date.parse normalizes impossible dates such as 30 February. Reject them.
  const day = Number(raw.slice(8, 10)),
    month = Number(raw.slice(5, 7)),
    year = Number(raw.slice(0, 4));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(raw.slice(11, 13)) > 23 ||
    Number(raw.slice(14, 16)) > 59 ||
    Number(raw.slice(17, 19)) > 59
  )
    throw new Error('Invalid CAP calendar date.');
  return parsed;
}
// An RFC 822 (RSS 2.0) or ISO 8601 time names its zone after the time of day, in a form that
// Date.parse reads: Z, a numeric offset, or UT/UTC/GMT or a US zone abbreviation. A year, an offset
// or a comment may follow it ("15:30:00 UTC 2026", "15:30:00 GMT+0530 (India Standard Time)").
const TIME_OF_DAY = /\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;
const ZONE_AFTER_TIME =
  /(?:^|\s|[ap]m)[+-]\d{1,2}(?::?\d{2})?(?=\s|$)|(?:^|\s)(?:Z|UTC?|GMT|[ECMP][SD]T)(?![a-z])/i;
const COMMENT = /\([^()]*\)/g;
/**
 * Whether Date.parse read a zone from the time. It skips parenthesised comments, so a zone named
 * only inside one does not count. A form not recognised here is treated as having no zone: its
 * instant is then unknown, never guessed.
 */
function namesZone(raw: string): boolean {
  let plain = raw;
  while (plain.search(COMMENT) >= 0) plain = plain.replace(COMMENT, ' ');
  plain = plain.split('(')[0]; // an unclosed comment runs to the end
  const time = TIME_OF_DAY.exec(plain);
  return !!time && ZONE_AFTER_TIME.test(plain.slice(time.index + time[0].length));
}
/**
 * A feed time: its instant (`at`) and its place among the other times of the same feed (`order`).
 * A time without a zone would be read in the server's own zone (UTC on Workers), so its instant is
 * unknown and never guessed. Its clock reading still orders the entries of one feed, which share a
 * zone; that value is used only for sorting. Unreadable times still fail closed.
 */
function feedTime(value: unknown): { at: number | null; order: number | null } {
  if (value === undefined || value === '') return { at: null, order: null };
  const raw = text(value, 100),
    parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_TIME || parsed >= MAX_TIME)
    throw new Error('Invalid RSS publication time.');
  if (namesZone(raw)) return { at: parsed, order: parsed };
  // The same clock reading gives the same key on every host, whatever its own zone. Date.parse
  // reads an ISO date without a time of day as UTC and every other zone-less form as local time.
  if (/^\s*\d{4}(?:-\d{2}){0,2}\s*$/.test(raw)) return { at: null, order: parsed };
  const read = new Date(parsed);
  return {
    at: null,
    order: Date.UTC(
      read.getFullYear(),
      read.getMonth(),
      read.getDate(),
      read.getHours(),
      read.getMinutes(),
      read.getSeconds(),
      read.getMilliseconds(),
    ),
  };
}
function choice(value: unknown, allowed: string[]): string {
  const selected = text(value, 40, true);
  if (!allowed.includes(selected)) throw new Error('Unrecognized CAP status.');
  return selected;
}
function polygon(value: unknown): number[][] {
  const parts = text(value, 100_000, true).split(/\s+/);
  if (parts.length < 4 || parts.length > 5000) throw new Error('Invalid CAP polygon.');
  const points = parts.map((part) => {
    const pair = part.split(',');
    if (pair.length !== 2 || pair.some((p) => !/^-?\d+(?:\.\d+)?$/.test(p)))
      throw new Error('Invalid CAP coordinate.');
    const [lat, lon] = pair.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      throw new Error('Invalid CAP coordinate.');
    return [lat, lon];
  });
  if (points[0][0] !== points.at(-1)![0] || points[0][1] !== points.at(-1)![1])
    throw new Error('CAP polygon is not closed.');
  return points;
}
function area(value: unknown): CapArea {
  const a = record(value);
  return {
    description: text(a.areaDesc, 8000, true),
    // BMKG's province-wide CAP documents can include >100 district polygons.
    // The whole XML remains bounded to 256 KB and every ring is still validated.
    polygons: list(a.polygon, 256).map(polygon),
    circles: list(a.circle, 100).map((value) => {
      const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/.exec(
        text(value, 100, true),
      );
      if (!match) throw new Error('Invalid CAP circle.');
      const [latitude, longitude, radiusKm] = match.slice(1).map(Number);
      if (
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180 ||
        radiusKm > 40075 ||
        ![latitude, longitude, radiusKm].every(Number.isFinite)
      )
        throw new Error('Invalid CAP circle.');
      return { latitude, longitude, radiusKm };
    }),
    geocodes: list(a.geocode, 200).map((item) => {
      const g = record(item);
      return { name: text(g.valueName, 200, true), value: text(g.value, 1000, true) };
    }),
  };
}

/** Source links remain untrusted strings. Adapters must allowlist them before fetching/linking. */
export function parseRss(raw: string): RssFeed {
  const root = xml(raw),
    channel = record(record(root.rss).channel);
  const all = list(channel.item, 1000);
  let unzonedTimes = false;
  const time = (value: unknown) => {
    const parsed = feedTime(value);
    if (parsed.at === null && parsed.order !== null) unzonedTimes = true;
    return parsed;
  };
  const items = all.slice(0, 100).map((value) => {
    const item = record(value),
      published = time(item.pubDate);
    return { url: text(item.link, 4000, true), publishedAt: published.at, order: published.order };
  });
  const times = [
    time(channel.lastBuildDate).at,
    time(channel.pubDate).at,
    ...items.map((i) => i.publishedAt),
  ].filter((x): x is number => x !== null);
  return {
    items,
    updatedAt: times.length ? Math.max(...times) : null,
    truncated: all.length > 100,
    unzonedTimes,
  };
}

/**
 * Feed entries, most recently published first; entries without a usable time follow in feed order.
 * `certain` is false when that order may be wrong: an entry has no usable time, or the feed mixes
 * times with and without a zone, which cannot be compared with each other.
 */
export function newestFirst<T extends { publishedAt: number | null; order: number | null }>(
  items: T[],
): { items: T[]; certain: boolean } {
  const zoned = items.filter((item) => item.publishedAt !== null).length;
  return {
    items: [...items].sort((a, b) => (b.order ?? 0) - (a.order ?? 0)),
    certain: items.every((item) => item.order !== null) && (!zoned || zoned === items.length),
  };
}

/** Preserve cancellation metadata and all languages; filtering is a separate operation. */
export function parseCap(raw: string, now = Date.now()): CapDocument {
  if (!Number.isFinite(now)) throw new Error('Invalid clock.');
  // Resolve each consumed element's own namespace before removing prefixes.
  // Merely declaring an unused CAP prefix does not make a foreign element CAP.
  validateCapNamespaces(xml(raw, namespaceParser));
  const root = record(parser.parse(raw)),
    a = record(root.alert);
  const sent = capTime(a.sent)!;
  if (sent > now + 300_000) throw new Error('CAP publication time is in the future.');
  const referencesText = text(a.references, 20_000);
  const references = referencesText
    ? referencesText.split(/\s+/).map((ref) => {
        const fields = ref.split(',');
        if (fields.length !== 3 || !fields[0] || !fields[1])
          throw new Error('Invalid CAP reference.');
        return {
          sender: text(fields[0], 400, true),
          identifier: text(fields[1], 2000, true),
          sent: capTime(fields[2])!,
        };
      })
    : [];
  if (references.length > 100) throw new Error('Too many CAP references.');
  const msgType = choice(a.msgType, ['Alert', 'Update', 'Cancel', 'Ack', 'Error']);
  if (['Update', 'Cancel'].includes(msgType) && !references.length)
    throw new Error('CAP update or cancellation has no references.');
  const infos = list(a.info, 30).map((value) => {
    // A Cancel or Update may end a warning now, so its information can expire at or before its
    // issue or effective time. That information is never current (activeCapRecords), but the
    // document is kept and its references still withdraw the original. In any other message such
    // an interval is a mistake (a mistyped date, for example): the document is rejected, and so
    // reported as not verified, instead of being read as a warning that is never shown.
    const i = record(value),
      effective = capTime(i.effective, false) ?? sent,
      expires = capTime(i.expires, false);
    if (
      !['Update', 'Cancel'].includes(msgType) &&
      expires !== null &&
      (expires <= effective || expires <= sent)
    )
      throw new Error('Invalid CAP validity interval.');
    return {
      language: text(i.language, 40) || 'en-US',
      event: text(i.event, 400, true),
      severity: choice(i.severity, ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']),
      urgency: choice(i.urgency, ['Immediate', 'Expected', 'Future', 'Past', 'Unknown']),
      // CAP 1.1/1.2: the deprecated CAP 1.0 value "Very Likely" SHOULD be treated as "Likely".
      certainty: choice(i.certainty === 'Very Likely' ? 'Likely' : i.certainty, [
        'Observed',
        'Likely',
        'Possible',
        'Unlikely',
        'Unknown',
      ]),
      senderName: text(i.senderName, 400),
      effective,
      onset: capTime(i.onset, false),
      expires,
      headline: text(i.headline, 1000),
      description: text(i.description, 20_000),
      instruction: text(i.instruction, 20_000),
      web: text(i.web, 4000),
      areas: list(i.area, 100).map(area),
    };
  });
  return {
    identifier: text(a.identifier, 2000, true),
    sender: text(a.sender, 400, true),
    sent,
    status: choice(a.status, ['Actual', 'Exercise', 'System', 'Test', 'Draft']),
    msgType,
    scope: choice(a.scope, ['Public', 'Restricted', 'Private']),
    references,
    infos,
  };
}
const key = (d: CapReference) => `${d.sender}\u0000${d.identifier}\u0000${d.sent}`;

/**
 * A Cancel withdraws the messages it references when issued. An Update supersedes them once any of
 * its information is in effect; until then the referenced original remains the current warning.
 */
export function capReferencesInForce(document: CapDocument, now = Date.now()): boolean {
  return (
    document.msgType === 'Cancel' ||
    (document.msgType === 'Update' &&
      (!document.infos.length || document.infos.some((info) => info.effective <= now)))
  );
}

function capRecords(
  documents: CapDocument[],
  now: number,
  keep: (info: CapInfo, document: CapDocument) => boolean,
): CapDocument[] {
  const eligible = documents.filter(
    (d) => d.status === 'Actual' && d.scope === 'Public' && d.sent <= now + 300_000,
  );
  const suppressed = new Set(
    eligible.filter((d) => capReferencesInForce(d, now)).flatMap((d) => d.references.map(key)),
  );
  const seen = new Set<string>();
  return eligible.flatMap((d) => {
    const identity = key(d);
    if (!['Alert', 'Update'].includes(d.msgType) || suppressed.has(identity) || seen.has(identity))
      return [];
    seen.add(identity);
    const infos = d.infos.filter((i) => keep(i, d));
    return infos.length ? [{ ...d, infos }] : [];
  });
}

/** Referenced originals stay suppressed even when their replacement has expired. */
export function activeCapRecords(documents: CapDocument[], now = Date.now()): CapDocument[] {
  // Information that expires at or before its issue time has ended; it is never current.
  return capRecords(
    documents,
    now,
    (i, d) => i.effective <= now && i.expires !== null && i.expires > now && i.expires > d.sent,
  );
}

/** Unexpired information that takes effect later. Callers disclose it, never list it as current. */
export function upcomingCapRecords(documents: CapDocument[], now = Date.now()): CapDocument[] {
  return capRecords(
    documents,
    now,
    (i, d) =>
      i.effective > now && i.expires !== null && i.expires > i.effective && i.expires > d.sent,
  );
}

/** Coverage sentence for matched documents that take effect later (earliest effective time each). */
export function upcomingCapNote(effectiveTimes: number[], subject: string): string {
  return effectiveTimes.length
    ? ` ${effectiveTimes.length} ${subject} take effect later and are not listed as current warnings yet; the earliest takes effect at ${new Date(Math.min(...effectiveTimes)).toISOString()}.`
    : '';
}

/** Displayed area text keeps to the bound that the browser and saved briefings also apply. */
export const CAP_AREA_TEXT_LIMIT = AREA_TEXT_LIMIT;

/**
 * Join area names for display. A longer list keeps whole leading names and states how many more
 * the official bulletin names, so a later area is never cut off silently.
 */
export function capAreaText(areas: CapArea[], limit = CAP_AREA_TEXT_LIMIT): string {
  return areaNamesText(areas.map((area) => area.description).filter(Boolean), limit);
}
