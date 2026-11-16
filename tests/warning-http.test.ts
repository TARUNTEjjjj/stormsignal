import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
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
    assert.equal(call.init?.redirect, 'manual');
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

test('direct authority paths are allowlisted without accepting lookalikes or arbitrary resources', async () => {
  mockFetch(async () => new Response('<feed/>'));
  const good = [
    'https://publicalert.pagasa.dost.gov.ph/feeds/',
    'https://publicalert.pagasa.dost.gov.ph/output/gfa/12345678-1234-1234-1234-123456789abc.cap',
    'https://www.bmkg.go.id/alerts/nowcast/en',
    'https://www.bmkg.go.id/alerts/nowcast/en/ABC123_alert.xml',
    'https://mausam.imd.gov.in/imd_latest/contents/dist_nowcast_rss.php',
  ];
  for (const url of good) assert.equal((await requestText(url)).text, '<feed/>');
  assert.equal(calls.length, good.length);
  for (const url of [
    'https://publicalert.pagasa.dost.gov.ph.evil.example/feeds/',
    'https://publicalert.pagasa.dost.gov.ph/feeds/?url=https://evil.example/',
    'https://publicalert.pagasa.dost.gov.ph/output/private.xml',
    'https://user:pass@www.bmkg.go.id/alerts/nowcast/en',
    'http://www.bmkg.go.id/alerts/nowcast/en',
    'https://www.bmkg.go.id/alerts/nowcast/en/../../private.xml',
    'https://www.bmkg.go.id/alerts/nowcast/en/ABC123_alert.xml?token=x',
    'https://www.bmkg.go.id/alerts/nowcast/en#ignored',
    'https://bmkg.go.id/alerts/nowcast/en',
    'https://mausam.imd.gov.in/imd_latest/contents/dist_nowcast_rss.php?query=1',
    'https://mausam.imd.gov.in/api/districtnowcast',
  ])
    await assert.rejects(requestText(url), /Unsupported warning source/, url);
  assert.equal(calls.length, good.length);
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
  // Initial read, one retry each for 500/503/network failure, then recovery.
  assert.equal(calls.length, 10);
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
    const bodies: ReadableStream<Uint8Array>[] = [];
    mockFetch(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(fixture.bytes);
          // Keep the transfer open so successful cleanup must cancel it.
        },
        cancel() {
          cancelled++;
        },
      });
      bodies.push(body);
      return new Response(body, fixture.init);
    });
    await assert.rejects(requestText(SOURCE, { maxBytes: 5 }), fixture.message);
    assert.equal(cancelled, fixture.init.status === 503 ? 2 : 1);
    assert.ok(bodies.every((body) => !body.locked));
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

/** Raw bytes: each string character is one byte (Latin-1), and each number is one byte. */
const raw = (...parts: (string | number)[]) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === 'number' ? [part] : [...part].map((c) => c.charCodeAt(0)),
    ),
  );
/** UTF-16 text after its byte-order mark. */
function utf16(text: string, littleEndian: boolean) {
  const view = new DataView(new ArrayBuffer(2 + text.length * 2));
  view.setUint16(0, 0xfeff, littleEndian);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  return new Uint8Array(view.buffer);
}
/** A body that arrives in separate chunks, as a network read can. */
const chunked = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
const LATIN1_CAP = raw(
  '<?xml version="1.0" encoding="ISO-8859-1"?><areaDesc>C',
  0xf3,
  'rdoba</areaDesc>',
);
const LATIN1_TEXT = '<?xml version="1.0" encoding="ISO-8859-1"?><areaDesc>Córdoba</areaDesc>';

