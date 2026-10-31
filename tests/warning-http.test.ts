import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { clearWarningCache, requestText } from '../server/http';

const SOURCE = 'https://severeweather.wmo.int/f/ows/test.json';
const START = Date.UTC(2026, 10, 1, 3);
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
let now = START;
let calls: { target: string; init: RequestInit | undefined }[] = [];

function mockFetch(handle: (target: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    calls.push({ target, init });
    return handle(target, init);
  };
}

function optionalEdgeCache() {
  const entries = new Map<string, Response>();
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        match: async (key: Request) => entries.get(key.url)?.clone(),
        put: async (key: Request, response: Response) => {
          entries.set(key.url, response.clone());
        },
      },
    },
  });
  return entries;
}

beforeEach(() => {
  clearWarningCache();
  now = START;
  calls = [];
  Date.now = () => now;
  Reflect.deleteProperty(globalThis, 'caches');
  mockFetch(async () => {
    throw Error('Unexpected upstream request');
  });
});

afterEach(() => {
  clearWarningCache();
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
  else Reflect.deleteProperty(globalThis, 'caches');
});

test('warning requests reject arbitrary hosts, credentials, protocols and encoded path escapes', async () => {
  for (const target of [
    'http://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml',
    'https://attacker.example/feed.xml',
    'https://severeweather.wmo.int.attacker.example/json/sources.json',
    'https://user:pass@severeweather.wmo.int/json/sources.json',
    'https://severeweather.wmo.int:8443/json/sources.json',
    'https://severeweather.wmo.int/json/sources.json#ignored',
    'https://severeweather.wmo.int/admin.json',
    'https://sachet.ndma.gov.in/private.xml',
    'https://severeweather.wmo.int/v2/cap-alerts/../../private.xml',
    'https://severeweather.wmo.int/v2/cap-alerts/%2e%2e%2fprivate.xml',
    'https://severeweather.wmo.int/v2/cap-alerts/%252e%252e%252fprivate.xml',
    'https://severeweather.wmo.int/v2/cap-alerts/sub%2ffeed.xml',
    'https://severeweather.wmo.int/v2/cap-alerts/sub%5cfeed.xml',
  ]) {
    await assert.rejects(requestText(target), /Unsupported warning source/, target);
  }
  assert.equal(calls.length, 0);
});

test('approved provider paths forbid redirect following and use bounded request cancellation', async () => {
  mockFetch(async () => new Response('<feed/>'));
  for (const target of [
    SOURCE,
    'https://severeweather.wmo.int/json/sources.json',
    'https://severeweather.wmo.int/v2/cap-alerts/test/alert-123.xml',
    'https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml',
    'https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=test',
  ]) {
    assert.equal((await requestText(target)).text, '<feed/>');
  }
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.init?.redirect, 'error');
    assert.ok(call.init?.signal instanceof AbortSignal);
    assert.match(new Headers(call.init?.headers).get('accept')!, /application\/xml/);
  }
});

test('fresh memory cache preserves the actual retrieval time and respects TTL', async () => {
  mockFetch(async () => new Response('first', { headers: { ETag: '"v1"' } }));
  const first = await requestText(SOURCE, { ttlMs: 60_000 });
  now += 59_999;
  assert.deepEqual(await requestText(SOURCE, { ttlMs: 60_000 }), first);
  assert.equal(first.fetchedAt, START);
  assert.equal(calls.length, 1);
  now++;
  mockFetch(async () => new Response('second', { headers: { ETag: '"v2"' } }));
  const second = await requestText(SOURCE, { ttlMs: 60_000 });
  assert.equal(new Headers(calls[1].init?.headers).get('if-none-match'), '"v1"');
  assert.equal(second.text, 'second');
  assert.equal(second.fetchedAt, now);
  assert.equal(second.etag, '"v2"');
});

