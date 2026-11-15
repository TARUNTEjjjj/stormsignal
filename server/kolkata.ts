import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { AlertResult, Place, WeatherAlert } from '../src/types.ts';
import { requestText, type TextOptions, type TextResult } from './http.ts';

// Public RSS endpoint documented by IMD's API list. The authenticated JSON API is not used.
const FEED = 'https://mausam.imd.gov.in/imd_latest/contents/dist_nowcast_rss.php';
const OFFICIAL = 'https://mausam.imd.gov.in/kolkataums/district_nowcast_kolums.php';
// One national list of district nowcasts. Every retrieved entry is checked, so a Kolkata entry is
// found wherever it appears. Observed entries are about 610-640 bytes; the byte bound leaves room
// for the full entry limit, so a busy day's long feed is read rather than rejected whole.
const MAX_ENTRIES = 1000;
const MAX_BYTES = 1_000_000;
type RequestText = (url: string, options?: TextOptions) => Promise<TextResult>;
type Row = Record<string, unknown>;
type Bulletin = {
  id: string;
  sent: number;
  onset: number;
  expires: number;
  description: string;
};
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  // XML numeric character references (&#39;, &#xA;) must be decoded. DOCTYPE and
  // ENTITY declarations are rejected before parsing, so no custom entity expands.
  htmlEntities: true,
});
const clean = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
// The only markup removed from bulletin text: formatting tags by name and links, whose attributes
// are written as name=value. Any other "<" is official text, also directly before a letter or a
// tag name ("<a few mm", "<one km", "<T>", "<strong at times", "<B (minor)").
const ATTRIBUTE = String.raw`[ \t]+[a-z][\w:.-]*[ \t]*=[ \t]*(?:"[^"<>\n]*"|'[^'<>\n]*'|[^\s"'<>=]+)`;
const FORMATTING_TAG = new RegExp(
  String.raw`<\/?(?:br|p|b|i|u|em|strong|span|div|font|small)(?:${ATTRIBUTE})*[ \t]*\/?>|<a(?:${ATTRIBUTE})+[ \t]*>|<\/a[ \t]*>`,
  'gi',
);
const row = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unexpected IMD district feed structure.');
  if (['__proto__', 'constructor', 'prototype'].some((key) => Object.hasOwn(value, key)))
    throw new Error('Unsafe IMD district feed structure.');
  return value as Row;
};
function text(value: unknown, limit: number, required = true): string {
  if (!required && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()))
    throw new Error('IMD district bulletin text is missing or invalid.');
  return value;
}

/** Select a named Kolkata result, never a nearby anonymous map point or another state's city. */
export function supportsKolkata(place: Place): boolean {
  return (
    place.countryCode.toUpperCase() === 'IN' &&
    clean(place.name) === 'kolkata' &&
    clean(place.admin ?? '').replace(/^state of /, '') === 'west bengal' &&
    Number.isFinite(place.latitude) &&
    Number.isFinite(place.longitude) &&
    Math.abs(place.latitude) <= 90 &&
    Math.abs(place.longitude) <= 180
  );
}

/** IMD uses +5:30 in this RSS feed; normalize that explicit offset, never infer a missing zone. */
function timestamp(value: unknown): number {
  const raw = text(value, 60).replace(
    /([+-])(\d):(\d{2})$/,
    (_match, sign, hour, minute) => `${sign}0${hour}:${minute}`,
  );
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match) throw new Error('IMD district bulletin needs an explicit timezone.');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    year < 2000 ||
    year >= 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (match[7] !== 'Z' && (Number(match[7].slice(1, 3)) > 14 || Number(match[7].slice(4, 6)) > 59))
  )
    throw new Error('IMD district bulletin has an invalid calendar date.');
  const valueMs = Date.parse(raw);
  if (!Number.isFinite(valueMs)) throw new Error('IMD district bulletin has an invalid timestamp.');
  return valueMs;
}

