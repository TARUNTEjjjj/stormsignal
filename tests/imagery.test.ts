import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_IMAGERY,
  regionalImagery,
  imageryForPlace,
  normalizeLongitude,
  parseDomainTimes,
  imageryTileUrl,
  domainUrl,
  isFrameStale,
  fetchImageryFrames,
} from '../src/imagery';

const now = Date.parse('2026-10-30T18:00:00Z');
const infrared = regionalImagery(13.08, 80.27)!;

test('satellite selection respects useful geostationary coverage, including the dateline', () => {
  assert.equal(infrared.id, 'Himawari_AHI_Band13_Clean_Infrared');
  assert.match(regionalImagery(28, -82)!.id, /GOES-East/);
  assert.match(regionalImagery(21, -158)!.id, /GOES-West/);
  assert.ok(regionalImagery(0, 179));
  assert.equal(regionalImagery(52, 0), null);
  assert.equal(regionalImagery(80, 120), null);
  assert.equal(regionalImagery(NaN, 80), null);
  assert.equal(imageryForPlace(52, 0)[0].kind, 'daily');
});
test('longitude wraps coordinates consistently and rejects invalid coordinates', () => {
  assert.equal(normalizeLongitude(181), -179);
  assert.equal(normalizeLongitude(-181), 179);
  assert.equal(normalizeLongitude(540), -180);
  assert.throws(() => normalizeLongitude(NaN));
});
test('time parser preserves observed gaps and excludes future frames', () => {
  const xml =
    '<Domains><DimensionDomain><Domain>2026-10-30T17:00:00Z/2026-10-30T17:20:00Z/PT10M,2026-10-30T17:40:00Z/2026-10-30T18:20:00Z/PT10M</Domain></DimensionDomain></Domains>';
  assert.deepEqual(parseDomainTimes(xml, infrared, now), [
    '2026-10-30T17:00:00Z',
    '2026-10-30T17:10:00Z',
    '2026-10-30T17:20:00Z',
    '2026-10-30T17:40:00Z',
    '2026-10-30T17:50:00Z',
    '2026-10-30T18:00:00Z',
  ]);
});
test('time parser bounds historical expansion and keeps only twelve recent infrared frames', () => {
  const frames = parseDomainTimes('<Domain>2010-01-01/2026-10-31/PT10M</Domain>', infrared, now);
  assert.equal(frames.length, 12);
  assert.equal(frames.at(-1), '2026-10-30T18:00:00Z');
  assert.equal(frames[0], '2026-10-30T16:10:00Z');
});
test('daily composites have dates, not fabricated capture times; future advertised days excluded', () => {
  const frames = parseDomainTimes('<Domain>2026-10-20/2026-10-31/P1D</Domain>', DAILY_IMAGERY, now);
  assert.deepEqual(frames, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
});
test('malformed metadata, unsupported durations and invalid calendar dates cannot become frames', () => {
  assert.throws(() => parseDomainTimes('<Exception/>', infrared, now));
  assert.throws(() => parseDomainTimes('x'.repeat(200001), infrared, now));
  assert.deepEqual(
    parseDomainTimes(
      '<Domain>2026-10-30T17:00:00Z/2026-10-30T18:00:00Z/PT1M,2026-02-30</Domain>',
      infrared,
      now,
    ),
    [],
  );
});
test('timestamped tile URLs have provider matrix order and never interpolate untrusted dates', () => {
  assert.equal(
    imageryTileUrl(infrared, '2026-10-30T17:40:00Z'),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/2026-10-30T17:40:00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png',
  );
  assert.throws(() => imageryTileUrl(infrared, '2026-10-30'));
  assert.throws(() => imageryTileUrl(DAILY_IMAGERY, '../../secret'));
  assert.throws(() => imageryTileUrl({ ...DAILY_IMAGERY, id: '../secret' }, '2026-10-30'));
});
test('metadata queries are bounded per layer and stale thresholds distinguish observations/composites', () => {
  const url = new URL(domainUrl(infrared, now));
  assert.equal(url.searchParams.get('REQUEST'), 'DescribeDomains');
  assert.equal(url.searchParams.get('TIME'), '2026-10-29T18:00:00Z/2026-10-30T18:00:00Z');
  assert.equal(isFrameStale('2026-10-30T17:30:00Z', 'infrared', now), false);
  assert.equal(isFrameStale('2026-10-30T16:00:00Z', 'infrared', now), true);
  assert.equal(isFrameStale('2026-10-26', 'daily', now), true);
});

test('metadata URL rounds fractional wall-clock seconds to the provider frame cadence', () => {
  const raw = domainUrl(infrared, now + 57_992);
  assert.ok(raw.includes('TIME=2026-10-29T18:00:00Z/2026-10-30T18:00:00Z'));
  const url = new URL(raw);
  assert.equal(url.searchParams.get('TIME'), '2026-10-29T18:00:00Z/2026-10-30T18:00:00Z');
  const daily = new URL(domainUrl(DAILY_IMAGERY, now + 57_992));
  assert.equal(daily.searchParams.get('TIME'), '2026-10-23/2026-10-30');
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.timers.reset();
});
// Rejects like a browser fetch when its signal aborts, and never resolves otherwise.
const hangingFetch = (async (_target: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('This operation was aborted', 'AbortError')),
    );
  })) as typeof fetch;

test('imagery metadata timeouts and network failures give a readable message', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = hangingFetch;
  const pending = fetchImageryFrames(DAILY_IMAGERY, undefined, true);
  mock.timers.tick(15_000);
  await assert.rejects(pending, /^Error: NASA imagery metadata timed out/);

  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  await assert.rejects(
    fetchImageryFrames(DAILY_IMAGERY, undefined, true),
    /^Error: NASA imagery metadata could not be reached/,
  );
});

test('imagery metadata cancelled by the caller still rejects as an abort', async () => {
  globalThis.fetch = hangingFetch;
  const controller = new AbortController();
  const pending = fetchImageryFrames(DAILY_IMAGERY, controller.signal, true);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('an already-cancelled imagery request cannot receive cached frames', async () => {
  const today = new Date().toISOString().slice(0, 10);
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(`<Domain>${today}</Domain>`);
  }) as typeof fetch;
  assert.deepEqual(await fetchImageryFrames(DAILY_IMAGERY, undefined, true), [today]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchImageryFrames(DAILY_IMAGERY, controller.signal), {
    name: 'AbortError',
  });
  assert.equal(requests, 1);
});

test('imagery metadata enforces the byte limit on chunked UTF-8 and cancels unread data', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const encoder = new TextEncoder();
  let cancelled = false;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`<Domain>${today}</Domain>`));
          // Fewer than 200,000 characters, but more than 200,000 UTF-8 bytes.
          controller.enqueue(encoder.encode('é'.repeat(100_001)));
          controller.enqueue(encoder.encode('unread tail'));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
    )) as typeof fetch;
  await assert.rejects(
    fetchImageryFrames(DAILY_IMAGERY, undefined, true),
    /Imagery metadata exceeded the size limit/,
  );
  assert.equal(cancelled, true);
});

test('rejected imagery responses cancel their unread body', async () => {
  for (const options of [{ status: 503 }, { headers: { 'content-length': '200001' } }]) {
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        options,
      )) as typeof fetch;
    await assert.rejects(fetchImageryFrames(DAILY_IMAGERY, undefined, true));
    assert.equal(cancelled, true);
  }
});
