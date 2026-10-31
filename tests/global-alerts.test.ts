import test from 'node:test';
import assert from 'node:assert/strict';
import { capPolygonContains, createGlobalAlertAdapter, globalPointUrl } from '../server/global';
import type { TextOptions } from '../server/http';
import type { Place } from '../src/types';

const now = Date.now();
const issued = new Date(now - 60_000).toISOString();
const future = new Date(now + 3_600_000).toISOString();
const expired = new Date(now - 10_000).toISOString();
const place: Place = {
  id: 'test',
  name: 'Test place',
  country: 'Australia',
  countryCode: 'AU',
  latitude: -29.7,
  longitude: 151.7,
};
const path = (id: number) => `au-bom-en/2026/10/31/20/30/${id}-abc.xml`;
const source = {
  source: {
    authorityCountry: 'au',
    sourceIsOfficial: true,
    capAlertFeedStatus: 'operating',
    sourceId: 'au-bom-en',
    memID: '185',
    byLanguage: [{ code: 'en', name: 'Bureau of Meteorology' }],
  },
};
const feature = (id: number, extra = {}) => ({
  type: 'Feature',
  properties: {
    capurl: path(id),
    mem: '185',
    areadesc: 'Test region',
    gc: 'ZONE1',
    sent: '2026-10-31T01:00:00Z',
    expires: '2026-10-31T01:01:00Z',
    ...extra,
  },
});
const area = (shape = '') =>
  `<area><areaDesc>Test region</areaDesc>${shape}<geocode><valueName>Area</valueName><value>ZONE1</value></geocode></area>`;
const info = (
  options: {
    language?: string;
    area?: string;
    headline?: string;
    expires?: string | null;
    web?: string;
  } = {},
) =>
  `<info><language>${options.language ?? 'en-AU'}</language><category>Met</category><event>Thunderstorm</event><urgency>Immediate</urgency><severity>Severe</severity><certainty>Observed</certainty><effective>${issued}</effective>${options.expires === null ? '' : `<expires>${options.expires ?? future}</expires>`}<senderName>Official Weather Bureau</senderName><headline>${options.headline ?? 'Thunderstorm warning'}</headline><description>Source description</description><instruction>Follow official directions.</instruction><web>${options.web ?? 'https://example.gov/warning'}</web>${options.area ?? area()}</info>`;
const cap = (
  id: number,
  options: {
    status?: string;
    type?: string;
    scope?: string;
    infos?: string;
    references?: string;
  } = {},
) =>
  `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>alert-${id}</identifier><sender>weather@example.gov</sender><sent>${issued}</sent><status>${options.status ?? 'Actual'}</status><msgType>${options.type ?? 'Alert'}</msgType><scope>${options.scope ?? 'Public'}</scope>${options.references ? `<references>${options.references}</references>` : ''}${options.infos ?? info()}</alert>`;
function harness(
  features: unknown[] = [feature(1)],
  documents = new Map([[path(1), cap(1)]]),
  sources: unknown[] = [source],
) {
  const calls: { url: string; options?: TextOptions }[] = [];
  let concurrent = 0,
    peak = 0;
  const request = async (url: string, options?: TextOptions) => {
    calls.push({ url, options });
    if (url.endsWith('/json/sources.json'))
      return { text: JSON.stringify({ sources }), fetchedAt: now - 10_000 };
    if (url.includes('/f/ows/'))
      return {
        text: JSON.stringify({
          type: 'FeatureCollection',
          features,
          numberMatched: features.length,
          timeStamp: new Date(now).toISOString(),
        }),
        fetchedAt: now,
      };
    const doc = documents.get(url.split('/v2/cap-alerts/')[1]);
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 1));
    concurrent--;
    if (!doc) throw Error('Source failed');
    return { text: doc, fetchedAt: now - 500 };
  };
  return { fetch: createGlobalAlertAdapter(request), calls, peak: () => peak };
}

test('SWIC query is fixed-origin, bounded and preserves longitude/latitude ordering', () => {
  const url = new URL(globalPointUrl(place));
  assert.equal(url.origin, 'https://severeweather.wmo.int');
  assert.equal(url.searchParams.get('maxFeatures'), '41');
  assert.match(url.searchParams.get('filter')!, /151\.700000,-29\.700000/);
  assert.doesNotMatch(url.searchParams.get('propertyName')!, /sent|expires/);
  assert.throws(() => globalPointUrl({ latitude: Number.NaN, longitude: 0 }));
  assert.throws(() => globalPointUrl({ latitude: 91, longitude: 0 }));
});

