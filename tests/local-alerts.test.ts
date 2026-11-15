import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlobalAlertAdapter } from '../server/global';
import { createLocalAlertAdapter } from '../server/local-alerts';
import { createNationalAlertAdapter } from '../server/national';
import type { AlertResult, Place, WeatherAlert } from '../src/types';

const now = Date.now();
const jakarta: Place = {
  id: 'jakarta',
  name: 'Jakarta',
  country: 'Indonesia',
  countryCode: 'ID',
  admin: 'Jakarta Special Capital Region',
  latitude: -6.21462,
  longitude: 106.84513,
};
const kolkata: Place = {
  id: 'kolkata',
  name: 'Kolkata',
  country: 'India',
  countryCode: 'IN',
  admin: 'West Bengal',
  latitude: 22.56263,
  longitude: 88.36304,
};
const warning = (id: string, extra: Partial<WeatherAlert> = {}): WeatherAlert => ({
  id,
  title: `Source warning ${id}`,
  event: 'Thunderstorm',
  severity: 'Moderate',
  area: 'Source area',
  sent: now - 60_000,
  effective: now - 60_000,
  expires: now + 3_600_000,
  description: 'Official description',
  instruction: 'Official instructions',
  source: 'BMKG',
  url: 'https://www.bmkg.go.id/alerts/nowcast/en/ABC_alert.xml',
  geometry: null,
  ...extra,
});
type Result = AlertResult & {
  excludedCapKeys?: string[];
  revokedCapKeys?: string[];
  upcomingDocuments?: number;
  upcomingAt?: number;
};
const result = (alerts: WeatherAlert[] = [], extra: Partial<Result> = {}): Result => ({
  status: 'available',
  alerts,
  fetchedAt: now - 5_000,
  source: 'Direct source',
  coverage: 'Limited source history.',
  officialUrl: 'https://www.bmkg.go.id/peringatan-dini',
  scope: 'point',
  scopeLabel: 'Jakarta',
  partial: true,
  ...extra,
});
const unavailable = async (): Promise<Result> => {
  throw new Error('Upstream timeout');
};
function adapter(
  national: Result | (() => Promise<Result>),
  global: Result | (() => Promise<Result>),
) {
  return createLocalAlertAdapter({
    national: typeof national === 'function' ? national : async () => national,
    global: typeof global === 'function' ? global : async () => global,
    kolkata: unavailable,
    india: unavailable,
  });
}

test('direct CAP text wins over indexed copies while independent WMO warnings remain', async () => {
  const direct = warning('issuer/original/0', { title: 'Original authority text' });
  const value = await adapter(
    result([direct], { excludedCapKeys: ['issuer/original/'] }),
    result(
      [warning('issuer/original/0', { title: 'Older indexed text' }), warning('issuer/extra/0')],
      { fetchedAt: now - 20_000 },
    ),
  )(jakarta);
  assert.equal(value.alerts.length, 2);
  assert.equal(value.alerts.find((a) => a.id === direct.id)?.title, 'Original authority text');
  assert.equal(value.fetchedAt, now - 20_000);
  assert.equal(value.partial, true);
  assert.deepEqual(
    value.checks?.map((c) => c.status),
    ['available', 'available'],
  );
  assert.match(value.coverage, /not an all-clear/);
  assert.equal('excludedCapKeys' in value, false);
});

test('a direct cancellation, expired record or nonmatching area cannot be revived by WMO', async () => {
  const value = await adapter(
    result([], { excludedCapKeys: ['issuer/cancelled/', 'issuer/expired/', 'issuer/outside/'] }),
    result(['cancelled', 'expired', 'outside', 'retained'].map((id) => warning(`issuer/${id}/0`))),
  )(jakarta);
  assert.deepEqual(
    value.alerts.map((a) => a.id),
    ['issuer/retained/0'],
  );
});

