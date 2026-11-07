import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  clearDisasterCache,
  distanceKm,
  fetchDisasters,
  gdacsTimestamp,
  nearbyDisasters,
  parseDisasterFeatures,
} from '../src/disasters';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const now = Date.parse('2026-10-31T00:00:00Z');
const place = { latitude: 13.08, longitude: 80.27 };
const feature = (
  properties: Record<string, unknown> = {},
  coordinates: unknown = [81.8, 16.4],
) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: {
    eventtype: 'TC',
    eventid: 1001,
    episodeid: 3,
    name: 'Cyclone report',
    country: 'India',
    alertlevel: 'Red',
    fromdate: '2026-10-26T00:00:00',
    todate: '2026-10-28T06:00:00',
    datemodified: '2026-10-29T08:00:00',
    source: 'JTWC',
    ...properties,
  },
});
const collection = (features: unknown[]) => ({ type: 'FeatureCollection', features });
const response = (features: unknown[], status = 200) =>
  new Response(JSON.stringify(collection(features)), {
    status,
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => {
  clearDisasterCache();
  Date.now = () => now;
});
afterEach(() => {
  clearDisasterCache();
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

test('GDACS zone-less dates use UTC explicitly, invalid timestamps remain unavailable', () => {
  assert.equal(gdacsTimestamp('2026-10-29T08:00:00'), Date.parse('2026-10-29T08:00:00Z'));
  assert.equal(gdacsTimestamp('2026-10-29T13:30:00+05:30'), Date.parse('2026-10-29T08:00:00Z'));
  assert.equal(gdacsTimestamp('2026-02-30T08:00:00'), null);
  assert.equal(gdacsTimestamp('not a date'), null);
  assert.equal(gdacsTimestamp(null), null);
});

test('validates supported event types, identifiers, coordinates and report periods', () => {
  const results = parseDisasterFeatures(
    collection([
      feature(),
      feature({ eventtype: 'EQ' }),
      feature({ eventid: -1 }),
      feature({}, [400, 16]),
      feature({ todate: 'bad' }),
      feature({ fromdate: '2026-11-20T00:00:00' }),
    ]),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, 'TC');
  assert.equal(results[0].impact, 'Red');
  assert.equal(results[0].latitude, 16.4);
});

test('official report URLs use validated IDs rather than untrusted payload URLs', () => {
  const [event] = parseDisasterFeatures(
    collection([feature({ url: { report: 'javascript:alert(1)' }, episodeid: 'bad' })]),
  );
  const link = new URL(event.reportUrl);
  assert.equal(link.protocol, 'https:');
  assert.equal(link.hostname, 'www.gdacs.org');
  assert.equal(link.searchParams.get('eventid'), '1001');
  assert.equal(link.searchParams.has('episodeid'), false);
});

test('distance calculation handles dateline and antipodal points without NaN', () => {
  assert.ok(distanceKm(0, 179, 0, -179) > 220 && distanceKm(0, 179, 0, -179) < 224);
  assert.equal(distanceKm(13, 80, 13, 80), 0);
  assert.ok(Number.isFinite(distanceKm(0, 0, 0, 180)));
  assert.throws(() => distanceKm(100, 0, 0, 0), /Invalid coordinates/);
});

test('search radius filters representative points and old reports without treating green as safe', () => {
  const events = parseDisasterFeatures(
    collection([
      feature({ alertlevel: 'Green' }),
      feature({ eventid: 2 }, [-80, 25]),
      feature({ eventid: 3, fromdate: '2026-08-01T00:00:00', todate: '2026-08-02T00:00:00' }),
    ]),
  );
  assert.equal(nearbyDisasters(events, place, 250, now).length, 0);
  const near = nearbyDisasters(events, place, 1000, now);
  assert.equal(near.length, 1);
  assert.equal(near[0].impact, 'Green');
  assert.ok(near[0].distanceKm > 250);
  assert.throws(() => nearbyDisasters(events, place, 999, now), /supported/);
});

test('request includes all three impact levels and preserves true fetch time through cache', async () => {
  let calls = 0;
  globalThis.fetch = async (target) => {
    calls++;
    const p = new URL(String(target)).searchParams;
    assert.equal(p.get('alertlevel'), 'red;orange;green');
    assert.equal(p.get('eventlist'), 'TC;FL;WF');
    return response([feature()]);
  };
  const first = await fetchDisasters();
  Date.now = () => now + 60_000;
  const second = await fetchDisasters();
  assert.equal(calls, 1);
  assert.equal(first.fetchedAt, second.fetchedAt);
  assert.equal(first.events[0].updatedAt, Date.parse('2026-10-29T08:00:00Z'));
});

test('expired cache and explicit refresh obtain a new snapshot', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response([feature()]);
  };
  await fetchDisasters();
  Date.now = () => now + 11 * 60_000;
  await fetchDisasters();
  await fetchDisasters(undefined, true);
  assert.equal(calls, 3);
});

test('failed feed is explicit, never replaced by an empty success or fabricated reports', async () => {
  globalThis.fetch = async () => response([], 503);
  await assert.rejects(fetchDisasters(), /unavailable \(HTTP 503\)/);
  globalThis.fetch = async () => new Response('{}');
  await assert.rejects(fetchDisasters(), /unexpected report format/);
});

test('HTML success responses are rejected as provider pages and never cached as reports', async () => {
  for (const contentType of ['text/html; charset=utf-8', 'application/xhtml+xml', 'Text/Html']) {
    clearDisasterCache();
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { 'Content-Type': contentType } },
      );
    await assert.rejects(
      fetchDisasters(),
      /GDACS returned a web page instead of report data\. Open the official GDACS source or try again later\./,
    );
    assert.equal(cancelled, true, 'Release the provider HTML body without reading it');
    globalThis.fetch = async () => response([feature()]);
    assert.equal((await fetchDisasters()).events.length, 1, 'A later valid response can recover');
  }
});

