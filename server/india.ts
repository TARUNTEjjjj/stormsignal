import type { AlertResult, Place, WeatherAlert } from '../src/types.ts';
import {
  activeCapRecords,
  capAreaText,
  newestFirst,
  parseCap,
  parseRss,
  upcomingCapNote,
  upcomingCapRecords,
  type CapDocument,
} from './cap.ts';
import { LIVE_TTL_MS, requestText } from './http.ts';

const BASE = 'https://sachet.ndma.gov.in/cap_public_website/';
const OFFICIAL = 'https://sachet.ndma.gov.in/';
const DAY = 86_400_000;
/** A direct check answers before the gateway's 18-second deadline (router.ts). */
const DEADLINE_MS = 17_000;
const SEVERITY: Record<string, number> = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
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
  /**
   * This check's own deadline (at most 17 s). When it passes, the bulletins already verified are
   * returned and the rest are reported as not verified; only the caller's cancellation discards them.
   */
  deadlineMs?: number;
}

/** State feed is a bounded regional history, not a location-specific warning service. */
export async function fetchIndiaAlerts(
  place: Place,
  options: IndiaAlertOptions = {},
): Promise<AlertResult & { upcomingDocuments?: number; upcomingAt?: number }> {
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
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('The SACHET warning check timed out.')),
    Math.min(Math.max(options.deadlineMs ?? DEADLINE_MS, 1), DEADLINE_MS),
  );
  // Each read settles at this check's deadline, even if the request ignores its signal.
  const read = async (url: string) => {
    controller.signal.throwIfAborted();
    let remove = () => {};
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        const stop = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', stop, { once: true });
        remove = () => controller.signal.removeEventListener('abort', stop);
      });
      return await Promise.race([
        get(url, { maxBytes: 256_000, ttlMs: LIVE_TTL_MS, signal: controller.signal }),
        interrupted,
      ]);
    } finally {
      remove();
    }
  };
  try {
    const received = await read(region.url);
    const feed = parseRss(received.text);
    if (feed.updatedAt !== null && feed.updatedAt > now + 300_000)
      throw new Error(
        `The ${region.name} SACHET feed has an invalid future publication time. Current regional warning coverage cannot be confirmed. Check SACHET and IMD directly.`,
      );
    const oldFeed = feed.updatedAt === null || now - feed.updatedAt > DAY;
    const documents: CapDocument[] = [],
      urls = new Map<string, string>();
    let missingExpiry = 0;
    // RSS sets no item order, so the most recently published entries are read first, as in the
    // national check. Times without a zone still order the entries of this feed.
    const newest = newestFirst(feed.items);
    const entries = [...new Set(newest.items.map((item) => item.url))];
    const links = entries.slice(0, 10);
    const unordered = entries.length > links.length && !newest.certain;
    const readDetail = async (raw: string) => {
      try {
        const url = detailUrl(raw);
        const response = await read(url);
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
      }
    };
    // A slow detail occupies only its own slot, rather than blocking a whole batch. No queued
    // detail starts once the caller cancels or this check's own deadline passes.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, links.length) }, async () => {
        while (next < links.length && !controller.signal.aborted) await readDetail(links[next++]);
      }),
    );
    // The caller's cancellation ends the check. At this check's own deadline, the bulletins already
    // verified are kept and the rest are reported as not verified, as in the national check.
    options.signal?.throwIfAborted();
    const failures = links.length - documents.length;
    if (links.length && !documents.length)
      throw new Error(
        `The ${region.name} regional feed was retrieved, but its warning details could not be verified. Check SACHET directly.`,
      );
    const candidates: WeatherAlert[] = activeCapRecords(documents, now)
      .flatMap((document) => {
        const english = document.infos.filter((i) => /^en(?:[-_]|$)/i.test(i.language));
        const infos = english.length
          ? english
          : document.infos.filter((i) => i.language === document.infos[0]?.language);
        const url = urls.get(
          `${document.sender}\u0000${document.identifier}\u0000${document.sent}`,
        )!;
        return infos.flatMap((info, index) =>
          info.expires === null
            ? []
            : [
                {
                  id: `sachet:${document.identifier}:${index}`,
                  title: info.headline || info.event,
                  event: info.event,
                  severity: info.severity,
                  // CAP allows an info without <area>; it is still a current regional bulletin.
                  area: info.areas.length
                    ? capAreaText(info.areas)
                    : 'Affected area not stated; read the official bulletin.',
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
      // The most severe bulletins come first and are kept by the bound below.
      .sort((a, b) => (SEVERITY[a.severity] ?? 4) - (SEVERITY[b.severity] ?? 4) || b.sent - a.sent);
    const alerts = candidates.slice(0, 10);
    const omittedAlerts = candidates.length - alerts.length;
    // Regional bulletins that take effect later are disclosed, never listed as current warnings.
    const upcoming = upcomingCapRecords(documents, now).map((document) =>
      Math.min(...document.infos.map((info) => info.effective)),
    );
    // Feed times without a time zone are unknown rather than read in the server's own zone.
    const publication =
      feed.updatedAt !== null
        ? `Latest bulletin in this feed: ${new Date(feed.updatedAt).toISOString()}.`
        : feed.unzonedTimes
          ? 'Feed publication times have no time zone, so the latest bulletin time is unknown.'
          : 'No bulletin publication time was supplied.';
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
      upcomingDocuments: upcoming.length,
      ...(upcoming.length ? { upcomingAt: Math.min(...upcoming) } : {}),
      coverage: `Regional ${region.name} feed; each warning applies only to its stated area, not automatically to ${place.name}. Up to 10 recent source entries are checked; this rolling feed is incomplete and does not establish local coverage or an all-clear.${oldFeed ? ` ${publication} Current regional coverage is unverified; check the authority directly.` : ''}${feed.unzonedTimes && feed.updatedAt !== null ? ' Some feed publication times have no time zone; they only set the order in which entries are read.' : ''}${unordered ? ' Some feed entries have no usable publication time, so the entries checked may not be the most recent.' : ''}${failures ? ` ${failures} warning detail request(s) could not be verified.` : ''}${missingExpiry ? ` ${missingExpiry} record(s) have no stated expiry and were not treated as current warnings.` : ''}${upcomingCapNote(upcoming, 'regional bulletin(s)')}${feed.items.length > 10 ? ' Additional feed entries were not checked.' : ''}${omittedAlerts ? ` ${omittedAlerts} additional warning text(s) were not included in this response.` : ''}`,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