test('a WMO match for a direct document without point geometry stays visible while both sources answer', async () => {
  const manila: Place = {
    id: 'manila',
    name: 'Manila',
    country: 'Philippines',
    countryCode: 'PH',
    latitude: 14.6042,
    longitude: 120.9822,
  };
  const sent = new Date(now - 60_000).toISOString();
  const expires = new Date(now + 3_600_000).toISOString();
  const cap = (id: string, area: string) =>
    `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>${id}</identifier><sender>pagasa@example.gov.ph</sender><sent>${sent}</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><language>en</language><category>Met</category><event>Wind warning</event><urgency>Immediate</urgency><severity>Severe</severity><certainty>Likely</certainty><effective>${sent}</effective><expires>${expires}</expires><senderName>PAGASA</senderName><headline>Warning ${id}</headline><description>Official description.</description><instruction>Official instruction.</instruction><area><areaDesc>Metro Manila</areaDesc>${area}</area></info></alert>`;
  const documents = [
    // Geocode only: the direct check cannot evaluate it; WMO matches it by geocode.
    {
      id: 'TCWS-1',
      area: '<geocode><valueName>PSGC</valueName><value>1300000000</value></geocode>',
    },
    // Polygon containing Manila: both match it, and the direct copy wins.
    { id: 'POLY-IN', area: '<polygon>14,120 14,122 16,122 16,120 14,120</polygon>' },
  ].map((document, i) => ({
    ...document,
    xml: cap(document.id, document.area),
    direct: `https://publicalert.pagasa.dost.gov.ph/output/wcp/00000000-0000-4000-8000-00000000000${i + 1}.cap`,
    indexed: `ph-pagasa-en/2026/11/09/01/00/${document.id}.xml`,
  }));
  const national = createNationalAlertAdapter(async (url) => {
    if (url.endsWith('/feeds/'))
      return {
        text: `<feed xmlns="http://www.w3.org/2005/Atom"><updated>${sent}</updated>${documents.map((d) => `<entry><updated>${sent}</updated><link type="application/cap+xml" href="${d.direct}"/></entry>`).join('')}</feed>`,
        fetchedAt: now - 1_000,
      };
    const document = documents.find((d) => d.direct === url);
    if (!document) throw new Error(`Unexpected direct request: ${url}`);
    return { text: document.xml, fetchedAt: now - 500 };
  });
  const global = createGlobalAlertAdapter(async (url) => {
    if (url.endsWith('/json/sources.json'))
      return {
        text: JSON.stringify({
          sources: [
            {
              source: {
                authorityCountry: 'ph',
                sourceIsOfficial: true,
                capAlertFeedStatus: 'operating',
                sourceId: 'ph-pagasa-en',
                memID: '127',
                byLanguage: [{ code: 'en', name: 'PAGASA' }],
              },
            },
          ],
        }),
        fetchedAt: now - 10_000,
      };
    if (url.includes('/f/ows/'))
      return {
        text: JSON.stringify({
          type: 'FeatureCollection',
          features: documents.map((d) => ({
            type: 'Feature',
            properties: {
              capurl: d.indexed,
              mem: '127',
              areadesc: 'Metro Manila',
              gc: '1300000000',
            },
          })),
        }),
        fetchedAt: now,
      };
    const document = documents.find((d) => url.endsWith(`/v2/cap-alerts/${d.indexed}`));
    if (!document) throw new Error(`Unexpected WMO request: ${url}`);
    return { text: document.xml, fetchedAt: now - 500 };
  });
  const both = await createLocalAlertAdapter({
    national,
    global,
    kolkata: unavailable,
    india: unavailable,
  })(manila);
  const directDown = await createLocalAlertAdapter({
    national: unavailable,
    global,
    kolkata: unavailable,
    india: unavailable,
  })(manila);
  assert.deepEqual(
    both.checks?.map((check) => check.status),
    ['available', 'available'],
  );
  for (const value of [both, directDown])
    assert.deepEqual(value.alerts.map((alert) => alert.id).sort(), [
      'pagasa@example.gov.ph/POLY-IN/0',
      'pagasa@example.gov.ph/TCWS-1/0',
    ]);
  assert.equal(
    both.alerts.find((alert) => alert.id === 'pagasa@example.gov.ph/POLY-IN/0')?.url,
    documents[1].direct,
  );
  assert.match(
    both.alerts.find((alert) => alert.id === 'pagasa@example.gov.ph/TCWS-1/0')!.url,
    /^https:\/\/severeweather\.wmo\.int\/v2\/cap-alerts\/ph-pagasa-en\//,
  );
});