function parseFeed(raw: string, now: number) {
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES)
    throw new Error('IMD district feed exceeds its size limit.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw))
    throw new Error('IMD district feed entities and document types are not accepted.');
  if (XMLValidator.validate(raw) !== true) throw new Error('IMD district feed XML is malformed.');
  const root = row(parser.parse(raw));
  const channel = row(row(root.rss).channel);
  if (clean(text(channel.title, 200)) !== 'imd warning')
    throw new Error('Unexpected IMD district feed title.');
  const value = channel.item;
  const all = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (all.length > MAX_ENTRIES) throw new Error('IMD district feed has too many entries.');
  const records: Bulletin[] = [];
  let latest: number | null = null;
  let invalidOtherTimes = 0,
    unnamed = 0;
  for (const value of all) {
    // An entry that names no district cannot be matched to Kolkata or to any other district. One
    // such damaged entry among up to 1,000 must not hide a Kolkata bulletin that was read, so it
    // is counted and disclosed. If it mentions Kolkata it may be Kolkata's, and the feed fails.
    const item = value && typeof value === 'object' && !Array.isArray(value) ? row(value) : null;
    const district = item && typeof item.title === 'string' ? clean(item.title) : '';
    if (!item || !district) {
      if (/kolkata/i.test(JSON.stringify(value) ?? ''))
        throw new Error('The IMD district feed has an unreadable Kolkata entry.');
      unnamed++;
      continue;
    }
    let sent: number;
    try {
      sent = timestamp(item.sent);
      if (sent > now + 300_000) throw new Error('IMD district publication time is in the future.');
    } catch (error) {
      if (district === 'kolkata') throw error;
      invalidOtherTimes++;
      continue;
    }
    latest = Math.max(latest ?? 0, sent);
    if (district !== 'kolkata') continue;
    if (clean(text(item.category, 100)) !== 'nowcast')
      throw new Error('Unrecognized Kolkata bulletin category.');
    const onset = timestamp(item.Onset),
      expires = timestamp(item.Expires);
    if (expires <= sent || expires <= onset)
      throw new Error('Kolkata bulletin has an invalid validity interval.');
    const id = text(item.guid, 200);
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('Invalid Kolkata bulletin identifier.');
    // Never render provider markup or follow links supplied inside the RSS document. By now CDATA
    // is unwrapped and entities are decoded, so this is plain text, and it is shown as text. Only
    // known formatting tags (<br/>, <p>, <b>) and links are removed; a comparison sign in a hazard
    // band ("<5 mm/hr", "> 87 kmph", "<a few mm") is official text and must survive. A tag never
    // spans lines.
    const description = text(item.description, 20_000)
      .replace(FORMATTING_TAG, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!description) throw new Error('Kolkata bulletin description is empty.');
    records.push({ id, sent, onset, expires, description });
  }
  // With no Kolkata bulletin read, an unnamed entry cannot be told from Kolkata's own.
  if (unnamed && !records.length)
    throw new Error('IMD district feed entries name no district; Kolkata cannot be checked.');
  return { records, latest, invalidOtherTimes, unnamed };
}

export function createKolkataAlertAdapter(request: RequestText) {
  return async (place: Place, signal?: AbortSignal): Promise<AlertResult> => {
    if (!supportsKolkata(place))
      throw new Error('Choose Kolkata in West Bengal for this district feed.');
    signal?.throwIfAborted();
    const received = await request(FEED, { maxBytes: MAX_BYTES, ttlMs: 60_000, signal });
    signal?.throwIfAborted();
    const now = Date.now();
    const feed = parseFeed(received.text, now);
    // Keep only the latest district issue, including when a newer issue has already expired.
    // A prior issue must not reappear after its replacement is no longer current.
    const newest = Math.max(0, ...feed.records.map((item) => item.sent));
    const current = feed.records.filter((item) => item.sent === newest);
    const unique = new Map<string, Bulletin>();
    for (const item of current) {
      const previous = unique.get(item.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(item))
        throw new Error('Kolkata feed contains conflicting latest bulletin content.');
      unique.set(item.id, item);
    }
    if (unique.size > 1)
      throw new Error('Kolkata feed contains conflicting latest bulletin identifiers.');
    // An issue time up to 5 minutes ahead of this server's clock is accepted above, because IMD's
    // clock can run ahead. That issue has already replaced the previous one, so it is current.
    const alerts: WeatherAlert[] = [...unique.values()]
      .filter((item) => item.expires > now)
      // A source may publish an explicit withdrawal/no-warning update; never turn it into an alert.
      .filter((item) => !/^no (?:warning|weather)[.!]?$/i.test(item.description))
      .map((item) => ({
        id: `imd-kolkata:${item.id}`,
        title: 'IMD nowcast for Kolkata district',
        event: 'District nowcast',
        severity: 'Unknown',
        area: 'Kolkata district',
        sent: item.sent,
        // RSS has no separate effective field. A published warning remains useful before
        // the expected weather onset; expose it from its source issue time, or from now when
        // that time is slightly ahead of this server's clock.
        effective: Math.min(item.sent, now),
        expires: item.expires,
        description: `${item.description}\n\nSource weather onset: ${new Date(item.onset).toISOString()}.`,
        instruction: '',
        source: 'India Meteorological Department (IMD)',
        url: OFFICIAL,
        geometry: null,
      }));
    return {
      status: 'available',
      alerts,
      fetchedAt: received.fetchedAt,
      source: 'IMD Kolkata district nowcasts (direct)',
      officialUrl: OFFICIAL,
      scope: 'region',
      scopeLabel: 'Kolkata district',
      partial: true,
      feedUpdatedAt: feed.latest,
      coverage: `Direct IMD public district-nowcast RSS, matched by the exact Kolkata district name. This rolling national feed is limited and may omit Kolkata updates; it is not a complete local warning service. No matching unexpired bulletin is not an all-clear. Warnings are shown from the source issue time; the source weather onset is preserved separately in the description. Expiry must be stated by IMD, and no severity is inferred.${!feed.records.length ? ' No Kolkata entry was present in the retrieved feed.' : ''}${feed.latest === null ? ' No verifiable feed publication time was supplied.' : now - feed.latest > 86_400_000 ? ' The latest bulletin in the feed is over 24 hours old; current coverage is unverified.' : ''}${feed.invalidOtherTimes ? ' Some unrelated bulletin timestamps were invalid.' : ''}${feed.unnamed ? ` ${feed.unnamed} feed ${feed.unnamed === 1 ? 'entry names' : 'entries name'} no district and could not be checked; a newer Kolkata bulletin may be missing.` : ''} Check IMD Kolkata directly for current instructions.`,
    };
  };
}

export const fetchKolkataAlerts = createKolkataAlertAdapter(requestText);
