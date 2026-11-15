import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { alertPlace, handleAlerts } from '../server/router';
import { clearWarningCache } from '../server/http';
import { alertCheckIsRecent, unexpiredAlerts } from '../src/connectivity';
import { clearRequestCache, fetchAlerts } from '../src/data';
import { briefingText, createBriefing, loadBriefings, saveBriefing } from '../src/offline';

/** Upstream IMD feed and SACHET state feeds; SACHET answers each read after a delay. */
function sachetUpstream(rssMs: number, detailMs: number): typeof fetch {
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
    if (/\/rss\/rss_[a-z]+\.xml$/.test(url)) {
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

/** Run one gateway request on mocked timers, so 18 seconds pass instantly. */
async function gateway(t: TestContext, upstream: typeof fetch, query: string) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = upstream;
  clearWarningCache();
  try {
    let response: Response | undefined;
    const pending = handleAlerts(
      new Request(`https://stormsignal.invalid/api/alerts?${query}`),
    ).then((value) => (response = value));
    let elapsed = 0;
    for (;;) {
      // Let pending work run before time advances, so each read starts when its turn comes
      // rather than one tick late against deadlines that were set at once.
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
      if (response || elapsed >= 30_000) break;
      t.mock.timers.tick(250);
      elapsed += 250;
    }
    await pending;
    return { status: response!.status, elapsed, body: await response!.json() };
  } finally {
    globalThis.fetch = originalFetch;
    clearWarningCache();
  }
}
const kolkataGateway = (t: TestContext, upstream: typeof fetch) =>
  gateway(t, upstream, 'lat=22.5626&lon=88.3630&country=IN&admin=West%20Bengal&name=Kolkata');
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

test('a slow SACHET feed cannot discard the verified IMD Kolkata nowcast or its own verified bulletins', async (t) => {
  // Each SACHET read finishes within http.ts's 8-second limit, but the feed plus three
  // batches of detail reads take 19 seconds, longer than the gateway's 18-second deadline.
  const { status, elapsed, body } = await kolkataGateway(t, sachetUpstream(4_000, 5_000));
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(elapsed < 17_000, `answered after ${elapsed} ms`);
  // SACHET stops at its own deadline and keeps the eight bulletins verified by then.
  assert.deepEqual(body.alerts.map((alert: { id: string }) => alert.id).sort(), [
    'imd-kolkata:kol-1',
    ...Array.from({ length: 8 }, (_, i) => `sachet:wb-${i + 1}:0`),
  ]);
  assert.deepEqual(
    body.checks.map((check: { id: string; status: string }) => `${check.id}:${check.status}`),
    ['imd-kolkata:available', 'sachet:available'],
  );
  assert.match(body.checks[1].coverage, /2 warning detail request\(s\) could not be verified/);
});

test('a slow SACHET feed that finishes within the source deadline is still included', async (t) => {
  const { status, body } = await kolkataGateway(t, sachetUpstream(3_000, 4_500));
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.checks.map((check: { id: string; status: string }) => `${check.id}:${check.status}`),
    ['imd-kolkata:available', 'sachet:available'],
  );
  assert.equal(body.alerts.length, 11);
});

test('a slow SACHET feed keeps the bulletins verified before the India check deadline', async (t) => {
  // Chennai is checked by the India route alone. The feed plus three rounds of detail reads (four
  // at a time) take 19 seconds; the check stops at its own 17-second deadline instead of the
  // gateway's 18 seconds.
  const { status, elapsed, body } = await gateway(
    t,
    sachetUpstream(4_000, 5_000),
    'lat=13.0827&lon=80.2707&country=IN&admin=Tamil%20Nadu&name=Chennai',
  );
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(elapsed < 18_000, `answered after ${elapsed} ms`);
  assert.equal(body.scopeLabel, 'Tamil Nadu');
  assert.deepEqual(
    body.alerts.map((alert: { id: string }) => alert.id).sort(),
    Array.from({ length: 8 }, (_, i) => `sachet:wb-${i + 1}:0`),
  );
  assert.match(body.coverage, /2 warning detail request\(s\) could not be verified/);
});

