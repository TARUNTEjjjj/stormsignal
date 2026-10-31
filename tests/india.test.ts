import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchIndiaAlerts, indiaRegion, INDIA_REGIONS } from '../server/india';
import type { Place } from '../src/types';
import type { TextOptions } from '../server/http';

const NOW = Date.UTC(2026, 10, 1, 1);
const place: Place = {
  id: '1275339',
  name: 'Mumbai',
  latitude: 19.07283,
  longitude: 72.88261,
  country: 'India',
  countryCode: 'IN',
  admin: 'Maharashtra',
  timezone: 'Asia/Kolkata',
};
const link = (id: number) =>
  `https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${id}`;
const feed = (links = [link(1)], date = 'Sun, 01 Nov 2026 00:00:00 GMT') =>
  `<rss><channel><pubDate>${date}</pubDate>${links.map((url) => `<item><link>${url.replace(/&/g, '&amp;')}</link><pubDate>${date}</pubDate></item>`).join('')}</channel></rss>`;
const cap = (id = 1, type = 'Alert', reference = '') =>
  `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>fixture-${id}</identifier><sender>IMD-fixture</sender><sent>2026-11-01T00:00:00Z</sent><status>Actual</status><msgType>${type}</msgType><scope>Public</scope>${reference ? `<references>${reference}</references>` : ''}${type === 'Cancel' ? '' : '<info><language>en-IN</language><category>Met</category><event>Fixture heavy rain</event><urgency>Expected</urgency><severity>Severe</severity><certainty>Likely</certainty><effective>2026-11-01T00:00:00Z</effective><expires>2026-11-01T03:00:00Z</expires><headline>Fixture warning for Raigad</headline><instruction>Original fixture instructions.</instruction><area><areaDesc>Raigad district of Maharashtra</areaDesc></area></info>'}</alert>`;
const request =
  (rss = feed(), documents: Record<string, string | Error> = { [link(1)]: cap() }) =>
  async (url: string, _options?: TextOptions) => {
    if (url.includes('/rss/')) return { text: rss, fetchedAt: NOW };
    const text = documents[url];
    if (text instanceof Error) throw text;
    if (!text) throw new Error('Unexpected request');
    return { text, fetchedAt: NOW };
  };

test('India state mapping is fixed, supports all 36 published entries and priority regions', () => {
  assert.equal(INDIA_REGIONS.length, 36);
  for (const [name, slug] of INDIA_REGIONS)
    assert.equal(
      indiaRegion({ ...place, admin: name })?.url,
      `https://sachet.ndma.gov.in/cap_public_website/rss/rss_${slug}.xml`,
    );
  assert.equal(indiaRegion({ ...place, admin: 'Odisha' })?.name, 'Odisha');
  assert.equal(indiaRegion({ ...place, admin: 'Tamil Nadu' })?.name, 'Tamil Nadu');
  assert.equal(indiaRegion({ ...place, admin: 'Orissa' })?.name, 'Odisha');
  assert.equal(indiaRegion({ ...place, admin: 'https://evil.example' }), null);
  assert.equal(indiaRegion({ ...place, countryCode: 'US' }), null);
});

test('India warning response is explicitly regional and partial, with original area and source times', async () => {
  const result = await fetchIndiaAlerts(place, { now: NOW, request: request() });
  assert.equal(result.status, 'available');
  assert.equal(result.scope, 'region');
  assert.equal(result.scopeLabel, 'Maharashtra');
  assert.equal(result.partial, true);
  assert.equal(result.feedUpdatedAt, NOW - 3_600_000);
  assert.equal(result.alerts[0].area, 'Raigad district of Maharashtra');
  assert.equal(result.alerts[0].instruction, 'Original fixture instructions.');
  assert.equal(result.alerts[0].url, link(1));
  assert.equal(result.alerts[0].geometry, null);
  assert.match(result.coverage, /not automatically to Mumbai/);
  assert.match(result.coverage, /not establish local coverage or an all-clear/);
});

test('old readable feed is historical coverage, not a fabricated current heartbeat or live warning', async () => {
  const result = await fetchIndiaAlerts(
    { ...place, name: 'Chennai', admin: 'Tamil Nadu' },
    {
      now: NOW,
      request: request(feed([link(1)], 'Mon, 26 Oct 2026 00:00:00 GMT'), {
        [link(1)]: cap().replaceAll('2026-11-01', '2026-10-26'),
      }),
    },
  );
  assert.equal(result.alerts.length, 0);
  assert.equal(result.feedUpdatedAt, Date.UTC(2026, 9, 26));
  assert.match(result.coverage, /Latest bulletin in this feed: 2026-10-26/);
  assert.match(result.coverage, /Current regional coverage is unverified/);
  assert.equal(result.partial, true);
});

