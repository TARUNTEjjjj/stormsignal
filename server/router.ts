import type { Place } from '../src/types.ts';
import { fetchIndiaAlerts, indiaRegion } from './india.ts';
import { fetchGlobalAlerts } from './global.ts';
import { fetchLocalAlerts } from './local-alerts.ts';
import { supportsKolkata } from './kolkata.ts';
import { MAX_PENDING_READS, pendingReads } from './http.ts';

/**
 * Upstream reads are capped for everyone (http.ts). While the gateway is busy, one client may have
 * this many distinct lookups running, so that one connection's distinct points cannot take the
 * read capacity from other users. While it is not busy the allowance is not applied: people who
 * share one address (carrier-grade NAT) are then never refused. A repeat of a lookup the client
 * already has running shares it and is always admitted.
 */
const CLIENT_LOOKUPS = 4;
/** The same for a wider network, so that changing address within one IPv6 /48 adds no allowance. */
const NETWORK_LOOKUPS = 8;
/**
 * Busy: half of the read capacity is in use, or this many lookups are running. A burst is admitted
 * before any of its reads start and each lookup can read several documents at once, so running
 * lookups count as well as reads; one client alone therefore never holds more lookups than this.
 */
const BUSY_READS = MAX_PENDING_READS / 2;
const BUSY_LOOKUPS = MAX_PENDING_READS / 4;
/** Requests per running lookup of each client, and distinct running lookups per network and overall. */
const running = new Map<string, Map<string, number>>();
const networks = new Map<string, number>();
let lookups = 0;

/**
 * Cloudflare's connecting address as [client, network]: an IPv6 client is identified by its /64
 * network within its /48; an IPv4 address is both. Without an address (local development) clients
 * cannot be told apart, so no allowance applies.
 */
function clientKeys(request: Request): [client: string, network: string] {
  const address = request.headers.get('CF-Connecting-IP')?.trim().toLowerCase() ?? '';
  if (!address.includes(':') || address.includes('.')) return [address, address];
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [],
    right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  const prefix = (count: number) =>
    groups
      .slice(0, count)
      .map((group) => group.replace(/^0+(?=.)/, ''))
      .join(':');
  return [prefix(4), prefix(3)];
}

/** What a check reads upstream: a fixed regional feed, or a WMO lookup at the point. */
function lookupKey(place: Place): string {
  if (supportsKolkata(place)) return 'kolkata';
  if (place.countryCode === 'IN') return `india:${indiaRegion(place)?.name ?? ''}`;
  return `${place.latitude.toFixed(6)},${place.longitude.toFixed(6)}`;
}

/** Admit a check within its client's allowance; the returned function releases it. */
function admit(client: string, network: string, lookup: string): (() => void) | undefined {
  const held = running.get(client) ?? new Map<string, number>();
  if (!held.has(lookup)) {
    const busy = pendingReads() >= BUSY_READS || lookups >= BUSY_LOOKUPS;
    if (busy && (held.size >= CLIENT_LOOKUPS || (networks.get(network) ?? 0) >= NETWORK_LOOKUPS))
      return undefined;
    lookups++;
    networks.set(network, (networks.get(network) ?? 0) + 1);
  }
  held.set(lookup, (held.get(lookup) ?? 0) + 1);
  running.set(client, held);
  return () => {
    const count = held.get(lookup)! - 1;
    if (count) held.set(lookup, count);
    else {
      held.delete(lookup);
      lookups--;
      const rest = networks.get(network)! - 1;
      if (rest) networks.set(network, rest);
      else networks.delete(network);
    }
    if (!held.size) running.delete(client);
  };
}

export function alertPlace(url: URL): Place {
  const p = url.searchParams;
  const allowed = new Set(['lat', 'lon', 'country', 'admin', 'name']);
  if ([...p.keys()].some((k) => !allowed.has(k) || p.getAll(k).length !== 1))
    throw new Error('Invalid alert query');
  const latitude = Number(p.get('lat')),
    longitude = Number(p.get('lon'));
  const countryCode = p.get('country') ?? '';
  if (
    !p.get('lat')?.trim() ||
    !p.get('lon')?.trim() ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    !/^([A-Z]{2})?$/.test(countryCode) ||
    (p.get('admin')?.length ?? 0) > 100 ||
    (p.get('name')?.length ?? 0) > 100
  )
    throw new Error('Invalid alert location');
  return {
    id: 'warning-query',
    latitude,
    longitude,
    countryCode,
    country: countryCode,
    admin: p.get('admin') ?? '',
    name: p.get('name') || 'Selected point',
  };
}
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
export async function handleAlerts(request: Request): Promise<Response> {
  if (request.method !== 'GET')
    return new Response(JSON.stringify({ error: true, reason: 'Use GET for warning checks.' }), {
      status: 405,
      headers: { ...headers, Allow: 'GET' },
    });
  let place: Place;
  try {
    place = alertPlace(new URL(request.url));
  } catch {
    return new Response(
      JSON.stringify({
        error: true,
        reason: 'Choose a valid location to check official warnings.',
      }),
      { status: 400, headers },
    );
  }
  if (!place.countryCode)
    return new Response(
      JSON.stringify({
        error: true,
        reason:
          'This point has no country information. Choose a city from search or quick locations to check official warnings. No warning source was checked.',
      }),
      { status: 400, headers },
    );
  const [client, network] = clientKeys(request);
  const release = client ? admit(client, network, lookupKey(place)) : () => {};
  if (!release)
    return new Response(
      JSON.stringify({
        error: true,
        reason:
          'The warning service is busy, and other checks from your network are still running. Retry shortly, or check the official authority directly.',
      }),
      { status: 429, headers: { ...headers, 'Retry-After': '5' } },
    );
  const controller = new AbortController();
  const onAbort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const timeout = setTimeout(
    () => controller.abort(new Error('Warning sources timed out. Check the authority directly.')),
    18_000,
  );
  try {
    const result =
      ['PH', 'ID'].includes(place.countryCode) || supportsKolkata(place)
        ? await fetchLocalAlerts(place, controller.signal)
        : place.countryCode === 'IN'
          ? await fetchIndiaAlerts(place, { signal: controller.signal })
          : await fetchGlobalAlerts(place, controller.signal);
    const {
      revokedCapKeys: _internal,
      upcomingDocuments: _upcoming,
      upcomingAt: _upcomingAt,
      ...publicResult
    } = result as typeof result & {
      revokedCapKeys?: string[];
      upcomingDocuments?: number;
      upcomingAt?: number;
    };
    // The gateway's own clock when answering: clients measure a check's age and judge validity
    // times with it, so a device clock that runs fast or slow does not hide current warnings.
    return new Response(JSON.stringify({ ...publicResult, servedAt: Date.now() }), { headers });
  } catch (error) {
    console.warn(
      'Official warning retrieval failed:',
      error instanceof Error ? error.message.slice(0, 300) : 'Unknown failure',
    );
    return new Response(
      JSON.stringify({
        error: true,
        reason:
          'Official warnings could not be verified. A source could not be reached or validated. Check the official authority and try again shortly.',
      }),
      { status: 503, headers },
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', onAbort);
    release();
  }
}
