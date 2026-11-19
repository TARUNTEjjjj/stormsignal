/**
 * Worker CPU harness for the IMD district-feed check (issue #16). It runs inside workerd through
 * `npm run measure:worker-cpu`, which starts it with `wrangler dev` at the repository's Worker
 * compatibility date. Nothing here contacts a provider: the global `fetch` is replaced by a fake
 * that serves synthetic fixtures (imd-fixtures.ts), so the measured time is this code's work and
 * any simulated upstream wait is recorded separately.
 *
 * Local workerd keeps a real clock during execution (deployed Workers do not advance it during
 * pure computation), and the fixture is already in memory, so wall time across a synchronous or
 * microtask-only section is CPU time on an otherwise idle machine. It is not Cloudflare's billed
 * CPU figure: the deployed hardware, isolate state and JIT can differ.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import pages from '../../server/pages.ts';
import { createKolkataAlertAdapter } from '../../server/kolkata.ts';
import { clearWarningCache, requestText, readsSettled } from '../../server/http.ts';
import type { Place } from '../../src/types.ts';
import { FEED_MAX_BYTES, imdFeed, standardFixtures } from './imd-fixtures.ts';

const IMD = 'https://mausam.imd.gov.in/imd_latest/contents/dist_nowcast_rss.php';
const KOLKATA: Place = {
  id: '1275004',
  name: 'Kolkata',
  country: 'India',
  countryCode: 'IN',
  admin: 'West Bengal',
  latitude: 22.56263,
  longitude: 88.36304,
};
const nativeFetch = globalThis.fetch;
const encoder = new TextEncoder();
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

type Upstream = (url: string, signal: AbortSignal | undefined) => Promise<Response>;
interface Fake {
  calls: string[];
  /** Milliseconds this fake spent waiting on timers: simulated network time, not CPU. */
  waited: number;
}
const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
/** Install a fake upstream for one scenario; every request is answered in-process. */
function fakeFetch(upstream: Upstream): Fake {
  const fake: Fake = { calls: [], waited: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    fake.calls.push(url);
    return upstream(url, init?.signal ?? undefined);
  }) as typeof fetch;
  return fake;
}
/** Each scenario starts without a remembered or cached copy, so the upstream is always read. */
async function reset() {
  globalThis.fetch = nativeFetch;
  await readsSettled();
  clearWarningCache();
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  await cache?.delete(
    new Request(`https://stormsignal-cache.invalid/official-v1/${encodeURIComponent(IMD)}`),
  );
}
/** A body delivered in 64 KiB chunks, optionally after a simulated network wait. */
function streamed(text: string, fake: Fake, latencyMs = 0, headers: HeadersInit = {}) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset === 0 && latencyMs) {
          const started = performance.now();
          await sleep(latencyMs);
          fake.waited += performance.now() - started;
        }
        if (offset >= bytes.byteLength) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + 65_536));
        offset += 65_536;
      },
    }),
    { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', ...headers } },
  );
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
function summary(values: number[]) {
  const s = sorted(values);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    runs: s.length,
    first: round(values[0]),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(s[s.length - 1]),
  };
}

/** Same parser options as server/kolkata.ts, for the per-phase breakdown only. */
const phaseParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

/** CPU of the Kolkata adapter alone: the fixture is handed over from memory, with no I/O. */
async function parse(name: string, runs: number) {
  const fixtures = standardFixtures(Date.now());
  const raw = fixtures[name];
  if (!raw)
    return json(
      { error: `Unknown fixture; choose one of: ${Object.keys(fixtures).join(', ')}` },
      400,
    );
  const adapter = createKolkataAlertAdapter(async () => ({ text: raw, fetchedAt: Date.now() }));
  const totals: number[] = [];
  let alerts = 0;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    alerts = (await adapter(KOLKATA)).alerts.length;
    totals.push(performance.now() - started);
  }
  // One pass of each expensive phase on its own, to show where the time goes.
  const phase = (run: () => unknown) => {
    const started = performance.now();
    run();
    return Math.round((performance.now() - started) * 100) / 100;
  };
  const phases = {
    utf8Length: phase(() => encoder.encode(raw).byteLength),
    xmlValidate: phase(() => XMLValidator.validate(raw)),
    xmlParse: phase(() => phaseParser.parse(raw)),
  };
  return json({
    fixture: name,
    bytes: encoder.encode(raw).byteLength,
    entries: raw.split('<item ').length - 1,
    kolkataAlerts: alerts,
    adapterMs: summary(totals),
    phasesMs: phases,
  });
}

/**
 * A whole /api/alerts request through the production Pages entry (server/pages.ts): router,
 * admission, both Kolkata sources, bounded read, parse and response serialization. The IMD fake
 * answers after `latency` ms; SACHET answers 404 at once (not retried), as an unavailable partner.
 */
