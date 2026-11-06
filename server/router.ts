import type { Place } from '../src/types.ts';
import { fetchIndiaAlerts } from './india.ts';
import { fetchGlobalAlerts } from './global.ts';
import { fetchLocalAlerts } from './local-alerts.ts';
import { supportsKolkata } from './kolkata.ts';

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
    const { revokedCapKeys: _internal, ...publicResult } = result as typeof result & {
      revokedCapKeys?: string[];
    };
    return new Response(JSON.stringify(publicResult), { headers });
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
  }
}