test('point matching handles boundaries and the antimeridian without opposite-world false matches', () => {
  const square = [
    [-1, -10],
    [-1, 10],
    [1, 10],
    [1, -10],
    [-1, -10],
  ];
  assert.equal(capPolygonContains(square, 0, 0), true);
  assert.equal(capPolygonContains(square, 1, 0), true);
  assert.equal(capPolygonContains(square, 2, 0), false);
  assert.equal(capPolygonContains(square, 0, 180), false);
  const dateline = [
    [-1, 179],
    [-1, -179],
    [1, -179],
    [1, 179],
    [-1, 179],
  ];
  assert.equal(capPolygonContains(dateline, 0, 180), true);
  assert.equal(capPolygonContains(dateline, 0, -180), true);
  assert.equal(capPolygonContains(dateline, 0, 0), false);
});

test('original CAP publisher timestamps override known incorrect WFS timestamps', async () => {
  const h = harness();
  const result = await h.fetch(place);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].sent, Date.parse(issued));
  assert.equal(result.alerts[0].expires, Date.parse(future));
  assert.equal(result.alerts[0].source, 'Official Weather Bureau');
  assert.equal(result.scope, 'point');
  assert.equal(result.partial, true);
  assert.equal(result.feedUpdatedAt, null);
  assert.equal(result.fetchedAt, now - 500);
  assert.match(result.coverage, /not an all-clear/);
});

test('unsupported countries return coverage limitation without querying a location', async () => {
  const h = harness();
  const result = await h.fetch({ ...place, countryCode: 'ZZ' });
  assert.equal(result.status, 'unsupported');
  assert.equal(h.calls.length, 1);
  assert.match(result.coverage, /Missing warnings never mean safe/);
});

test('polygon and circle geometry take precedence over matching area labels', async () => {
  const outside = info({ area: area('<polygon>0,0 0,1 1,1 1,0 0,0</polygon>') });
  const circle = info({ headline: 'Inside circle', area: area('<circle>-29.7,151.7 10</circle>') });
  const other = info({
    headline: 'Wrong district',
    area: area().replaceAll('Test region', 'Different region').replaceAll('ZONE1', 'ZONE2'),
  });
  const h = harness(
    [feature(1)],
    new Map([[path(1), cap(1, { infos: outside + circle + other })]]),
  );
  const result = await h.fetch(place);
  assert.deepEqual(
    result.alerts.map((alert) => alert.title),
    ['Inside circle'],
  );
});