async function request(name: string, latency: number, runs: number) {
  const fixtures = standardFixtures(Date.now());
  const raw = fixtures[name];
  if (!raw) return json({ error: 'Unknown fixture' }, 400);
  const walls: number[] = [],
    waits: number[] = [],
    cpu: number[] = [];
  let status = 0,
    body: { checks?: { id: string; status: string }[]; alerts?: unknown[] } = {};
  for (let run = 0; run < runs; run++) {
    await reset();
    const fake = fakeFetch(async (url) =>
      url === IMD ? streamed(raw, fake, latency) : new Response('Not found', { status: 404 }),
    );
    const pending: Promise<unknown>[] = [];
    const query = new URLSearchParams({
      lat: String(KOLKATA.latitude),
      lon: String(KOLKATA.longitude),
      country: 'IN',
      admin: 'West Bengal',
      name: 'Kolkata',
    });
    const started = performance.now();
    const response = await pages.fetch(
      new Request(`https://stormsignal.invalid/api/alerts?${query}`),
      { ASSETS: { fetch: async () => new Response(null, { status: 404 }) } },
      { waitUntil: (promise) => pending.push(promise) },
    );
    const text = await response.text();
    const wall = performance.now() - started;
    await Promise.all(pending);
    status = response.status;
    body = JSON.parse(text);
    walls.push(wall);
    waits.push(fake.waited);
    cpu.push(wall - fake.waited);
  }
  await reset();
  return json({
    fixture: name,
    simulatedUpstreamLatencyMs: latency,
    status,
    alerts: body.alerts?.length ?? null,
    checks: body.checks?.map((check) => `${check.id}:${check.status}`) ?? null,
    wallMs: summary(walls),
    simulatedNetworkWaitMs: summary(waits),
    cpuMs: summary(cpu),
  });
}

/** Bounded-read, timeout and error behaviour of the real requestText and adapter in workerd. */
const limitCases: Record<string, { expect: RegExp; upstream: (fake: Fake) => Upstream }> = {
  'declared-oversize': {
    expect: /exceeds the size limit/,
    upstream: (fake) => async () =>
      streamed('x', fake, 0, { 'Content-Length': String(FEED_MAX_BYTES + 1) }),
  },
  'streamed-oversize': {
    expect: /exceeds the size limit/,
    upstream: (fake) => async () => streamed('x'.repeat(FEED_MAX_BYTES + 1), fake),
  },
  'stalled-headers': {
    expect: /timed out/,
    upstream: () => (_url, signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  },
  'stalled-body': {
    expect: /timed out/,
    upstream: () => async () =>
      new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
        headers: { 'Content-Type': 'application/rss+xml' },
      }),
  },
  'http-503-retried-once': {
    expect: /HTTP 503/,
    upstream: () => async () => new Response('busy', { status: 503 }),
  },
  'http-404-not-retried': {
    expect: /HTTP 404/,
    upstream: () => async () => new Response('missing', { status: 404 }),
  },
  'connection-error-retried-once': {
    expect: /connection reset/,
    upstream: () => async () => {
      throw new TypeError('connection reset (simulated)');
    },
  },
  'malformed-xml': {
    expect: /XML is malformed/,
    upstream: (fake) => async () =>
      streamed(imdFeed({ entries: 3, now: Date.now() }).replace('</channel>', ''), fake),
  },
  'over-entry-limit': {
    expect: /too many entries/,
    upstream: (fake) => async () => {
      const feed = imdFeed({ entries: 1000, now: Date.now() });
      const extra = feed.slice(feed.indexOf('<item '), feed.indexOf('</item>') + 7);
      return streamed(feed.replace('</channel>', `${extra}</channel>`), fake);
    },
  },
};
async function limit(name: string) {
  const scenario = limitCases[name];
  if (!scenario)
    return json(
      { error: `Unknown case; choose one of: ${Object.keys(limitCases).join(', ')}` },
      400,
    );
  await reset();
  const fake: Fake = { calls: [], waited: 0 };
  const upstream = scenario.upstream(fake);
  const installed = fakeFetch(upstream);
  const adapter = createKolkataAlertAdapter(requestText);
  const started = performance.now();
  let error = '';
  try {
    await adapter(KOLKATA);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const elapsed = Math.round(performance.now() - started);
  await reset();
  return json({
    case: name,
    error,
    passed: scenario.expect.test(error),
    expected: String(scenario.expect),
    elapsedMs: elapsed,
    upstreamCalls: installed.calls.length,
  });
}

export default {
  async fetch(incoming: Request): Promise<Response> {
    const url = new URL(incoming.url);
    const runs = Math.min(Math.max(Number(url.searchParams.get('runs')) || 1, 1), 200);
    const fixture = url.searchParams.get('fixture') ?? '';
    try {
      if (url.pathname === '/fixtures') return json(Object.keys(standardFixtures(Date.now())));
      if (url.pathname === '/limits') return json(Object.keys(limitCases));
      if (url.pathname === '/parse') return await parse(fixture, runs);
      if (url.pathname === '/request')
        return await request(
          fixture,
          Math.max(Number(url.searchParams.get('latency')) || 0, 0),
          runs,
        );
      if (url.pathname === '/limit') return await limit(url.searchParams.get('case') ?? '');
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  },
};
