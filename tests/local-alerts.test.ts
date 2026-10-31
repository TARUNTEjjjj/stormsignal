import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAlertAdapter } from '../server/local-alerts';
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
type Result = AlertResult & { excludedCapKeys?: string[]; revokedCapKeys?: string[] };
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