test('the gateway states its clock, so a fast or slow device clock still shows current warnings', async () => {
  const gatewayClock = Date.now;
  const originalFetch = globalThis.fetch;
  const upstream = sachetUpstream(0, 0);
  let deviceClock = gatewayClock;
  let body: { fetchedAt: number; servedAt: number } | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('/api/alerts')) return upstream(input, init);
    // The gateway answers on its own clock; the browser reads the answer on the device's.
    Date.now = gatewayClock;
    try {
      const answer = await handleAlerts(new Request(`https://stormsignal.invalid${url}`));
      const text = await answer.text();
      body = JSON.parse(text);
      return new Response(text, { status: answer.status, headers: answer.headers });
    } finally {
      Date.now = deviceClock;
    }
  };
  clearWarningCache();
  try {
    for (const skew of [125_000, -75_000]) {
      clearRequestCache();
      deviceClock = () => gatewayClock() + skew;
      Date.now = deviceClock;
      const result = await fetchAlerts({
        id: 'chennai',
        name: 'Chennai',
        country: 'India',
        countryCode: 'IN',
        admin: 'Tamil Nadu',
        latitude: 13.0827,
        longitude: 80.2707,
      });
      assert.ok(body && body.fetchedAt <= body.servedAt && body.servedAt <= gatewayClock());
      assert.equal(result.status, 'available', `device clock ${skew} ms`);
      assert.equal(result.alerts.length, 10);
      // The read time is moved onto the device clock (plus the moments the answer took to arrive).
      assert.ok(Math.abs(result.fetchedAt - (body.fetchedAt + skew)) < 1_000);
      assert.equal(alertCheckIsRecent(result.fetchedAt, Date.now(), true), true);
    }
  } finally {
    Date.now = gatewayClock;
    globalThis.fetch = originalFetch;
    clearWarningCache();
    clearRequestCache();
  }
});

test('a device clock far ahead or behind lists the current warnings; a slow one can still save them', async () => {
  const gatewayClock = Date.now;
  const originalFetch = globalThis.fetch;
  // Ten West Bengal bulletins issued 10 minutes ago and valid for 3 more hours (gateway clock).
  const upstream = sachetUpstream(0, 0);
  let deviceClock = gatewayClock;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('/api/alerts')) return upstream(input, init);
    Date.now = gatewayClock;
    try {
      const answer = await handleAlerts(new Request(`https://stormsignal.invalid${url}`));
      return new Response(await answer.text(), { status: answer.status, headers: answer.headers });
    } finally {
      Date.now = deviceClock;
    }
  };
  const chennai = {
    id: 'chennai',
    name: 'Chennai',
    country: 'India',
    countryCode: 'IN',
    admin: 'Tamil Nadu',
    latitude: 13.0827,
    longitude: 80.2707,
  };
  clearWarningCache();
  try {
    // +4 h: every bulletin has less time left than the device is fast. -30 min: every bulletin was
    // issued "in the future" by the device's reading. +30 days: a clock set to the wrong month.
    for (const skew of [4 * 3_600_000, -30 * 60_000, 30 * 86_400_000, -45 * 60_000]) {
      clearRequestCache();
      deviceClock = () => gatewayClock() + skew;
      Date.now = deviceClock;
      const note = `device clock ${skew / 60_000} min`;
      const result = await fetchAlerts(chennai);
      assert.ok(Math.abs(result.clockOffset! - skew) < 1_000, note);
      assert.equal(alertCheckIsRecent(result.fetchedAt, Date.now(), true), true, note);
      // What the dashboard, the map and page notifications list.
      assert.equal(unexpiredAlerts(result, Date.now()).length, 10, note);
      // A saved briefing also needs a forecast whose model time is within two hours of the device
      // clock, so only the smaller differences can save one. The bulletins are then kept for offline
      // reading with their official times unchanged.
      if (Math.abs(skew) > 3_600_000) continue;
      const device = Date.now();
      const time = Math.floor(gatewayClock() / 1000) * 1000; // the model's own (true) time
      const reading = { time, temperature: 28, apparent: 30, precipitation: 0, probability: 10 };
      const hour = { ...reading, wind: 10, gust: 20, humidity: 70, code: 1, uv: 3 };
      const briefing = createBriefing(
        chennai,
        {
          fetchedAt: device,
          timezone: 'Asia/Kolkata',
          current: hour,
          hours: [hour, { ...hour, time: time + 3_600_000 }],
          days: [],
          source: 'Open-Meteo forecast',
        },
        result,
        device,
      );
      assert.equal(briefing.warnings.alerts.length, 5, note);
      assert.equal(briefing.warnings.omitted, 5, note);
      const disk = new Map<string, string>();
      const storage = {
        getItem: (key: string) => disk.get(key) ?? null,
        setItem: (key: string, value: string) => void disk.set(key, value),
        removeItem: (key: string) => void disk.delete(key),
      };
      assert.equal(saveBriefing(storage, briefing, device).error, null, note);
      assert.deepEqual(loadBriefings(storage, gatewayClock()).briefings, [briefing], note);
      assert.match(briefingText(briefing, device), /Stay indoors\./, note);
    }
  } finally {
    Date.now = gatewayClock;
    globalThis.fetch = originalFetch;
    clearWarningCache();
    clearRequestCache();
  }
});