test('provider text that is not UTF-8 is read in the encoding it declares', async () => {
  const wide = '<?xml version="1.0" encoding="UTF-16"?><areaDesc>Córdoba</areaDesc>';
  const at = LATIN1_CAP.indexOf(0xf3);
  const cases: [BodyInit, Record<string, string>, string][] = [
    // Declared in both the XML declaration and the HTTP charset.
    [LATIN1_CAP, { 'Content-Type': 'application/xml; charset=ISO-8859-1' }, LATIN1_TEXT],
    // Declared only in the XML declaration; 0x96 is an en dash in windows-1252.
    [
      raw('<?xml version="1.0" encoding="windows-1252"?><event>Storm ', 0x96, ' C', 0xf3, 'rdoba'),
      {},
      '<?xml version="1.0" encoding="windows-1252"?><event>Storm – Córdoba',
    ],
    // The HTTP charset names the same encoding under another label.
    [LATIN1_CAP, { 'Content-Type': 'text/xml; charset="windows-1252"' }, LATIN1_TEXT],
    // A server's default UTF-8 charset cannot read these bytes; the document's declaration can.
    [LATIN1_CAP, { 'Content-Type': 'text/xml; charset=utf-8' }, LATIN1_TEXT],
    // UTF-16 with its byte-order mark, in either byte order, and with the mark split by the network.
    [utf16(wide, true), {}, wide],
    [utf16(wide, false), { 'Content-Type': 'application/xml' }, wide],
    [chunked(utf16(wide, true).subarray(0, 1), utf16(wide, true).subarray(1)), {}, wide],
    // The byte that is not UTF-8 arrives after earlier chunks were already read as UTF-8.
    [
      chunked(
        LATIN1_CAP.subarray(0, at - 1),
        LATIN1_CAP.subarray(at - 1, at),
        LATIN1_CAP.subarray(at),
      ),
      {},
      LATIN1_TEXT,
    ],
  ];
  for (const [body, headers, expected] of cases) {
    clearWarningCache();
    mockFetch(async () => new Response(body, { headers }));
    assert.equal((await requestText(SOURCE)).text, expected);
  }
});

test('a damaged UTF-8 document is never re-read in another encoding it does not use', async () => {
  // Hindi and Spanish text in UTF-8, with one stray byte (a windows-1252 dash) in the middle.
  const damaged = (prolog: string) => {
    const [before, after] = `${prolog}<alert><headline>बाढ़ की चेतावनी |Córdoba</headline></alert>`
      .split('|')
      .map((part) => new TextEncoder().encode(part));
    return Uint8Array.from([...before, 0x96, ...after]);
  };
  const latin1 = { 'Content-Type': 'text/xml; charset=ISO-8859-1' };
  const cases: [BodyInit, Record<string, string>][] = [
    // A server's default ISO-8859-1 charset on a UTF-8 document, with and without its declaration.
    [damaged(''), latin1],
    [damaged('<?xml version="1.0" encoding="UTF-8"?>'), latin1],
    // A wrong XML declaration, alone or repeated by the server: the bytes still read as UTF-8.
    [damaged('<?xml version="1.0" encoding="ISO-8859-1"?>'), {}],
    [damaged('<?xml version="1.0" encoding="ISO-8859-1"?>'), latin1],
    [
      damaged('<?xml version="1.0" encoding="windows-1252"?>'),
      { 'Content-Type': 'text/xml; charset=utf-8' },
    ],
    // An HTTP charset alone is not the document's own statement, even for bytes it could read.
    [
      raw('<rss><title>R', 0xed, 'o Cuarto</title></rss>'),
      { 'Content-Type': 'text/xml; charset="iso-8859-1"' },
    ],
    // The HTTP charset and the XML declaration name different encodings, or one that is unknown.
    [LATIN1_CAP, { 'Content-Type': 'text/xml; charset=shift_jis' }],
    [LATIN1_CAP, { 'Content-Type': 'text/xml; charset=x-unknown' }],
  ];
  for (const [index, [body, headers]] of cases.entries()) {
    clearWarningCache();
    mockFetch(async () => new Response(body, { headers }));
    await assert.rejects(requestText(SOURCE), /encoded data|encoding/i, `case ${index}`);
    // Nothing unverified was kept: the next read asks the provider again.
    mockFetch(async () => new Response('valid feed'));
    assert.equal((await requestText(SOURCE)).text, 'valid feed', `case ${index}`);
  }
  // The same document without the stray byte is plain UTF-8, whatever is declared around it.
  clearWarningCache();
  const intact =
    '<?xml version="1.0" encoding="ISO-8859-1"?><headline>बाढ़ की चेतावनी Córdoba</headline>';
  mockFetch(async () => new Response(new TextEncoder().encode(intact), { headers: latin1 }));
  assert.equal((await requestText(SOURCE)).text, intact);
});

