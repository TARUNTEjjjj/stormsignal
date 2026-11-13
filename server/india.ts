import type { AlertResult, Place, WeatherAlert } from '../src/types.ts';
import { activeCapRecords, parseCap, parseRss, type CapDocument } from './cap.ts';
import { requestText } from './http.ts';

const BASE = 'https://sachet.ndma.gov.in/cap_public_website/';
const OFFICIAL = 'https://sachet.ndma.gov.in/';
const DAY = 86_400_000;
// Published by SACHET's /CapFeed page, verified 1 November 2026. Never construct a host from user input.
export const INDIA_REGIONS = [
  ['Andaman and Nicobar Islands', 'andaman', 'Andaman and Nicobar'],
  ['Andhra Pradesh', 'andhra'],
  ['Arunachal Pradesh', 'arunachal'],
  ['Assam', 'assam'],
  ['Bihar', 'bihar'],
  ['Chandigarh', 'chandigarh'],
  ['Chhattisgarh', 'chhattisgarh'],
  ['Dadra and Nagar Haveli and Daman and Diu', 'dadra', 'Dadra and Nagar Haveli', 'Daman and Diu'],
  ['Delhi', 'delhi', 'National Capital Territory of Delhi', 'NCT'],
  ['Goa', 'goa'],
  ['Gujarat', 'gujarat'],
  ['Haryana', 'haryana'],
  ['Himachal Pradesh', 'himachal'],
  ['Jammu and Kashmir', 'jammu'],
  ['Jharkhand', 'jharkhand'],
  ['Karnataka', 'karnataka'],
  ['Kerala', 'kerala'],
  ['Ladakh', 'ladakh'],
  ['Lakshadweep', 'lakshadweep'],
  ['Madhya Pradesh', 'madhya'],
  ['Maharashtra', 'maharashtra'],
  ['Manipur', 'manipur'],
  ['Meghalaya', 'meghalaya'],
  ['Mizoram', 'mizoram'],
  ['Nagaland', 'nagaland'],
  ['Odisha', 'odisha', 'Orissa'],
  ['Puducherry', 'puducherry', 'Pondicherry'],
  ['Punjab', 'punjab'],
  ['Rajasthan', 'rajasthan'],
  ['Sikkim', 'sikkim'],
  ['Tamil Nadu', 'tamil'],
  ['Telangana', 'telangana'],
  ['Tripura', 'tripura'],
  ['Uttarakhand', 'uttarakhand', 'Uttaranchal'],
  ['Uttar Pradesh', 'uttar'],
  ['West Bengal', 'west'],
] as const;
const normalized = (value: string) =>
  value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/^state of /, '')
    .replace(/[^a-z]/g, '');
export function indiaRegion(place: Place) {
  if (place.countryCode.toUpperCase() !== 'IN') return null;
  const candidates = [place.admin, place.name]
    .filter((x): x is string => typeof x === 'string')
    .map(normalized);
  const region = INDIA_REGIONS.find(([name, _slug, ...aliases]) =>
    [name, ...aliases].some((value) => candidates.includes(normalized(value))),
  );
  return region ? { name: region[0], url: `${BASE}rss/rss_${region[1]}.xml` } : null;
}
function detailUrl(raw: string): string {
  const u = new URL(raw);
  const identifier = u.searchParams.get('identifier');
  if (
    u.origin !== 'https://sachet.ndma.gov.in' ||
    u.pathname !== '/cap_public_website/FetchXMLFile' ||
    u.hash ||
    !identifier ||
    !/^\d{1,32}$/.test(identifier) ||
    [...u.searchParams.keys()].length !== 1 ||
    u.username ||
    u.password
  )
    throw new Error('Unexpected SACHET alert link.');
  return `${BASE}FetchXMLFile?identifier=${identifier}`;
}
export interface IndiaAlertOptions {
  now?: number;
  signal?: AbortSignal;
  request?: typeof requestText;
}

