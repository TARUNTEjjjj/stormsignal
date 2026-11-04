import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextSearchIndex, placeResourceKey } from '../src/place-navigation';
import type { Place } from '../src/types';
const place: Place = { id: 'city', name: 'Kolkata', country: 'India', countryCode: 'IN',
  latitude: 22.57, longitude: 88.36, admin: 'West Bengal' };

test('resource identity updates region-dependent warning requests at unchanged coordinates', () => {
  for (const change of [{ name: 'Nearby district' }, { admin: 'Other region' },
    { countryCode: 'BD' }, { latitude: 23 }, { timezone: 'Asia/Kolkata' }])
    assert.notEqual(placeResourceKey(place), placeResourceKey({ ...place, ...change }));
  assert.equal(placeResourceKey(place), placeResourceKey({ ...place, id: 'saved-copy' }));
  assert.equal(placeResourceKey({ ...place, admin: undefined }), placeResourceKey({ ...place, admin: '' }));
});
test('keyboard search starts at either end and wraps without leaving the result list', () => {
  assert.equal(nextSearchIndex(-1, 3, 'ArrowDown'), 0);
  assert.equal(nextSearchIndex(-1, 3, 'ArrowUp'), 2);
  assert.equal(nextSearchIndex(2, 3, 'ArrowDown'), 0);
  assert.equal(nextSearchIndex(0, 3, 'ArrowUp'), 2);
  assert.equal(nextSearchIndex(1, 3, 'ArrowUp'), 0);
  assert.equal(nextSearchIndex(0, 1, 'ArrowDown'), 0);
  assert.equal(nextSearchIndex(1, 3, 'Escape'), 1);
  assert.equal(nextSearchIndex(1, 0, 'ArrowDown'), -1);
});