test('valid UTF-8 is read as UTF-8 whatever other encoding it declares', async () => {
  const text = '<?xml version="1.0" encoding="ISO-8859-1"?><areaDesc>Córdoba</areaDesc>';
  mockFetch(
    async () =>
      new Response(new TextEncoder().encode(text), {
        headers: { 'Content-Type': 'text/xml; charset=windows-1252' },
      }),
  );
  assert.equal((await requestText(SOURCE)).text, text);
});

test('text read in a declared encoding is cached as UTF-8 and read back unchanged', async () => {
  const edge = optionalEdgeCache();
  mockFetch(async () => new Response(LATIN1_CAP));
  const first = await requestText(SOURCE);
  assert.equal(first.text, LATIN1_TEXT);
  assert.equal(edge.size, 1);
  clearWarningCache();
  now += 30_000;
  // The shared copy still names ISO-8859-1, but it is stored as UTF-8 and read as UTF-8.
  assert.deepEqual(await requestText(SOURCE), first);
  assert.equal(calls.length, 1);
});

test('text invalid in UTF-8 and in every encoding it declares is still rejected', async () => {
  const cases: [BodyInit, Record<string, string>][] = [
    // A UTF-8 byte-order mark decides the encoding, whatever the XML declaration says.
    [
      raw(0xef, 0xbb, 0xbf, '<?xml version="1.0" encoding="ISO-8859-1"?><a>C', 0xf3, 'rdoba</a>'),
      {},
    ],
    // An encoding this runtime cannot decode.
    [raw('<?xml version="1.0" encoding="x-unknown"?><a>C', 0xf3, 'rdoba</a>'), {}],
    // UTF-16 cut off inside a character.
    [raw(0xff, 0xfe, 0x3c, 0x00, 0x61), { 'Content-Type': 'application/xml; charset=utf-16le' }],
  ];
  for (const [body, headers] of cases) {
    clearWarningCache();
    mockFetch(async () => new Response(body, { headers }));
    await assert.rejects(requestText(SOURCE), /encoded data|encoding/i);
  }
  // Reading on in a declared encoding keeps the byte limit.
  clearWarningCache();
  mockFetch(async () => new Response(chunked(LATIN1_CAP, raw('x'.repeat(100)))));
  await assert.rejects(requestText(SOURCE, { maxBytes: 100 }), /exceeds the size limit/);
});

test('invalid UTF-8 that declares only UTF-8 still stops the read at once', async () => {
  for (const [bytes, headers] of [
    [
      raw('<?xml version="1.0" encoding="UTF-8"?><a>C', 0xf3, 'rdoba</a>'),
      { 'Content-Type': 'text/xml; charset=utf-8' },
    ],
    [raw('<a>C', 0xf3, 'rdoba</a>'), { 'Content-Type': 'text/xml' }],
  ] as const) {
    clearWarningCache();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        // The transfer stays open, so only an immediate rejection ends this read.
      },
      cancel() {
        cancelled++;
      },
    });
    mockFetch(async () => new Response(body, { headers }));
    await assert.rejects(requestText(SOURCE), /encoded data|encoding/i);
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
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

const DAY = 24 * 60 * 60_000;