test('bulletins a source lists as taking effect later are named in the combined coverage', async () => {
  const quiet = await adapter(result([]), result([]))(jakarta);
  assert.doesNotMatch(quiet.coverage, /take effect later/);
  // The combined text is all a saved briefing keeps, so it states the time itself and never refers
  // the reader to the source checks.
  const soon = now + 2 * 3_600_000,
    later = now + 6 * 3_600_000;
  const value = await adapter(
    result([], { upcomingDocuments: 2, upcomingAt: later }),
    result([], { upcomingDocuments: 1, upcomingAt: soon }),
  )(jakarta);
  assert.ok(
    value.coverage.includes(
      ` Some checked bulletins take effect later and are not listed as current warnings yet; the earliest takes effect at ${new Date(soon).toISOString()}.`,
    ),
    value.coverage,
  );
  assert.doesNotMatch(value.coverage, /Source checks/);
  // A record a source sent before its effective time is held back here and disclosed the same way.
  const early = await adapter(
    result([warning('issuer/early/0', { effective: now + 600_000 })]),
    result([], { upcomingDocuments: 1, upcomingAt: later }),
  )(jakarta);
  assert.deepEqual(early.alerts, []);
  assert.ok(
    early.coverage.includes(
      `are not listed as current warnings yet; the earliest takes effect at ${new Date(now + 600_000).toISOString()}.`,
    ),
    early.coverage,
  );
  // A source that only counts such bulletins is still disclosed, without a time.
  const counted = await adapter(result([]), result([], { upcomingDocuments: 1 }))(jakarta);
  assert.match(
    counted.coverage,
    /Some checked bulletins take effect later and are not listed as current warnings yet\./,
  );
});

test('an Update that takes effect later leaves the current original visible across both sources', async () => {
  const manila: Place = {
    id: 'manila',
    name: 'Manila',
    country: 'Philippines',
    countryCode: 'PH',
    latitude: 14.6042,
    longitude: 120.9822,
  };
  const iso = (t: number) => new Date(t).toISOString();
  const issued = iso(now - 3_600_000);
  const xml = (id: string, type: string, effective: number, extra = '') =>
    `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>${id}</identifier><sender>pagasa@example.gov.ph</sender><sent>${id === 'ORIG' ? issued : iso(now - 60_000)}</sent><status>Actual</status><msgType>${type}</msgType><scope>Public</scope>${extra}<info><language>en</language><category>Met</category><event>Wind warning</event><urgency>Immediate</urgency><severity>Severe</severity><certainty>Likely</certainty><effective>${iso(effective)}</effective><expires>${iso(now + 30 * 3_600_000)}</expires><senderName>PAGASA</senderName><headline>Warning ${id}</headline><area><areaDesc>Metro Manila</areaDesc><polygon>14,120 14,122 16,122 16,120 14,120</polygon></area></info></alert>`;
  const original = xml('ORIG', 'Alert', now - 3_600_000);
  const update = xml(
    'UPD',
    'Update',
    now + 6 * 3_600_000,
    `<references>pagasa@example.gov.ph,ORIG,${issued}</references>`,
  );
  // The direct feed's window holds only the Update; WMO still indexes the original too.
  const direct =
    'https://publicalert.pagasa.dost.gov.ph/output/wcp/00000000-0000-4000-8000-000000000001.cap';
  const national = createNationalAlertAdapter(async (url) => {
    if (url.endsWith('/feeds/'))
      return {
        text: `<feed xmlns="http://www.w3.org/2005/Atom"><updated>${iso(now - 60_000)}</updated><entry><updated>${iso(now - 60_000)}</updated><link type="application/cap+xml" href="${direct}"/></entry></feed>`,
        fetchedAt: now - 1_000,
      };
    if (url === direct) return { text: update, fetchedAt: now - 500 };
    throw new Error(`Unexpected direct request: ${url}`);
  });
  const indexed = { 'ORIG.xml': original, 'UPD.xml': update };
  const global = createGlobalAlertAdapter(async (url) => {
    if (url.endsWith('/json/sources.json'))
      return {
        text: JSON.stringify({
          sources: [
            {
              source: {
                authorityCountry: 'ph',
                sourceIsOfficial: true,
                capAlertFeedStatus: 'operating',
                sourceId: 'ph-pagasa-en',
                memID: '127',
                byLanguage: [{ code: 'en', name: 'PAGASA' }],
              },
            },
          ],
        }),
        fetchedAt: now - 10_000,
      };
    if (url.includes('/f/ows/'))
      return {
        text: JSON.stringify({
          type: 'FeatureCollection',
          features: Object.keys(indexed).map((name) => ({
            type: 'Feature',
            properties: {
              capurl: `ph-pagasa-en/2026/11/09/01/00/${name}`,
              mem: '127',
              areadesc: 'Metro Manila',
              gc: '',
            },
          })),
        }),
        fetchedAt: now,
      };
    const name = Object.keys(indexed).find((file) => url.endsWith(`/${file}`));
    if (!name) throw new Error(`Unexpected WMO request: ${url}`);
    return { text: indexed[name as keyof typeof indexed], fetchedAt: now - 500 };
  });
  const value = await createLocalAlertAdapter({
    national,
    global,
    kolkata: unavailable,
    india: unavailable,
  })(manila);
  assert.deepEqual(
    value.checks?.map((check) => check.status),
    ['available', 'available'],
  );
  assert.deepEqual(
    value.alerts.map((alert) => alert.id),
    ['pagasa@example.gov.ph/ORIG/0'],
  );
  // Both real adapters hand over the Update's effective time for the combined text.
  assert.ok(
    value.coverage.includes(
      ` Some checked bulletins take effect later and are not listed as current warnings yet; the earliest takes effect at ${iso(now + 6 * 3_600_000)}.`,
    ),
    value.coverage,
  );
});