test('a conditional 304 retains verified text while recording the new validation time', async () => {
  mockFetch(async () => new Response('authority text', { headers: { ETag: '"v1"' } }));
  await requestText(SOURCE);
  now += 60_000;
  mockFetch(async () => new Response(null, { status: 304 }));
  assert.deepEqual(await requestText(SOURCE), {
    text: 'authority text',
    fetchedAt: now,
    etag: '"v1"',
  });
  assert.equal(new Headers(calls[1].init?.headers).get('if-none-match'), '"v1"');
  assert.equal(calls.length, 2);
});

test('304 without an existing cache entry is an error, never an empty successful feed', async () => {
  mockFetch(async () => new Response(null, { status: 304 }));
  await assert.rejects(requestText(SOURCE), /could not be revalidated/);
  mockFetch(async () => new Response('recovered'));
  assert.equal((await requestText(SOURCE)).text, 'recovered');
  assert.equal(calls.length, 2);
});

test('304 without a sent validator cannot refresh unverified old content', async () => {
  mockFetch(async () => new Response('old content without ETag'));
  await requestText(SOURCE);
  now += 60_000;
  mockFetch(async () => new Response(null, { status: 304 }));
  await assert.rejects(requestText(SOURCE), /could not be revalidated/);
  assert.equal(new Headers(calls[1].init?.headers).has('if-none-match'), false);
});

test('expired content is never returned when upstream fails or refuses the request', async () => {
  mockFetch(async () => new Response('old warning', { headers: { ETag: '"old"' } }));
  await requestText(SOURCE);
  now += 60_000;
  for (const status of [301, 429, 500, 503]) {
    mockFetch(async () => new Response('upstream failure', { status }));
    await assert.rejects(requestText(SOURCE), new RegExp(`HTTP ${status}`));
  }
  mockFetch(async () => {
    throw new TypeError('connection failed');
  });
  await assert.rejects(requestText(SOURCE), /connection failed/);
  mockFetch(async () => new Response('fresh warning'));
  const fresh = await requestText(SOURCE);
  assert.equal(fresh.text, 'fresh warning');
  assert.equal(fresh.fetchedAt, now);
  assert.equal(calls.length, 7);
});

test('declared and streamed UTF-8 byte limits reject oversized bodies without caching them', async () => {
  const cases = [
    new Response('tiny', { headers: { 'content-length': '100' } }),
    new Response('abcdef'),
    new Response('ééé'),
  ];
  for (const response of cases) {
    clearWarningCache();
    mockFetch(async () => response);
    await assert.rejects(requestText(SOURCE, { maxBytes: 5 }), /exceeds the size limit/);
    mockFetch(async () => new Response('valid'));
    assert.equal((await requestText(SOURCE, { maxBytes: 5 })).text, 'valid');
  }
});

test('invalid numeric limits cannot bypass byte bounds or reach an upstream provider', async () => {
  for (const maxBytes of [NaN, Infinity, -Infinity, 0, -1])
    await assert.rejects(requestText(SOURCE, { maxBytes }), /Invalid warning request limits/);
  for (const ttlMs of [NaN, Infinity, -Infinity])
    await assert.rejects(requestText(SOURCE, { ttlMs }), /Invalid warning request limits/);
  assert.equal(calls.length, 0);
  mockFetch(async () => new Response('x'.repeat(4_000_001)));
  await assert.rejects(requestText(SOURCE, { maxBytes: 10_000_000 }), /exceeds the size limit/);
});

test('failed status, length, stream size and UTF-8 validation cancel unread upstream bodies', async () => {
  const fixtures = [
    { bytes: new Uint8Array([65]), init: { status: 503 }, message: /HTTP 503/ },
    {
      bytes: new Uint8Array([65]),
      init: { headers: { 'Content-Length': '100' } },
      message: /exceeds the size limit/,
    },
    { bytes: new TextEncoder().encode('abcdef'), init: {}, message: /exceeds the size limit/ },
    { bytes: new Uint8Array([0xc3, 0x28]), init: {}, message: /encoded data|encoding/i },
  ];
  for (const fixture of fixtures) {
    clearWarningCache();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(fixture.bytes);
        // Keep the transfer open so successful cleanup must cancel it.
      },
      cancel() {
        cancelled++;
      },
    });
    mockFetch(async () => new Response(body, fixture.init));
    await assert.rejects(requestText(SOURCE, { maxBytes: 5 }), fixture.message);
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  }
});