test('a memory entry is a revalidation base only within 24-hour retention, then the feed is read afresh', async () => {
  mockFetch(async () => new Response('day-0 text', { headers: { ETag: '"day0"' } }));
  await requestText(SOURCE);
  // The provider confirms a validator it is sent; a read without one gets the current document.
  mockFetch(async (_target, init) =>
    new Headers(init?.headers).has('if-none-match')
      ? new Response(null, { status: 304 })
      : new Response('current text', { headers: { ETag: '"current"' } }),
  );
  now += DAY - 1;
  assert.deepEqual(await requestText(SOURCE), {
    text: 'day-0 text',
    fetchedAt: now,
    etag: '"day0"',
  });
  assert.equal(new Headers(calls[1].init?.headers).get('if-none-match'), '"day0"');
  // Retention runs from that confirmation. Once it has passed, the entry's validator is not sent.
  now += DAY;
  assert.deepEqual(await requestText(SOURCE), {
    text: 'current text',
    fetchedAt: now,
    etag: '"current"',
  });
  assert.equal(new Headers(calls[2].init?.headers).has('if-none-match'), false);
  assert.equal(calls.length, 3);
});

test('past 24-hour retention, a 304 cannot revive an entry kept in memory or in the shared cache', async () => {
  const edge = optionalEdgeCache();
  mockFetch(async () => new Response('day-0 text', { headers: { ETag: '"day0"' } }));
  await requestText(SOURCE);
  assert.equal(edge.size, 1);
  now += 3 * DAY;
  mockFetch(async () => new Response(null, { status: 304 }));
  await assert.rejects(requestText(SOURCE), /could not be revalidated/);
  assert.equal(new Headers(calls[1].init?.headers).has('if-none-match'), false);
  mockFetch(async () => new Response('current text'));
  assert.equal((await requestText(SOURCE)).text, 'current text');
  assert.equal(calls.length, 3);
});

test('memory caching drops entries past retention at the next read, before they can crowd out a current one', async () => {
  const edge = optionalEdgeCache();
  const target = (i: number) => `https://severeweather.wmo.int/f/ows/aged_${i}.json`;
  mockFetch(async () => new Response('small feed'));
  for (let i = 0; i < 95; i++) await requestText(target(i));
  clearWarningCache();
  // An hour later SOURCE is read and kept in memory only. The 95 older documents then return from
  // the shared cache with their original times, which fills memory to its count bound. A day-long
  // TTL lets each cached copy be served without an upstream read.
  now += 60 * 60_000;
  await requestText(SOURCE);
  edge.delete([...edge.keys()].at(-1)!);
  for (let i = 0; i < 95; i++) await requestText(target(i), { ttlMs: DAY });
  assert.equal(calls.length, 96);
  // At 24 hours the 95 are past retention and SOURCE is not. The next read drops them, so the new
  // document fits beside SOURCE instead of evicting it as the oldest entry.
  now = START + DAY;
  await requestText(target(95));
  await requestText(SOURCE, { ttlMs: DAY });
  assert.equal(calls.length, 97);
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

test('a body that fails its caller check is never kept, so the last good copy is revalidated', async () => {
  optionalEdgeCache();
  const validate = (text: string) => {
    if (!text.startsWith('{')) throw Error('Not the expected document');
  };
  const page = () => new Response('<html>Maintenance</html>', { headers: { ETag: '"page"' } });
  // A copy that was kept without the check, as by an earlier release, is a shared-cache miss.
  mockFetch(async () => page());
  await requestText(SOURCE);
  clearWarningCache();
  mockFetch(async () => new Response('{"version":1}', { headers: { ETag: '"good"' } }));
  assert.equal((await requestText(SOURCE, { validate })).text, '{"version":1}');
  assert.equal(new Headers(calls[1].init?.headers).has('if-none-match'), false);
  // A revalidation answered with an unusable body fails, and does not replace the good copy.
  now += 60_000;
  mockFetch(async () => page());
  await assert.rejects(requestText(SOURCE, { validate }), /Not the expected document/);
  mockFetch(async () => new Response(null, { status: 304 }));
  assert.equal((await requestText(SOURCE, { validate })).text, '{"version":1}');
  assert.equal(new Headers(calls[3].init?.headers).get('if-none-match'), '"good"');
  assert.equal(calls.length, 4);
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

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}
async function advance(t: TestContext, ms: number) {
  now += ms;
  t.mock.timers.tick(ms);
  await flush();
}
const never = () => new Promise<never>(() => {});

function cacheWith(overrides: Record<string, unknown>) {
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => {}, ...overrides } },
  });
}