test('regenerated identifiers do not duplicate identical official text or hide distinct affected areas', async () => {
  const direct = warning('issuer/direct-new-id/0', { title: 'Official storm warning' });
  const indexedCopy = {
    ...direct,
    id: 'issuer/indexed-old-id/0',
    url: 'https://severeweather.wmo.int/v2/cap-alerts/id-inatews-en/2026/10/31/20/30/bulletin.xml',
  };
  const otherArea = {
    ...indexedCopy,
    id: 'issuer/other-area/0',
    area: 'Another named affected area',
  };
  const otherText = {
    ...indexedCopy,
    id: 'issuer/other-text/0',
    description: 'Different official hazard description',
  };
  const value = await adapter(
    result([direct]),
    result([indexedCopy, otherArea, otherText]),
  )(jakarta);
  assert.deepEqual(
    value.alerts.map((alert) => alert.id),
    [direct.id, otherArea.id, otherText.id],
  );
  assert.equal(value.alerts[0].url, direct.url);
});

test('a WMO cancellation suppresses a still-active copy found in the direct feed', async () => {
  const value = await adapter(
    result([warning('issuer/revoked/0'), warning('issuer/current/0')]),
    result([], { revokedCapKeys: ['issuer/revoked/'] }),
  )(jakarta);
  assert.deepEqual(
    value.alerts.map((a) => a.id),
    ['issuer/current/0'],
  );
});

test('partial provider failure keeps verified warnings and exposes the missing source', async () => {
  const value = await adapter(
    unavailable,
    result([warning('issuer/retained/0')], { source: 'BMKG via WMO SWIC' }),
  )(jakarta);
  assert.equal(value.alerts.length, 1);
  assert.equal(value.checks?.[0].status, 'unavailable');
  assert.equal(value.checks?.[0].fetchedAt, null);
  assert.equal(value.checks?.[1].status, 'available');
  assert.match(value.source, /other source unavailable/);
  assert.match(value.coverage, /1 of 2 sources could not be verified/);
  assert.doesNotMatch(value.checks![0].coverage, /Upstream timeout/);
  const directOnly = await adapter(result([warning('issuer/direct/0')]), unavailable)(jakarta);
  assert.equal(directOnly.alerts[0].id, 'issuer/direct/0');
  assert.equal(directOnly.checks?.[1].status, 'unavailable');
});

test('both failed or unsupported sources fail closed, never return an available empty result', async () => {
  await assert.rejects(adapter(unavailable, unavailable)(jakarta), /Neither official/);
  await assert.rejects(
    adapter(result([], { status: 'unsupported' }), unavailable)(jakarta),
    /Neither official/,
  );
});

