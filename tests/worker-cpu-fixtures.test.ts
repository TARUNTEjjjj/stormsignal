import test from 'node:test';
import assert from 'node:assert/strict';
import { createKolkataAlertAdapter } from '../server/kolkata';
import type { Place } from '../src/types';
import {
  FEED_MAX_BYTES,
  FEED_MAX_ENTRIES,
  imdFeed,
  standardFixtures,
} from './worker-cpu/imd-fixtures';

const place: Place = {
  id: '1275004',
  name: 'Kolkata',
  country: 'India',
  countryCode: 'IN',
  admin: 'West Bengal',
  latitude: 22.56263,
  longitude: 88.36304,
};
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const entries = (text: string) => text.split('<item ').length - 1;

test('CPU harness fixtures reach the parser bounds without exceeding them', () => {
  const now = Date.now();
  const fixtures = Object.values(standardFixtures(now));
  assert.deepEqual(fixtures.map(entries), [20, FEED_MAX_ENTRIES, FEED_MAX_ENTRIES]);
  const [short, observed, nearBound] = fixtures.map(bytes);
  assert.ok(short < 20_000);
  // Unpadded entries stay near the observed 610-640 bytes of the public feed.
  assert.ok(observed / FEED_MAX_ENTRIES > 600 && observed / FEED_MAX_ENTRIES < 660);
  assert.equal(nearBound, FEED_MAX_BYTES);
  // Contact fields are synthetic, never the provider's.
  for (const fixture of fixtures) assert.doesNotMatch(fixture, /gmail|@(?!example\.invalid)/);
  assert.throws(() => imdFeed({ entries: FEED_MAX_ENTRIES + 1, now }), /1-1000 entries/);
  assert.throws(() => imdFeed({ entries: 10, targetBytes: 100, now }), /smaller than/);
});

test('the production adapter reads every CPU fixture and finds the last-placed Kolkata bulletin', async () => {
  const now = Date.now();
  for (const [name, raw] of Object.entries(standardFixtures(now))) {
    const adapter = createKolkataAlertAdapter(async () => ({ text: raw, fetchedAt: now }));
    const result = await adapter(place);
    assert.equal(result.alerts.length, 1, name);
    assert.equal(result.alerts[0].id, `imd-kolkata:${entries(raw).toString(16).padStart(32, '0')}`);
    assert.doesNotMatch(result.coverage, /no district|invalid/, name);
  }
});
