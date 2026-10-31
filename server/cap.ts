import { XMLParser, XMLValidator } from 'fast-xml-parser';

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
  items: Array<{ url: string; publishedAt: number | null }>;
  updatedAt: number | null;
  truncated: boolean;
}

type RecordValue = Record<string, unknown>;
const MAX_XML_BYTES = 256_000;
const MIN_TIME = Date.UTC(2000, 0, 1),
  MAX_TIME = Date.UTC(2100, 0, 1);
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});
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
function xml(raw: string): RecordValue {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_XML_BYTES)
    throw new Error('XML exceeds its size limit.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw))
    throw new Error('XML entities and document types are not accepted.');
  if (XMLValidator.validate(raw) !== true) throw new Error('Malformed XML.');
  return record(parser.parse(raw));
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
function feedTime(value: unknown): number | null {
  if (value === undefined || value === '') return null;
  const raw = text(value, 100),
    parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_TIME || parsed >= MAX_TIME)
    throw new Error('Invalid RSS publication time.');
  return parsed;
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
  const items = all.slice(0, 100).map((value) => {
    const item = record(value);
    return { url: text(item.link, 4000, true), publishedAt: feedTime(item.pubDate) };
  });
  const times = [
    feedTime(channel.lastBuildDate),
    feedTime(channel.pubDate),
    ...items.map((i) => i.publishedAt),
  ].filter((x): x is number => x !== null);
  return {
    items,
    updatedAt: times.length ? Math.max(...times) : null,
    truncated: all.length > 100,
  };
}

/** Preserve cancellation metadata and all languages; filtering is a separate operation. */
export function parseCap(raw: string, now = Date.now()): CapDocument {
  if (!Number.isFinite(now)) throw new Error('Invalid clock.');
  if (
    !/<(?:[\w.-]+:)?alert\b[^>]*\bxmlns(?::[\w.-]+)?\s*=\s*["']urn:oasis:names:tc:emergency:cap:1\.2["']/.test(
      raw,
    )
  )
    throw new Error('Expected a CAP 1.2 namespace.');
  const root = xml(raw),
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
    const i = record(value),
      effective = capTime(i.effective, false) ?? sent,
      expires = capTime(i.expires, false);
    if (expires !== null && (expires <= effective || expires <= sent))
      throw new Error('Invalid CAP validity interval.');
    return {
      language: text(i.language, 40) || 'en-US',
      event: text(i.event, 400, true),
      severity: choice(i.severity, ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']),
      urgency: choice(i.urgency, ['Immediate', 'Expected', 'Future', 'Past', 'Unknown']),
      certainty: choice(i.certainty, ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown']),
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

/** Referenced originals stay suppressed even when their replacement has expired. */
export function activeCapRecords(documents: CapDocument[], now = Date.now()): CapDocument[] {
  const eligible = documents.filter(
    (d) => d.status === 'Actual' && d.scope === 'Public' && d.sent <= now + 300_000,
  );
  const suppressed = new Set(
    eligible
      .filter((d) => d.msgType === 'Update' || d.msgType === 'Cancel')
      .flatMap((d) => d.references.map(key)),
  );
  const seen = new Set<string>();
  return eligible.flatMap((d) => {
    const identity = key(d);
    if (!['Alert', 'Update'].includes(d.msgType) || suppressed.has(identity) || seen.has(identity))
      return [];
    seen.add(identity);
    const infos = d.infos.filter(
      (i) => i.effective <= now && i.expires !== null && i.expires > now,
    );
    return infos.length ? [{ ...d, infos }] : [];
  });
}
