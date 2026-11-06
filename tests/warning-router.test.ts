import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { alertPlace, handleAlerts } from '../server/router';
import { clearWarningCache } from '../server/http';

/** Upstream IMD and SACHET feeds for Kolkata; SACHET answers each read after a delay. */
function kolkataUpstream(rssMs: number, detailMs: number): typeof fetch {
  const now = Date.now();
  const ist = (t: number) => new Date(t + 330 * 60_000).toISOString().slice(0, 19) + '+5:30';
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const imd = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>IMD WARNING</title><item><title>KOLKATA</title><guid>kol-1</guid><sent>${ist(now - 60_000)}</sent><Onset>${ist(now - 120_000)}</Onset><Expires>${ist(now + 3_600_000)}</Expires><category>NOWCAST</category><description>Moderate thunderstorm with lightning</description></item></channel></rss>`;
  const link = (id: number) =>
    `https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${id}`;
  const published = new Date(now - 600_000).toUTCString();
  const sachet = `<rss><channel><pubDate>${published}</pubDate>${Array.from({ length: 10 }, (_, i) => `<item><link>${link(i + 1)}</link><pubDate>${published}</pubDate></item>`).join('')}</channel></rss>`;
  const cap = (id: string) =>
    `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>wb-${id}</identifier><sender>IMD-fixture</sender><sent>${iso(now - 600_000)}</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><language>en-IN</language><category>Met</category><event>Thunderstorm</event><urgency>Expected</urgency><severity>Moderate</severity><certainty>Likely</certainty><effective>${iso(now - 600_000)}</effective><expires>${iso(now + 3 * 3_600_000)}</expires><headline>West Bengal bulletin ${id}</headline><instruction>Stay indoors.</instruction><area><areaDesc>Darjeeling district</areaDesc></area></info></alert>`;
  const wait = (ms: number, signal?: AbortSignal | null) =>
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
  return async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://mausam.imd.gov.in/')) return new Response(imd);
    if (url.includes('/rss/rss_west.xml')) {
      await wait(rssMs, init?.signal);
      return new Response(sachet);
    }
    if (url.includes('/FetchXMLFile?')) {
      await wait(detailMs, init?.signal);
      return new Response(cap(new URL(url).searchParams.get('identifier')!));
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  };
}

/** Run one Kolkata gateway request on mocked timers, so 18 seconds pass instantly. */
async function kolkataGateway(t: TestContext, upstream: typeof fetch) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = upstream;
  clearWarningCache();
  try {
    let response: Response | undefined;
    const pending = handleAlerts(
      new Request(
        'https://stormsignal.invalid/api/alerts?lat=22.5626&lon=88.3630&country=IN&admin=West%20Bengal&name=Kolkata',
      ),
    ).then((value) => (response = value));
    let elapsed = 0;
    while (!response && elapsed < 30_000) {
      t.mock.timers.tick(250);
      elapsed += 250;
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    await pending;
    return { status: response!.status, elapsed, body: await response!.json() };
  } finally {
    globalThis.fetch = originalFetch;
    clearWarningCache();
  }
}
test('warning route validates location inputs without making upstream requests', async () => {
  for (const query of [
    '',
    'lat=&lon=0',
    'lat=NaN&lon=0',
    'lat=91&lon=0',
    'lat=0&lon=-181',
    'lat=0&lon=0&country=XXX',
    'lat=0&lon=0&url=https://evil.example',
    'lat=0&lat=1&lon=0',
    `lat=0&lon=0&admin=${'x'.repeat(101)}`,
  ]) {
    const result = await handleAlerts(
      new Request(`https://stormsignal.invalid/api/alerts?${query}`),
    );
    assert.equal(result.status, 400, query);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(
      (await result.json()).reason,
      'Choose a valid location to check official warnings.',
      query,
    );
  }
});
test('warning route allows only reads and preserves bounded region metadata', async () => {
  assert.equal(
    (await handleAlerts(new Request('https://stormsignal.invalid/api/alerts', { method: 'POST' })))
      .status,
    405,
  );
  const place = alertPlace(
    new URL(
      'https://stormsignal.invalid/api/alerts?lat=20.2724&lon=85.8339&country=IN&admin=Odisha&name=Bhubaneswar',
    ),
  );
  assert.equal(place.admin, 'Odisha');
  assert.equal(place.latitude, 20.2724);
});

test('country-less map and GPS points are input limitations, not provider outages', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw Error('No upstream should be contacted');
  };
  try {
    for (const country of ['', '&country=']) {
      const response = await handleAlerts(
        new Request(`https://stormsignal.invalid/api/alerts?lat=13.08&lon=80.27${country}`),
      );
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const result = await response.json();
      assert.equal(result.error, true);
      assert.match(result.reason, /Choose a city.*No warning source was checked/);
      assert.equal(result.status, undefined); // Neither an all-clear nor "unsupported".
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a slow SACHET feed cannot discard the verified IMD Kolkata nowcast at the gateway deadline', async (t) => {
  // Each SACHET read finishes within http.ts's 8-second limit, but the feed plus three
  // batches of detail reads take 19 seconds, longer than the gateway's 18-second deadline.
  const { status, elapsed, body } = await kolkataGateway(t, kolkataUpstream(4_000, 5_000));
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(elapsed < 18_000, `answered after ${elapsed} ms`);
  assert.deepEqual(
    body.alerts.map((alert: { id: string }) => alert.id),
    ['imd-kolkata:kol-1'],
  );
  assert.deepEqual(
    body.checks.map((check: { id: string; status: string }) => `${check.id}:${check.status}`),
    ['imd-kolkata:available', 'sachet:unavailable'],
  );
  assert.match(body.coverage, /1 of 2 sources could not be verified/);
});

test('a slow SACHET feed that finishes within the source deadline is still included', async (t) => {
  const { status, body } = await kolkataGateway(t, kolkataUpstream(3_000, 4_500));
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.checks.map((check: { id: string; status: string }) => `${check.id}:${check.status}`),
    ['imd-kolkata:available', 'sachet:available'],
  );
  assert.equal(body.alerts.length, 11);
});