test('empty and invalid UTF-8 responses fail instead of becoming reusable feed text', async () => {
  for (const response of [new Response(null), new Response(new Uint8Array([0xc3, 0x28]))]) {
    clearWarningCache();
    mockFetch(async () => response);
    await assert.rejects(requestText(SOURCE));
    mockFetch(async () => new Response('valid feed'));
    assert.equal((await requestText(SOURCE)).text, 'valid feed');
  }
});

test('a caller with a smaller byte limit cannot reuse an oversized cached response', async () => {
  mockFetch(async () => new Response('sixsix'));
  await requestText(SOURCE, { maxBytes: 10 });
  await assert.rejects(requestText(SOURCE, { maxBytes: 5 }), /exceeds the size limit/);
  assert.equal(calls.length, 1);
});

test('simultaneous readers share one request; aborting one reader does not cancel the others', async () => {
  let release!: (response: Response) => void;
  mockFetch(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const abandoned = requestText(SOURCE, { signal: controller.signal });
  const useful = requestText(SOURCE);
  const rejected = assert.rejects(abandoned, { name: 'AbortError' });
  // retrieve() checks the optional edge cache before starting its upstream call.
  while (!release) await Promise.resolve();
  assert.equal(calls.length, 1);
  controller.abort();
  release(new Response('shared warning'));
  assert.equal((await useful).text, 'shared warning');
  await rejected;
  assert.equal((await requestText(SOURCE)).text, 'shared warning');
  assert.equal(calls.length, 1);
});

test('already-aborted callers and aborts during a cache hit never receive stale success', async () => {
  const first = new AbortController();
  first.abort();
  await assert.rejects(requestText(SOURCE, { signal: first.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
  mockFetch(async () => new Response('cached content'));
  await requestText(SOURCE);
  const cached = new AbortController();
  const pending = requestText(SOURCE, { signal: cached.signal });
  cached.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('memory caching evicts the oldest entries beyond its count bound', async () => {
  mockFetch(async () => new Response('small feed'));
  const target = (i: number) => `https://severeweather.wmo.int/f/ows/cache_${i}.json`;
  for (let i = 0; i < 97; i++) await requestText(target(i));
  assert.equal(calls.length, 97);
  await requestText(target(96));
  assert.equal(calls.length, 97);
  await requestText(target(0));
  assert.equal(calls.length, 98);
});

test('memory caching also evicts large texts before the count bound is reached', async () => {
  mockFetch(async () => new Response('x'.repeat(1_600_000)));
  const target = (i: number) => `https://severeweather.wmo.int/f/ows/large_${i}.json`;
  for (let i = 0; i < 4; i++) await requestText(target(i));
  await requestText(target(3));
  assert.equal(calls.length, 4);
  await requestText(target(0));
  assert.equal(calls.length, 5);
});

test('an optional shared cache retains original times and uses validators after memory eviction', async () => {
  const edge = optionalEdgeCache();
  mockFetch(async () => new Response('shared cache text', { headers: { ETag: '"shared"' } }));
  await requestText(SOURCE);
  assert.equal(edge.size, 1);
  clearWarningCache();
  now += 30_000;
  const cached = await requestText(SOURCE);
  assert.equal(cached.fetchedAt, START);
  assert.equal(calls.length, 1);
  clearWarningCache();
  now += 30_000;
  mockFetch(async () => new Response(null, { status: 304 }));
  const checked = await requestText(SOURCE);
  assert.equal(checked.text, 'shared cache text');
  assert.equal(checked.fetchedAt, now);
  assert.equal(new Headers(calls[1].init?.headers).get('if-none-match'), '"shared"');
});

test('optional cache failures do not discard a successful upstream response', async () => {
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        match: async () => {
          throw Error('cache unavailable');
        },
        put: async () => {
          throw Error('cache quota');
        },
      },
    },
  });
  mockFetch(async () => new Response('usable upstream content'));
  assert.equal((await requestText(SOURCE)).text, 'usable upstream content');
  assert.equal(calls.length, 1);
});