test('a bulletin that takes effect later is disclosed with its time; merge metadata stays internal', async () => {
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const later = Math.floor((now + 6 * 3_600_000) / 1000) * 1000;
  const link = (id: number) =>
    `https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${id}`;
  const published = new Date(now - 600_000).toUTCString();
  const rss = `<rss><channel>${[1, 2].map((id) => `<item><link>${link(id)}</link><pubDate>${published}</pubDate></item>`).join('')}</channel></rss>`;
  const cap = (id: string) =>
    `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>tn-${id}</identifier><sender>IMD-fixture</sender><sent>${iso(now - 600_000)}</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><language>en-IN</language><category>Met</category><event>Heavy rain</event><urgency>Expected</urgency><severity>Moderate</severity><certainty>Likely</certainty><effective>${iso(id === '2' ? later : now - 600_000)}</effective><expires>${iso(now + 12 * 3_600_000)}</expires><headline>Tamil Nadu bulletin ${id}</headline><area><areaDesc>Chennai district</areaDesc></area></info></alert>`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    return new Response(
      url.includes('/FetchXMLFile?') ? cap(new URL(url).searchParams.get('identifier')!) : rss,
    );
  };
  clearWarningCache();
  try {
    const response = await handleAlerts(
      new Request(
        'https://stormsignal.invalid/api/alerts?lat=13.0827&lon=80.2707&country=IN&admin=Tamil%20Nadu&name=Chennai',
      ),
    );
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(
      body.alerts.map((alert: { id: string }) => alert.id),
      ['sachet:tn-1:0'],
    );
    assert.ok(
      body.coverage.includes(
        ` 1 regional bulletin(s) take effect later and are not listed as current warnings yet; the earliest takes effect at ${new Date(later).toISOString()}.`,
      ),
      body.coverage,
    );
    for (const internal of ['revokedCapKeys', 'upcomingDocuments', 'upcomingAt', 'excludedCapKeys'])
      assert.equal(internal in body, false, internal);
  } finally {
    globalThis.fetch = originalFetch;
    clearWarningCache();
  }
});