test('an HTML second page retains verified first-page reports with explicit partial coverage', async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? response(Array.from({ length: 100 }, (_, i) => feature({ eventid: i + 1 })))
      : new Response('<!doctype html><title>Provider page</title>', {
          headers: { 'Content-Type': 'text/html' },
        });
  const result = await fetchDisasters();
  assert.equal(calls, 2);
  assert.equal(result.partial, true);
  assert.equal(result.recordsRead, 100);
  assert.equal(result.events.length, 100);
});

test('bounded pagination exposes truncation instead of claiming complete global coverage', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response(Array.from({ length: 100 }, (_, i) => feature({ eventid: calls * 1000 + i })));
  };
  const result = await fetchDisasters();
  assert.equal(calls, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.recordsRead, 200);
});

test('second-page failure retains first-page reports with partial flag', async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? response(Array.from({ length: 100 }, (_, i) => feature({ eventid: i + 1 })))
      : response([], 503);
  const result = await fetchDisasters();
  assert.equal(result.partial, true);
  assert.equal(result.events.length, 100);
});

test('oversized responses and caller cancellation are rejected', async () => {
  globalThis.fetch = async () => new Response('{}', { headers: { 'content-length': '3000000' } });
  await assert.rejects(fetchDisasters(), /safely read/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchDisasters(controller.signal), { name: 'AbortError' });
});

test('rejected GDACS bodies are cancelled without replacing the provider error', async () => {
  for (const [status, headers, message] of [
    [503, {}, /HTTP 503/],
    [200, { 'content-length': '3000000' }, /safely read/],
  ] as const) {
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status, headers },
      );
    await assert.rejects(fetchDisasters(), message);
    assert.equal(cancelled, true, `Release the unread HTTP ${status} body`);
  }
});

test('explicit-zone GDACS timestamps reject impossible calendar dates', () => {
  for (const invalid of [
    '2026-02-30T08:00:00Z',
    '2026-02-30T08:00:00+05:30',
    '2026-04-31T08:00:00-04:00',
  ]) {
    assert.equal(gdacsTimestamp(invalid), null, invalid);
  }
  assert.equal(
    gdacsTimestamp('2024-02-29T08:00:00+05:30'),
    Date.parse('2024-02-29T08:00:00+05:30'),
  );
});