test('Kolkata combines district and state bulletins without relabeling a distant district', async () => {
  const value = await createLocalAlertAdapter({
    national: unavailable,
    global: unavailable,
    kolkata: async () =>
      result([warning('imd/kolkata', { area: 'Kolkata district', source: 'IMD' })], {
        scope: 'region',
        scopeLabel: 'Kolkata district',
      }),
    india: async () =>
      result([warning('sachet/darjeeling', { area: 'Darjeeling', source: 'IMD via SACHET' })], {
        scope: 'region',
        scopeLabel: 'West Bengal',
      }),
  })(kolkata);
  assert.equal(value.scope, 'region');
  assert.equal(value.scopeLabel, 'Kolkata district + West Bengal');
  assert.deepEqual(
    value.alerts.map((a) => a.area),
    ['Kolkata district', 'Darjeeling'],
  );
  assert.deepEqual(
    value.checks?.map((c) => c.id),
    ['imd-kolkata', 'sachet'],
  );
  assert.match(value.coverage, /do not automatically apply to Kolkata/);
});

test('a source still loading at its deadline is reported missing instead of discarding the other', async () => {
  // router.ts aborts the whole check after 18 s; scaled down to 2 s here.
  const gateway = new AbortController();
  const timer = setTimeout(() => gateway.abort(new Error('Warning sources timed out.')), 2_000);
  let stopped: unknown;
  const slowSachet = (_place: Place, signal?: AbortSignal) =>
    new Promise<Result>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject((stopped = signal.reason)), { once: true }),
    );
  const ignoresCancellation = () => new Promise<Result>(() => {});
  try {
    const value = await createLocalAlertAdapter(
      {
        national: unavailable,
        global: unavailable,
        kolkata: async () =>
          result([warning('imd-kolkata:kol-1', { area: 'Kolkata district', source: 'IMD' })], {
            scope: 'region',
            scopeLabel: 'Kolkata district',
          }),
        india: slowSachet,
      },
      { deadlineMs: 20 },
    )(kolkata, gateway.signal);
    assert.deepEqual(
      value.alerts.map((a) => a.id),
      ['imd-kolkata:kol-1'],
    );
    assert.deepEqual(
      value.checks?.map((c) => `${c.id}:${c.status}`),
      ['imd-kolkata:available', 'sachet:unavailable'],
    );
    assert.match(value.source, /other source unavailable/);
    assert.ok(stopped instanceof Error, 'the slow source is told to stop');

    const direct = await createLocalAlertAdapter(
      {
        national: ignoresCancellation,
        global: async () => result([warning('issuer/wmo/0')], { source: 'BMKG via WMO SWIC' }),
        kolkata: unavailable,
        india: unavailable,
      },
      { deadlineMs: 20 },
    )(jakarta, gateway.signal);
    assert.deepEqual(
      direct.checks?.map((c) => `${c.id}:${c.status}`),
      ['national:unavailable', 'wmo:available'],
    );
    assert.equal(gateway.signal.aborted, false);
  } finally {
    clearTimeout(timer);
  }
});

test('composition excludes newly expired and future-effective records and caps sorted warnings', async () => {
  const many = Array.from({ length: 35 }, (_, i) =>
    warning(`issuer/${i}/0`, { severity: i === 34 ? 'Extreme' : 'Moderate' }),
  );
  const value = await adapter(
    result([
      warning('issuer/old/0', { expires: now - 1 }),
      warning('issuer/future/0', { effective: now + 1_000_000 }),
      ...many,
    ]),
    result([]),
  )(jakarta);
  assert.equal(value.alerts.length, 30);
  assert.equal(value.alerts[0].id, 'issuer/34/0');
  assert.ok(!value.alerts.some((a) => /old|future/.test(a.id)));
  assert.match(value.coverage, /Additional bulletins were omitted/);
});

test('unsupported locations never call a direct provider and aborted checks never become available', async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    return result();
  };
  const fetch = createLocalAlertAdapter({
    national: load,
    global: load,
    kolkata: load,
    india: load,
  });
  await assert.rejects(fetch({ ...jakarta, countryCode: 'NZ' }), /not configured/);
  assert.equal(calls, 0);
  const controller = new AbortController();
  controller.abort(new Error('Location changed'));
  await assert.rejects(fetch(jakarta, controller.signal), /Location changed/);
});
