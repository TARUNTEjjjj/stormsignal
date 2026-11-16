import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawerAfterResize, nextSearchIndex, placeResourceKey } from '../src/place-navigation';
import type { Place } from '../src/types';
const place: Place = {
  id: 'city',
  name: 'Kolkata',
  country: 'India',
  countryCode: 'IN',
  latitude: 22.57,
  longitude: 88.36,
  admin: 'West Bengal',
};

test('resource identity updates region-dependent warning requests at unchanged coordinates', () => {
  for (const change of [
    { name: 'Nearby district' },
    { admin: 'Other region' },
    { countryCode: 'BD' },
    { latitude: 23 },
    { timezone: 'Asia/Kolkata' },
  ])
    assert.notEqual(placeResourceKey(place), placeResourceKey({ ...place, ...change }));
  assert.equal(placeResourceKey(place), placeResourceKey({ ...place, id: 'saved-copy' }));
  assert.equal(
    placeResourceKey({ ...place, admin: undefined }),
    placeResourceKey({ ...place, admin: '' }),
  );
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
test('the mobile drawer closes when the viewport widens and stays closed when it narrows again', () => {
  // Mirrors App: the sidebar is a modal drawer while the viewport is narrow and it is open.
  const viewport = (open: boolean) => ({
    resize(narrow: boolean) {
      open = drawerAfterResize(open, narrow);
      return narrow && open;
    },
  });
  // "Open navigation" on a tablet held upright, then turned to landscape and back.
  const tablet = viewport(true);
  assert.equal(tablet.resize(false), false);
  assert.equal(tablet.resize(true), false, 'the drawer must not reopen by itself');
  // A resize that stays within the narrow layout keeps the drawer open.
  assert.equal(viewport(true).resize(true), true);
  // A resize never opens a closed drawer.
  const closed = viewport(false);
  for (const narrow of [true, false, true]) assert.equal(closed.resize(narrow), false);
});