/** WMO SWIC upstream for Berlin: registry, a 2-second point query and six CAP documents. */
function berlinUpstream(detailMs: number): typeof fetch {
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const path = (i: number) => `de-dwd-en/2026/11/09/0${i}/00/W${i}.xml`;
  const registry = JSON.stringify({
    sources: [
      {
        source: {
          authorityCountry: 'de',
          sourceIsOfficial: true,
          capAlertFeedStatus: 'operating',
          sourceId: 'de-dwd-en',
          memID: '71',
          byLanguage: [{ code: 'en', name: 'DWD' }],
        },
      },
    ],
  });
  const index = JSON.stringify({
    type: 'FeatureCollection',
    features: [1, 2, 3, 4, 5, 6].map((i) => ({
      type: 'Feature',
      properties: { capurl: path(i), mem: '71', areadesc: `Berlin area ${i}`, gc: '' },
    })),
  });
  const cap = (id: string) =>
    `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>W${id}</identifier><sender>dwd@example.gov</sender><sent>${iso(now - 600_000)}</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><language>en</language><category>Met</category><event>Severe gale</event><urgency>Immediate</urgency><severity>Severe</severity><certainty>Observed</certainty><expires>${iso(now + 12 * 3_600_000)}</expires><headline>Official warning ${id}</headline><area><areaDesc>Berlin area ${id}</areaDesc><polygon>52,13 52,14 53,14 53,13 52,13</polygon></area></info></alert>`;
  const delay = (ms: number, signal?: AbortSignal | null) =>
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
    if (url.endsWith('/json/sources.json')) return new Response(registry);
    if (url.includes('/f/ows/')) {
      await delay(2_000, init?.signal);
      return new Response(index);
    }
    const id = /\/W(\d)\.xml$/.exec(url)?.[1];
    if (id) {
      await delay(detailMs, init?.signal);
      return new Response(cap(id));
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  };
}