test('preferred language retains exact issuer text and blocks executable web URLs', async () => {
  const infos =
    info({ language: 'fr', headline: 'French warning' }) +
    info({ headline: 'English warning', web: 'javascript:alert(1)' });
  const h = harness([feature(1)], new Map([[path(1), cap(1, { infos })]]));
  const result = await h.fetch(place);
  assert.deepEqual(
    result.alerts.map((alert) => alert.title),
    ['English warning'],
  );
  assert.match(result.alerts[0].url, /^https:\/\/severeweather\.wmo\.int\/v2\/cap-alerts\//);
});

test('test, private, expired and missing-expiry alerts never become current public warnings', async () => {
  const docs = new Map([
    [path(1), cap(1, { status: 'Test' })],
    [path(2), cap(2, { scope: 'Private' })],
    [path(3), cap(3, { infos: info({ expires: expired }) })],
    [path(4), cap(4, { infos: info({ expires: null }) })],
  ]);
  const result = await harness(
    [1, 2, 3, 4].map((id) => feature(id)),
    docs,
  ).fetch(place);
  assert.equal(result.alerts.length, 0);
  assert.equal(result.partial, true);
  assert.match(result.coverage, /without a verifiable expiry/);
});

test('cancellation references suppress originals rather than appearing as new warnings', async () => {
  const docs = new Map([
    [path(1), cap(1)],
    [
      path(2),
      cap(2, { type: 'Cancel', infos: '', references: `weather@example.gov,alert-1,${issued}` }),
    ],
  ]);
  const result = await harness([feature(1), feature(2)], docs).fetch(place);
  assert.equal(result.alerts.length, 0);
});

test('untrusted WFS paths cannot become fetch targets or bypass the source registry', async () => {
  const features = [
    feature(1, { capurl: 'https://attacker.example/cap.xml' }),
    feature(1, { capurl: '../secret.xml' }),
    feature(1, { capurl: 'au-bom-en/2026/10/31/20/30/%2e%2e.xml' }),
    feature(1, { mem: '999' }),
  ];
  const h = harness(features);
  const result = await h.fetch(place);
  assert.equal(result.alerts.length, 0);
  assert.equal(h.calls.length, 2);
});

test('duplicate features are deduplicated and work is capped at six documents / three simultaneous requests', async () => {
  const docs = new Map(Array.from({ length: 12 }, (_, index) => [path(index + 1), cap(index + 1)]));
  const h = harness(
    [feature(1), feature(1), ...Array.from({ length: 11 }, (_, index) => feature(index + 2))],
    docs,
  );
  const result = await h.fetch(place);
  assert.equal(result.alerts.length, 6);
  assert.equal(h.calls.length, 8);
  assert.equal(h.peak(), 3);
  assert.ok(h.calls.every((call) => call.options?.maxBytes && call.options.maxBytes <= 500_000));
});

test('partial detail failures are visible and total detail failure is an error', async () => {
  const result = await harness([feature(1), feature(2)]).fetch(place);
  assert.equal(result.alerts.length, 1);
  assert.match(result.coverage, /Some warning details could not be loaded/);
  await assert.rejects(harness([feature(2)]).fetch(place), /could not be verified/);
});

test('invalid source and WFS payloads cannot masquerade as an empty successful warning check', async () => {
  const malformed = createGlobalAlertAdapter(async () => ({ text: '{}', fetchedAt: now }));
  await assert.rejects(malformed(place), /registry is unavailable/);
  const h = createGlobalAlertAdapter(async (url) => ({
    text: url.endsWith('/sources.json') ? JSON.stringify({ sources: [source] }) : '{}',
    fetchedAt: now,
  }));
  await assert.rejects(h(place), /query is unavailable/);
});

test('source website does not replace the canonical archived WMO CAP link', async () => {
  const h = harness(
    [feature(1)],
    new Map([
      [path(1), cap(1, { infos: info({ web: 'https://www.bom.gov.au/australia/warnings' }) })],
    ]),
  );
  const result = await h.fetch(place);
  assert.equal(result.alerts[0].url, `https://severeweather.wmo.int/v2/cap-alerts/${path(1)}`);
  assert.equal(result.alerts[0].description, 'Source description');
  assert.equal(result.alerts[0].source, 'Official Weather Bureau');
});

test('future-effective and cancelled replacement documents cannot revive an old warning', async () => {
  const original = cap(1);
  const replacement = cap(2, {
    type: 'Update',
    references: `weather@example.gov,alert-1,${issued}`,
    infos: info({ expires: expired }),
  });
  const notYet = cap(3, {
    infos: info().replace(`<effective>${issued}</effective>`, `<effective>${future}</effective>`),
  });
  const result = await harness(
    [feature(1), feature(2), feature(3)],
    new Map([
      [path(1), original],
      [path(2), replacement],
      [path(3), notYet],
    ]),
  ).fetch(place);
  assert.equal(result.alerts.length, 0);
});

test('caller abort returns promptly even if a shared source request is pending', async () => {
  const controller = new AbortController();
  const pending = createGlobalAlertAdapter(() => new Promise(() => {}))(place, controller.signal);
  controller.abort(new Error('Location changed'));
  await assert.rejects(pending, /Location changed/);
});

const bmkgPath = 'id-inatews-id/2026/10/31/20/30/original.xml';
const bmkgEnglishPath = 'id-inatews-en/2026/10/31/20/30/english.xml';
const jakarta: Place = {
  id: 'Jakarta',
  name: 'Jakarta',
  country: 'Indonesia',
  countryCode: 'ID',
  latitude: -6.21462,
  longitude: 106.84513,
};
const bmkgSource = {
  source: {
    authorityCountry: 'id',
    sourceIsOfficial: true,
    capAlertFeedStatus: 'operating',
    sourceId: 'id-inatews-id',
    memID: '043',
    byLanguage: [
      { code: 'id', name: 'BMKG' },
      { code: 'en', name: 'BMKG' },
    ],
  },
};
const jakartaArea = area('<polygon>-7,106 -7,108 -5,108 -5,106 -7,106</polygon>');
const bmkgOriginal = cap(1, {
  infos: info({ language: 'id', headline: 'Hujan Lebat', area: jakartaArea }),
});
const bmkgEnglish = cap(1, {
  infos: info({ language: 'en', headline: 'Thunderstorm in Jakarta', area: jakartaArea }),
});
function bmkgHarness(
  english: string | null = bmkgEnglish,
  related = bmkgEnglishPath,
  original = bmkgOriginal,
) {
  const calls: string[] = [];
  const fetch = createGlobalAlertAdapter(async (url, options) => {
    calls.push(url);
    if (url.endsWith('/sources.json'))
      return { text: JSON.stringify({ sources: [bmkgSource] }), fetchedAt: now };
    if (url.includes('/f/ows/'))
      return {
        text: JSON.stringify({
          type: 'FeatureCollection',
          features: [feature(1, { capurl: bmkgPath, rlink: related, mem: '043' })],
        }),
        fetchedAt: now,
      };
    if (url.endsWith(bmkgPath)) return { text: original, fetchedAt: now };
    if (english === null) throw new Error('English unavailable');
    assert.equal(options?.maxBytes, 256_000);
    return { text: english, fetchedAt: now };
  });
  return { fetch, calls };
}

test('BMKG verified official English relation preserves identity, validity and Jakarta point geometry', async () => {
  const h = bmkgHarness();
  const result = await h.fetch(jakarta);
  assert.equal(result.source, 'BMKG via WMO SWIC');
  assert.equal(result.partial, true);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].title, 'Thunderstorm in Jakarta');
  assert.equal(
    result.alerts[0].url,
    `https://severeweather.wmo.int/v2/cap-alerts/${bmkgEnglishPath}`,
  );
  assert.equal(result.alerts[0].sent, Date.parse(issued));
  assert.equal(result.alerts[0].expires, Date.parse(future));
  assert.equal(h.calls.length, 4);
});

