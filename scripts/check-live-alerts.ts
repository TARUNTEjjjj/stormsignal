/**
 * Opt-in integration check: performs real public-provider reads, never fixtures.
 * Build first, then run: node --import tsx scripts/check-live-alerts.ts --live
 * This exercises the production Worker artifact locally; it is not an edge-runtime test.
 */
import assert from 'node:assert/strict';
import { fetchAlerts } from '../src/data';
import type { AlertResult, Place } from '../src/types';

if (!process.argv.includes('--live')) {
  console.error(
    'Opt-in required. After npm run build, run: node --import tsx scripts/check-live-alerts.ts --live',
  );
  process.exit(1);
}

const worker = (await import(new URL('../dist/server/index.js', import.meta.url).href)).default as {
  fetch(request: Request): Promise<Response>;
};
const cases: { place: Place; scope: 'point' | 'region'; scopeLabel: string; partial: boolean }[] = [
  {
    place: {
      id: '5391959',
      name: 'San Francisco',
      country: 'United States',
      countryCode: 'US',
      admin: 'California',
      latitude: 37.77493,
      longitude: -122.41942,
      timezone: 'America/Los_Angeles',
    },
    scope: 'point',
    scopeLabel: 'San Francisco',
    partial: false,
  },
  {
    place: {
      id: '1701668',
      name: 'Manila',
      country: 'Philippines',
      countryCode: 'PH',
      admin: 'National Capital Region',
      latitude: 14.6042,
      longitude: 120.9822,
      timezone: 'Asia/Manila',
    },
    scope: 'point',
    scopeLabel: 'Manila',
    partial: true,
  },
  {
    place: {
      id: '1275004',
      name: 'Kolkata',
      country: 'India',
      countryCode: 'IN',
      admin: 'West Bengal',
      latitude: 22.56263,
      longitude: 88.36304,
      timezone: 'Asia/Kolkata',
    },
    scope: 'region',
    scopeLabel: 'West Bengal',
    partial: true,
  },
  {
    place: {
      id: '1642911',
      name: 'Jakarta',
      country: 'Indonesia',
      countryCode: 'ID',
      admin: 'Jakarta Special Capital Region',
      latitude: -6.21462,
      longitude: 106.84513,
      timezone: 'Asia/Jakarta',
    },
    scope: 'point',
    scopeLabel: 'Jakarta',
    partial: true,
  },
];

async function check(item: (typeof cases)[number]) {
  const { place } = item;
  const signal = AbortSignal.timeout(30_000);
  let result: AlertResult;
  if (place.countryCode === 'US') result = await fetchAlerts(place, signal);
  else {
    // Match the browser adapter's coordinate precision and region metadata.
    const query = new URLSearchParams({
      lat: place.latitude.toFixed(4),
      lon: place.longitude.toFixed(4),
      country: place.countryCode,
      admin: place.admin ?? '',
      name: place.name,
    });
    const response = await worker.fetch(
      new Request(`https://stormsignal.invalid/api/alerts?${query}`, { signal }),
    );
    assert.equal(
      response.status,
      200,
      `${place.name}: warning API returned HTTP ${response.status}`,
    );
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    result = (await response.json()) as AlertResult;
  }

  const now = Date.now();
  assert.equal(result.status, 'available', `${place.name}: feed unavailable or unsupported`);
  assert.equal(result.scope, item.scope, `${place.name}: incorrect warning scope`);
  assert.equal(result.scopeLabel, item.scopeLabel, `${place.name}: incorrect area label`);
  assert.equal(result.partial, item.partial, `${place.name}: incorrect coverage claim`);
  assert.ok(
    Number.isFinite(result.fetchedAt) &&
      result.fetchedAt <= now + 5_000 &&
      now - result.fetchedAt <= 120_000,
    `${place.name}: retrieval time is missing, stale, or in the future`,
  );
  assert.ok(Array.isArray(result.alerts), `${place.name}: invalid warning list`);
  assert.ok(result.source?.trim(), `${place.name}: issuing source is missing`);
  assert.ok(result.coverage?.trim(), `${place.name}: coverage explanation is missing`);
  assert.equal(new URL(result.officialUrl).protocol, 'https:');
  const seen = new Set<string>();
  for (const warning of result.alerts) {
    assert.ok(
      warning.id && !seen.has(warning.id),
      `${place.name}: missing or duplicate warning ID`,
    );
    seen.add(warning.id);
    assert.ok(
      [warning.sent, warning.effective, warning.expires].every(Number.isFinite) &&
        warning.sent <= now + 300_000 &&
        warning.effective <= now &&
        warning.expires > now &&
        warning.expires > warning.sent &&
        warning.expires > warning.effective,
      `${place.name}: a returned warning has invalid or inactive validity times`,
    );
    assert.ok(warning.source?.trim(), `${place.name}: a warning is missing its issuer`);
    assert.equal(new URL(warning.url).protocol, 'https:');
  }
  return {
    city: place.name,
    source: result.source.slice(0, 200),
    scope: `${result.scope}: ${result.scopeLabel}`,
    partial: result.partial,
    warnings: result.alerts.length,
    checkedAt: new Date(result.fetchedAt).toISOString(),
    latestBulletin: result.feedUpdatedAt ? new Date(result.feedUpdatedAt).toISOString() : null,
    meaning: result.alerts.length
      ? 'Verified active bulletins returned; follow the issuing authority.'
      : result.partial
        ? 'No matching unexpired bulletins in this limited feed; this is not an all-clear.'
        : 'No active point warnings returned; this is not a safety guarantee.',
  };
}

console.log('Real upstream checks using the local production build (not the hosted edge runtime).');
const results = await Promise.allSettled(cases.map(check));
for (const [index, result] of results.entries()) {
  if (result.status === 'fulfilled') console.log(JSON.stringify(result.value));
  else {
    process.exitCode = 1;
    console.error(
      JSON.stringify({
        city: cases[index].place.name,
        failed: true,
        reason: String(
          result.reason instanceof Error ? result.reason.message : result.reason,
        ).slice(0, 300),
      }),
    );
  }
}
if (!process.exitCode)
  console.log('All four official-alert checks passed. Warning counts may change.');