test('the WMO check deadline keeps verified warnings and discloses the details not loaded', async (t) => {
  // Each detail read finishes within http.ts's 8-second limit, but the second three (one per
  // worker) are still running when the WMO check's own 16-second deadline passes.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = berlinUpstream(7_500);
  clearWarningCache();
  try {
    let response: Response | undefined;
    const pending = handleAlerts(
      new Request(
        'https://stormsignal.invalid/api/alerts?lat=52.52&lon=13.405&country=DE&name=Berlin',
      ),
    ).then((value) => (response = value));
    let elapsed = 0;
    while (!response && elapsed < 30_000) {
      t.mock.timers.tick(250);
      elapsed += 250;
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    await pending;
    const body = await response!.json();
    assert.equal(response!.status, 200, JSON.stringify(body));
    assert.ok(elapsed < 18_000, `answered after ${elapsed} ms`);
    assert.deepEqual(body.alerts.map((alert: { title: string }) => alert.title).sort(), [
      'Official warning 1',
      'Official warning 2',
      'Official warning 3',
    ]);
    assert.match(
      body.coverage,
      /Some warning details could not be loaded: 3 selected source document\(s\) could not be verified\./,
    );
    assert.match(body.coverage, /reached its time limit; verified original bulletins are retained/);
    assert.doesNotMatch(body.coverage, /were not checked/);
    // Internal merge metadata never reaches the public response.
    assert.equal('revokedCapKeys' in body, false);
    assert.equal('upcomingDocuments' in body, false);
  } finally {
    globalThis.fetch = originalFetch;
    clearWarningCache();
  }
});

test('one connection cannot take the shared upstream read capacity from other users', async () => {
  const registry = JSON.stringify({
    sources: [
      {
        source: {
          authorityCountry: 'au',
          sourceIsOfficial: true,
          capAlertFeedStatus: 'operating',
          sourceId: 'au-bom-en',
          memID: '29',
          byLanguage: [{ code: 'en', name: 'Bureau of Meteorology' }],
        },
      },
    ],
  });
  const release: Array<() => void> = [];
  let lookups = 0;
  const originalFetch = globalThis.fetch;
  // WMO point lookups wait until released, as when WMO is slow.
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/json/sources.json')) return new Response(registry);
    if (url.includes('/f/ows/')) {
      lookups++;
      return new Promise<Response>((resolve) =>
        release.push(() =>
          resolve(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }))),
        ),
      );
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  };
  clearWarningCache();
  const check = (address: string | null, latitude: number) =>
    handleAlerts(
      new Request(
        `https://stormsignal.invalid/api/alerts?lat=${latitude}&lon=151.2&country=AU&name=Sydney`,
        { headers: address ? { 'CF-Connecting-IP': address } : {} },
      ),
    );
  const started = async (count: number) => {
    for (let i = 0; i < 200 && lookups < count; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lookups, count);
  };
  const refused = async (response: Promise<Response>) => {
    const value = await response;
    assert.equal(value.status, 429);
    assert.equal(value.headers.get('Cache-Control'), 'no-store');
    assert.equal(value.headers.get('Retry-After'), '5');
    const { reason } = await value.json();
    // The person refused may only share an address with whoever sent the other checks.
    assert.match(reason, /^The warning service is busy, and other checks from your network/);
    assert.match(reason, /Retry shortly, or check the official authority/);
  };
  const finish = async () => {
    for (const resolve of release.splice(0)) resolve();
    for (const response of await Promise.all(running.splice(0))) assert.equal(response.status, 200);
  };
  const running: Promise<Response>[] = [];
  const points = (count: number, from: number) =>
    Array.from({ length: count }, (_, i) => from - i / 100);
  try {
    // People behind one shared address (carrier-grade NAT) check six different places while the
    // gateway is not busy: nobody is refused.
    running.push(...points(6, -20).map((latitude) => check('203.0.113.7', latitude)));
    await started(6);
    await finish();
    // A script sends forty distinct points at once. From the eighth running lookup the gateway
    // counts as busy and the allowance applies: eight run, the rest are refused before any
    // upstream read.
    const burst = points(40, -30).map((latitude) => check('198.51.100.9', latitude));
    running.push(...burst.slice(0, 8));
    await started(14);
    for (const extra of burst.slice(8)) await refused(extra);
    assert.equal(lookups, 14);
    // A repeat of a lookup that is running shares it.
    running.push(check('198.51.100.9', -30));
    // Other people are still served: each client has its own allowance of four while it is busy.
    running.push(...points(4, -40).map((latitude) => check('203.0.113.7', latitude)));
    await started(18);
    await refused(check('203.0.113.7', -41));
    // Without a client address (local development) clients cannot be told apart: no allowance.
    running.push(check(null, -42), check(null, -43));
    await started(20);
    await finish();
    // An IPv6 client is its /64 network, however the address is written.
    running.push(...points(8, -50).map((latitude) => check('192.0.2.1', latitude)));
    await started(28);
    running.push(...points(4, -51).map((latitude) => check('2001:db8:1:2::a', latitude)));
    await started(32);
    await refused(check('2001:0db8:0001:0002:0000:0000:0000:000b', -52));
    // Another /64 of the same /48 is another client, with its own allowance.
    running.push(check('2001:db8:1:3::a', -52));
    await started(33);
    await finish();
    // Changing address inside one /48 (a delegated home or server prefix) adds no allowance:
    // eight lookups run for the whole /48, and another network is still served.
    const rotating = points(40, -60).map((latitude, i) =>
      check(`2001:db8:7:${(i + 1).toString(16)}::1`, latitude),
    );
    running.push(...rotating.slice(0, 8));
    await started(41);
    for (const extra of rotating.slice(8)) await refused(extra);
    running.push(check('2001:db8:8:1::1', -61));
    await started(42);
    await finish();
    // Half of the read capacity in use also counts as busy, however few lookups hold it: here one
    // address without an allowance (local development) holds sixteen reads.
    running.push(...points(16, -65).map((latitude) => check(null, latitude)));
    await started(58);
    running.push(...points(4, -66).map((latitude) => check('192.0.2.77', latitude)));
    await started(62);
    await refused(check('192.0.2.77', -67));
    await finish();
    // Finished checks free the allowance, of the client and of its /48.
    running.push(...points(8, -70).map((latitude) => check('198.51.100.9', latitude)));
    await started(70);
    running.push(...points(4, -71).map((latitude) => check('2001:db8:7:1::1', latitude)));
    await started(74);
    await finish();
  } finally {
    for (const resolve of release) resolve();
    await Promise.allSettled(running);
    globalThis.fetch = originalFetch;
    clearWarningCache();
  }
});