test('unknown region avoids requests and missing publication time remains explicitly unverified', async () => {
  const unknown = await fetchIndiaAlerts(
    { ...place, admin: undefined },
    {
      now: NOW,
      request: async () => {
        throw new Error('must not fetch');
      },
    },
  );
  assert.equal(unknown.status, 'unsupported');
  const empty = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request('<rss><channel><title>Empty</title></channel></rss>'),
  });
  assert.equal(empty.feedUpdatedAt, null);
  assert.match(empty.coverage, /No bulletin publication time/);
  assert.equal(empty.partial, true);
});

test('future feed dates, all failed details and arbitrary-host links cannot become available', async () => {
  await assert.rejects(
    fetchIndiaAlerts(place, {
      now: NOW,
      request: request(feed([], 'Mon, 02 Nov 2026 00:00:00 GMT')),
    }),
    /future/,
  );
  await assert.rejects(
    fetchIndiaAlerts(place, {
      now: NOW,
      request: request(feed(), { [link(1)]: new Error('upstream') }),
    }),
    /could not be verified/,
  );
  let calls = 0;
  await assert.rejects(
    fetchIndiaAlerts(place, {
      now: NOW,
      request: async () => {
        calls++;
        return { text: feed(['https://evil.example/secret']), fetchedAt: NOW };
      },
    }),
    /could not be verified/,
  );
  assert.equal(calls, 1);
});

test('partially failed details keep verified entries with an explicit missing-detail count', async () => {
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed([link(1), link(2)]), {
      [link(1)]: cap(),
      [link(2)]: new Error('network failed'),
    }),
  });
  assert.equal(result.alerts.length, 1);
  assert.match(result.coverage, /1 warning detail request/);
});

test('cancellation metadata removes referenced original from the regional result', async () => {
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed([link(1), link(2)]), {
      [link(1)]: cap(),
      [link(2)]: cap(2, 'Cancel', 'IMD-fixture,fixture-1,2026-11-01T00:00:00Z'),
    }),
  });
  assert.deepEqual(result.alerts, []);
  assert.equal(result.partial, true);
});

test('missing CAP expiry is not invented and omitted validity is explained', async () => {
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed(), {
      [link(1)]: cap().replace('<expires>2026-11-01T03:00:00Z</expires>', ''),
    }),
  });
  assert.deepEqual(result.alerts, []);
  assert.match(result.coverage, /no stated expiry/);
});

test('multiple English info blocks remain separate while duplicate translated copies are not repeated', async () => {
  const source = cap();
  const first = /<info>[\s\S]*<\/info>/.exec(source)![0];
  const second = first.replace('Raigad district', 'Another district');
  const translated = first.replace('en-IN', 'mr-IN');
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed(), { [link(1)]: source.replace(first, first + second + translated) }),
  });
  assert.equal(result.alerts.length, 2);
  assert.equal(new Set(result.alerts.map((a) => a.id)).size, 2);
  assert.deepEqual(
    result.alerts.map((a) => a.area),
    ['Raigad district of Maharashtra', 'Another district of Maharashtra'],
  );
});

test('India detail requests cap at ten with no more than four concurrent requests', async () => {
  let count = 0,
    simultaneous = 0,
    maxSimultaneous = 0;
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: async (url) => {
      if (url.includes('/rss/'))
        return { text: feed(Array.from({ length: 12 }, (_, i) => link(i + 1))), fetchedAt: NOW };
      count++;
      simultaneous++;
      maxSimultaneous = Math.max(simultaneous, maxSimultaneous);
      await new Promise((resolve) => setTimeout(resolve, 2));
      simultaneous--;
      return { text: cap(Number(new URL(url).searchParams.get('identifier'))), fetchedAt: NOW };
    },
  });
  assert.equal(count, 10);
  assert.equal(maxSimultaneous, 4);
  assert.equal(result.alerts.length, 10);
  assert.match(result.coverage, /Additional feed entries were not checked/);
});

test('caller cancellation propagates instead of returning an available empty list', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    fetchIndiaAlerts(place, { now: NOW, signal: controller.signal, request: request() }),
    /cancelled/,
  );
});