test('an unavailable, different or spatially altered language copy retains original warning', async () => {
  const altered = [
    null,
    bmkgEnglish.replace('alert-1', 'alert-2'),
    bmkgEnglish.replace('weather@example.gov', 'other@example.gov'),
    bmkgEnglish.replace(future, new Date(now + 7_200_000).toISOString()),
    bmkgEnglish.replace('Severe', 'Minor'),
    bmkgEnglish.replaceAll('-7,106 -7,108 -5,108 -5,106 -7,106', '0,0 0,1 1,1 1,0 0,0'),
    bmkgEnglish.replace('<status>Actual</status>', '<status>Test</status>'),
  ];
  for (const candidate of altered) {
    const result = await bmkgHarness(candidate).fetch(jakarta);
    assert.equal(result.alerts[0].title, 'Hujan Lebat');
    assert.equal(result.alerts[0].url, `https://severeweather.wmo.int/v2/cap-alerts/${bmkgPath}`);
  }
});

test('unrelated, cross-authority and arbitrary rlink paths are never fetched', async () => {
  for (const related of [
    'https://attacker.example/cap.xml',
    'au-bom-en/2026/10/31/20/30/english.xml',
    'id-inatews-en/2026/10/30/20/30/english.xml',
    'id-inatews-en/2026/10/31/20/30/../english.xml',
  ]) {
    const h = bmkgHarness(bmkgEnglish, related);
    const result = await h.fetch(jakarta);
    assert.equal(h.calls.length, 3);
    assert.equal(result.alerts[0].title, 'Hujan Lebat');
  }
});

test('a partial translation cannot drop an additional original affected area', async () => {
  const more = cap(1, {
    infos:
      info({ language: 'id', headline: 'Hujan Lebat', area: jakartaArea }) +
      info({
        language: 'id',
        headline: 'Additional warning',
        area: area('<circle>-6.21462,106.84513 10</circle>'),
      }),
  });
  const result = await bmkgHarness(bmkgEnglish, bmkgEnglishPath, more).fetch(jakarta);
  assert.deepEqual(
    result.alerts.map((a) => a.title),
    ['Hujan Lebat', 'Additional warning'],
  );
});