test('a WMO-indexed warning in a declared non-UTF-8 encoding is shown, not dropped', async () => {
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const path = (i: number) => `ar-smn-es/2026/11/09/01/00/A${i}.xml`;
  const registry = JSON.stringify({
    sources: [
      {
        source: {
          authorityCountry: 'ar',
          sourceIsOfficial: true,
          capAlertFeedStatus: 'operating',
          sourceId: 'ar-smn-es',
          memID: '123',
          byLanguage: [{ code: 'es', name: 'SMN' }],
        },
      },
    ],
  });
  const cap = (i: number, encoding: string, area: string) =>
    `<?xml version="1.0" encoding="${encoding}"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>A${i}</identifier><sender>smn@example.gov</sender><sent>${iso(now - 600_000)}</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><language>es-AR</language><category>Met</category><event>Tormentas fuertes</event><urgency>Expected</urgency><severity>Severe</severity><certainty>Likely</certainty><expires>${iso(now + 3_600_000)}</expires><headline>Alerta por tormentas en ${area}</headline><area><areaDesc>${area}</areaDesc><polygon>-32,-65 -32,-63 -30,-63 -30,-65 -32,-65</polygon></area></info></alert>`;
  const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
  const utf16 = (text: string) => {
    const view = new DataView(new ArrayBuffer(2 + text.length * 2));
    view.setUint16(0, 0xfeff, true);
    for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
    return new Uint8Array(view.buffer);
  };
  const documents = new Map([
    [
      path(1),
      { body: latin1(cap(1, 'ISO-8859-1', 'Córdoba')), type: 'text/xml; charset=ISO-8859-1' },
    ],
    [path(2), { body: new TextEncoder().encode(cap(2, 'UTF-8', 'Río Cuarto')), type: 'text/xml' }],
    [path(3), { body: utf16(cap(3, 'UTF-16', 'Villa María')), type: 'application/xml' }],
  ]);
  const originalFetch = globalThis.fetch;
  try {
    // Alone, the ISO-8859-1 document turned the check into a 503. Beside UTF-8 and UTF-16
    // documents, it was dropped behind "Some warning details could not be loaded."
    for (const [paths, places] of [
      [[path(1)], ['Córdoba']],
      [
        [path(1), path(2), path(3)],
        ['Córdoba', 'Río Cuarto', 'Villa María'],
      ],
    ]) {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.endsWith('/json/sources.json')) return new Response(registry);
        if (url.includes('/f/ows/'))
          return new Response(
            JSON.stringify({
              type: 'FeatureCollection',
              features: paths.map((capurl) => ({
                type: 'Feature',
                properties: { capurl, mem: '123', areadesc: 'Córdoba', gc: '' },
              })),
            }),
          );
        const document = documents.get(url.split('/v2/cap-alerts/')[1]);
        if (document)
          return new Response(document.body, { headers: { 'Content-Type': document.type } });
        throw new Error(`Unexpected upstream request: ${url}`);
      };
      clearWarningCache();
      const response = await handleAlerts(
        new Request(
          'https://stormsignal.invalid/api/alerts?lat=-31.4167&lon=-64.1833&country=AR&name=Cordoba',
        ),
      );
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(
        body.alerts.map((alert: { title: string }) => alert.title).sort(),
        places.map((place) => `Alerta por tormentas en ${place}`),
      );
      assert.doesNotMatch(body.coverage, /could not be loaded/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    clearWarningCache();
  }
});