test('a stalled optional cache lookup falls through to the provider and permits later reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cacheWith({ match: never });
  mockFetch(async () => new Response('fresh verified text'));
  const first = requestText(SOURCE);
  await flush();
  assert.equal(calls.length, 0);
  await advance(t, 200);
  assert.equal((await first).text, 'fresh verified text');
  assert.equal((await requestText(SOURCE)).text, 'fresh verified text');
  assert.equal(calls.length, 1);
});

test('a stalled cached body and its cancellation cannot block a fresh provider read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('incomplete cache'));
    },
    cancel() {
      cancelled++;
      return never();
    },
  });
  cacheWith({
    match: async () => new Response(body, { headers: { 'x-storm-fetched-at': String(now) } }),
  });
  mockFetch(async () => new Response('complete upstream text'));
  const result = requestText(SOURCE);
  await flush();
  await advance(t, 200);
  assert.equal((await result).text, 'complete upstream text');
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal((await requestText(SOURCE)).text, 'complete upstream text');
  assert.equal(calls.length, 1);
});

test('a stalled optional cache write cannot withhold a verified response from shared readers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  cacheWith({ put: never });
  mockFetch(async () => new Response('verified upstream text'));
  const first = requestText(SOURCE);
  const second = requestText(SOURCE);
  await flush();
  assert.equal(calls.length, 1);
  await advance(t, 200);
  assert.equal((await first).text, 'verified upstream text');
  assert.deepEqual(await second, await first);
  assert.equal((await requestText(SOURCE)).text, 'verified upstream text');
  assert.equal(calls.length, 1);
});

test('an abort-ignoring transport times out, releases the shared slot and cannot overwrite recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: (response: Response) => void;
  mockFetch(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = requestText(SOURCE);
  const rejected = assert.rejects(first, { name: 'TimeoutError' });
  await flush();
  await advance(t, 8_000);
  await rejected;
  assert.equal(calls[0].init?.signal?.aborted, true);
  mockFetch(async () => new Response('recovered text'));
  assert.equal((await requestText(SOURCE)).text, 'recovered text');
  let cancelled = 0;
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
  );
  await flush();
  assert.equal(cancelled, 1);
  assert.equal((await requestText(SOURCE)).text, 'recovered text');
  assert.equal(calls.length, 2);
});

test('a stalled provider body and stalled cancel settle by the same total upstream deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'));
    },
    cancel() {
      cancelled++;
      return never();
    },
  });
  mockFetch(async () => new Response(body));
  const rejected = assert.rejects(requestText(SOURCE), { name: 'TimeoutError' });
  await flush();
  await advance(t, 8_000);
  await rejected;
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  mockFetch(async () => new Response('recovered complete body'));
  assert.equal((await requestText(SOURCE)).text, 'recovered complete body');
  assert.equal(calls.length, 2);
});

test('invalid bodies reject promptly even if their cancellation never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  mockFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0xc3, 0x28]));
          },
          cancel() {
            cancelled++;
            return never();
          },
        }),
      ),
  );
  let settled = false;
  const rejected = assert.rejects(requestText(SOURCE), /encoded data|encoding/i).then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, true, 'validation must not wait for its cleanup or timeout');
  await rejected;
  assert.equal(cancelled, 1);
  assert.equal(calls.length, 1, 'invalid content is never retried');
});

test('transient network failures and retryable statuses get one bounded recovery attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const failure of [new TypeError('connection reset'), 408, 500, 502, 503, 504]) {
    clearWarningCache();
    const before: number = calls.length;
    mockFetch(async () => {
      if (calls.length === before + 1) {
        if (failure instanceof Error) throw failure;
        return new Response('temporary upstream error', { status: failure });
      }
      return new Response('recovered bulletin');
    });
    const result = requestText(SOURCE);
    await flush();
    assert.equal(calls.length, before + 1);
    await advance(t, 150);
    assert.equal((await result).text, 'recovered bulletin');
    assert.equal(calls.length, before + 2);
  }
});