/** State feed is a bounded regional history, not a location-specific warning service. */
export async function fetchIndiaAlerts(
  place: Place,
  options: IndiaAlertOptions = {},
): Promise<AlertResult> {
  const now = options.now ?? Date.now(),
    get = options.request ?? requestText;
  const region = indiaRegion(place);
  if (!region)
    return {
      status: 'unsupported',
      alerts: [],
      fetchedAt: now,
      source: 'NDMA SACHET / issuing Indian authorities',
      officialUrl: OFFICIAL,
      scope: 'region',
      scopeLabel: 'India — region not identified',
      partial: true,
      coverage:
        'Choose a named Indian place with state metadata to read its regional SACHET feed. This is not a local warning check. Check SACHET and IMD directly; missing warnings do not mean no danger.',
    };
  const received = await get(region.url, {
    maxBytes: 256_000,
    ttlMs: 60_000,
    signal: options.signal,
  });
  const feed = parseRss(received.text);
  if (feed.updatedAt !== null && feed.updatedAt > now + 300_000)
    throw new Error(
      `The ${region.name} SACHET feed has an invalid future publication time. Current regional warning coverage cannot be confirmed. Check SACHET and IMD directly.`,
    );
  const oldFeed = feed.updatedAt === null || now - feed.updatedAt > DAY;
  const documents: CapDocument[] = [],
    urls = new Map<string, string>();
  let failures = 0,
    missingExpiry = 0;
  const links = [...new Set(feed.items.map((item) => item.url))].slice(0, 10);
  const readDetail = async (raw: string) => {
    options.signal?.throwIfAborted();
    try {
      const url = detailUrl(raw);
      const response = await get(url, { maxBytes: 256_000, ttlMs: 60_000, signal: options.signal });
      const document = parseCap(response.text, now);
      documents.push(document);
      urls.set(`${document.sender}\u0000${document.identifier}\u0000${document.sent}`, url);
      if (
        document.status === 'Actual' &&
        document.scope === 'Public' &&
        document.infos.some((info) => info.expires === null)
      )
        missingExpiry++;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      failures++;
    }
  };
  // A slow detail occupies only its own slot, rather than blocking a whole batch.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, links.length) }, async () => {
      while (next < links.length) {
        options.signal?.throwIfAborted();
        await readDetail(links[next++]);
      }
    }),
  );
  if (links.length && failures === links.length)
    throw new Error(
      `The ${region.name} regional feed was retrieved, but its warning details could not be verified. Check SACHET directly.`,
    );
  const candidates: WeatherAlert[] = activeCapRecords(documents, now)
    .flatMap((document) => {
      const english = document.infos.filter((i) => /^en(?:[-_]|$)/i.test(i.language));
      const infos = english.length
        ? english
        : document.infos.filter((i) => i.language === document.infos[0]?.language);
      const url = urls.get(`${document.sender}\u0000${document.identifier}\u0000${document.sent}`)!;
      return infos.flatMap((info, index) =>
        info.expires === null || !info.areas.length
          ? []
          : [
              {
                id: `sachet:${document.identifier}:${index}`,
                title: info.headline || info.event,
                event: info.event,
                severity: info.severity,
                area: info.areas
                  .map((a) => a.description)
                  .join('; ')
                  .slice(0, 4000),
                sent: document.sent,
                effective: info.effective,
                expires: info.expires,
                description: info.description,
                instruction: info.instruction,
                source: info.senderName || document.sender,
                url,
                geometry: null,
              },
            ],
      );
    })
    .sort((a, b) => b.sent - a.sent);
  const alerts = candidates.slice(0, 10);
  const omittedAlerts = candidates.length - alerts.length;
  return {
    status: 'available',
    alerts,
    fetchedAt: received.fetchedAt,
    source: 'NDMA SACHET / issuing Indian authorities',
    officialUrl: OFFICIAL,
    scope: 'region',
    scopeLabel: region.name,
    partial: true,
    feedUpdatedAt: feed.updatedAt,
    coverage: `Regional ${region.name} feed; each warning applies only to its stated area, not automatically to ${place.name}. Up to 10 recent source entries are checked; this rolling feed is incomplete and does not establish local coverage or an all-clear.${oldFeed ? ` ${feed.updatedAt === null ? 'No bulletin publication time was supplied.' : `Latest bulletin in this feed: ${new Date(feed.updatedAt).toISOString()}.`} Current regional coverage is unverified; check the authority directly.` : ''}${failures ? ` ${failures} warning detail request(s) could not be verified.` : ''}${missingExpiry ? ` ${missingExpiry} record(s) have no stated expiry and were not treated as current warnings.` : ''}${feed.truncated || feed.items.length > 10 ? ' Additional feed entries were not checked.' : ''}${omittedAlerts ? ` ${omittedAlerts} additional warning text(s) were not included in this response.` : ''}`,
  };
}