test('Manila names PAGASA while an empty indexed result remains explicitly incomplete', async () => {
  const source = {
    source: {
      authorityCountry: 'ph',
      sourceIsOfficial: true,
      capAlertFeedStatus: 'operating',
      sourceId: 'ph-pagasa-en',
      memID: '021',
      byLanguage: [{ code: 'en', name: 'PAGASA' }],
    },
  };
  const result = await harness([], new Map(), [source]).fetch({
    id: 'Manila',
    name: 'Manila',
    country: 'Philippines',
    countryCode: 'PH',
    latitude: 14.6042,
    longitude: 120.9822,
  });
  assert.equal(result.status, 'available');
  assert.equal(result.source, 'PAGASA via WMO SWIC');
  assert.equal(result.alerts.length, 0);
  assert.equal(result.partial, true);
  assert.match(result.coverage, /not an all-clear/);
});

test('Jakarta outside the original warning polygon never gains an English warning', async () => {
  const h = bmkgHarness(
    bmkgEnglish,
    bmkgEnglishPath,
    bmkgOriginal.replaceAll('-7,106 -7,108 -5,108 -5,106 -7,106', '0,0 0,1 1,1 1,0 0,0'),
  );
  const result = await h.fetch(jakarta);
  assert.equal(result.alerts.length, 0);
  assert.equal(h.calls.length, 3);
});

test('a stalled optional translation falls back promptly without hiding verified originals', async () => {
  const started = Date.now();
  const fetch = createGlobalAlertAdapter(async (url) => {
    if (url.endsWith('/sources.json'))
      return { text: JSON.stringify({ sources: [bmkgSource] }), fetchedAt: now };
    if (url.includes('/f/ows/'))
      return {
        text: JSON.stringify({
          type: 'FeatureCollection',
          features: [feature(1, { capurl: bmkgPath, rlink: bmkgEnglishPath, mem: '043' })],
        }),
        fetchedAt: now,
      };
    if (url.endsWith(bmkgPath)) return { text: bmkgOriginal, fetchedAt: now };
    return new Promise(() => {});
  });
  const result = await fetch(jakarta);
  assert.equal(result.alerts[0].title, 'Hujan Lebat');
  assert.ok(Date.now() - started < 3000);
});

test('caller cancellation during an optional translation still stops the location check', async () => {
  const controller = new AbortController();
  const fetch = createGlobalAlertAdapter(async (url) => {
    if (url.endsWith('/sources.json'))
      return { text: JSON.stringify({ sources: [bmkgSource] }), fetchedAt: now };
    if (url.includes('/f/ows/'))
      return {
        text: JSON.stringify({
          type: 'FeatureCollection',
          features: [feature(1, { capurl: bmkgPath, rlink: bmkgEnglishPath, mem: '043' })],
        }),
        fetchedAt: now,
      };
    if (url.endsWith(bmkgPath)) return { text: bmkgOriginal, fetchedAt: now };
    controller.abort(new Error('Location changed during translation'));
    return new Promise(() => {});
  });
  await assert.rejects(fetch(jakarta, controller.signal), /Location changed during translation/);
});

test('one language block cannot replace two distinct hazards with identical validity and boundaries', async () => {
  const original = cap(1, {
    infos:
      info({ language: 'id', headline: 'Hujan Lebat', area: jakartaArea }) +
      info({ language: 'id', headline: 'Flooding warning', area: jakartaArea })
        .replace('<event>Thunderstorm</event>', '<event>Flood</event>')
        .replace('Source description', 'Floodwater is affecting the same district.'),
  });
  const result = await bmkgHarness(bmkgEnglish, bmkgEnglishPath, original).fetch(jakarta);
  assert.deepEqual(
    result.alerts.map((alert) => alert.title),
    ['Hujan Lebat', 'Flooding warning'],
  );
  assert.deepEqual(
    result.alerts.map((alert) => alert.event),
    ['Thunderstorm', 'Flood'],
  );
  assert.ok(result.alerts.every((alert) => alert.url.endsWith(bmkgPath)));
});