test('retry shares the original eight-second budget instead of starting a new deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  mockFetch(async () => {
    if (calls.length === 1) return new Response('temporary', { status: 503 });
    return never();
  });
  const rejected = assert.rejects(requestText(SOURCE), { name: 'TimeoutError' });
  await flush();
  await advance(t, 150);
  assert.equal(calls.length, 2);
  await advance(t, 7_849);
  assert.equal(calls[1].init?.signal?.aborted, false);
  await advance(t, 1);
  await rejected;
  assert.equal(calls[1].init?.signal?.aborted, true);
});

test('Retry-After is respected when affordable and never retried early when outside the budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const format of ['seconds', 'date']) {
    const value = format === 'seconds' ? '2' : new Date(now + 2_000).toUTCString();
    clearWarningCache();
    const before: number = calls.length;
    mockFetch(async () =>
      calls.length === before + 1
        ? new Response('temporary', { status: 503, headers: { 'Retry-After': value } })
        : new Response('recovered after server delay'),
    );
    const result = requestText(SOURCE);
    await flush();
    await advance(t, 1_999);
    assert.equal(calls.length, before + 1);
    await advance(t, 1);
    assert.equal((await result).text, 'recovered after server delay');
    assert.equal(calls.length, before + 2);
  }
  clearWarningCache();
  const before: number = calls.length;
  mockFetch(async () => new Response('busy', { status: 503, headers: { 'Retry-After': '60' } }));
  await assert.rejects(requestText(SOURCE), /HTTP 503/);
  assert.equal(calls.length, before + 1);
});

test('persistent failures retry at most once and redirects or authorization errors never retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  mockFetch(async () => new Response('temporary', { status: 503 }));
  const rejected = assert.rejects(requestText(SOURCE), /HTTP 503/);
  await flush();
  await advance(t, 150);
  await rejected;
  assert.equal(calls.length, 2);
  for (const status of [301, 302, 400, 401, 403, 404, 429]) {
    const before: number = calls.length;
    mockFetch(async () => new Response('unavailable', { status }));
    await assert.rejects(requestText(SOURCE), new RegExp(`HTTP ${status}`));
    assert.equal(calls.length, before + 1);
  }
});

test('a fresh cached copy is served while upstream reads are at capacity', async () => {
  mockFetch(async () => new Response('cached warning feed'));
  await requestText(SOURCE);
  const release: Array<() => void> = [];
  mockFetch(
    () => new Promise<Response>((resolve) => release.push(() => resolve(new Response('late')))),
  );
  const busy = Array.from({ length: 32 }, (_, i) =>
    requestText(`https://severeweather.wmo.int/f/ows/busy_${i}.json`),
  );
  await assert.rejects(
    requestText('https://severeweather.wmo.int/f/ows/busy_32.json'),
    /Warning service busy/,
  );
  assert.equal((await requestText(SOURCE)).text, 'cached warning feed');
  while (release.length < 32) await Promise.resolve();
  for (const resolve of release) resolve();
  await Promise.all(busy);
  assert.equal(calls.length, 33);
});

test('a body read on in its declared encoding still settles by the upstream deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Not valid UTF-8 but declared ISO-8859-1, so the read goes on; the transfer then stalls.
      controller.enqueue(LATIN1_CAP);
    },
    cancel() {
      cancelled++;
      return never();
    },
  });
  mockFetch(async () => new Response(body));
  const rejected = assert.rejects(requestText(SOURCE), { name: 'TimeoutError' });
  await flush();
  await advance(t, 7_999);
  assert.equal(cancelled, 0);
  await advance(t, 1);
  await rejected;
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  // The stalled read holds no shared slot: the next request reads the complete document.
  mockFetch(async () => new Response(LATIN1_CAP));
  assert.equal((await requestText(SOURCE)).text, LATIN1_TEXT);
  assert.equal(calls.length, 2);
});
