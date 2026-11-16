import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canApplyAppUpdate,
  handOverUpdatePlace,
  restoreUpdatePlace,
} from '../src/app-update-guard';
const place = {
  id: 'bengaluru',
  name: 'Bengaluru',
  latitude: 12.97,
  longitude: 77.59,
  country: 'India',
  countryCode: 'IN',
  timezone: 'Asia/Kolkata',
};
const fallback = { ...place, id: 'chennai', name: 'Chennai', latitude: 13.08, longitude: 80.27 };
const idle = {
  query: '',
  searching: false,
  geoBusy: false,
  drawerOpen: false,
  notifications: false,
  place,
};
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

test('a routine update check leaves no place for an ordinary reload to reopen', () => {
  // The updater asks on every idle check, including checks that find no new version.
  const storage = memoryStorage();
  assert.equal(canApplyAppUpdate(idle, storage), true);
  assert.equal(storage.items.size, 0);
  assert.deepEqual(restoreUpdatePlace(storage, fallback), fallback);
});

test("only the updater's own reload hands the selected place to the next page, once", () => {
  const storage = memoryStorage();
  for (const update of [undefined, {}, { status: 'current' }, { status: 'waiting-for-idle' }])
    assert.equal(handOverUpdatePlace(update, place, storage), false);
  assert.equal(storage.items.size, 0);
  assert.equal(handOverUpdatePlace({ status: 'reloading' }, place, storage), true);
  assert.deepEqual(restoreUpdatePlace(storage, fallback), place);
  // A later ordinary reload opens the default place again.
  assert.deepEqual(restoreUpdatePlace(storage, fallback), fallback);
  assert.equal(storage.items.size, 0);
});

test('unsaved interactions and unusable storage veto the update or fall back safely', () => {
  const storage = memoryStorage();
  for (const change of [
    { query: 'Delhi' },
    { searching: true },
    { geoBusy: true },
    { drawerOpen: true },
    { notifications: true },
  ])
    assert.equal(canApplyAppUpdate({ ...idle, ...change }, storage), false);
  const full = {
    ...memoryStorage(),
    setItem() {
      throw Error('Quota');
    },
  };
  assert.equal(canApplyAppUpdate(idle, full), false);
  assert.equal(handOverUpdatePlace({ status: 'reloading' }, place, full), false);
  const blocked = {
    ...memoryStorage(),
    getItem(): string | null {
      throw Error('Blocked');
    },
  };
  assert.deepEqual(restoreUpdatePlace(blocked, fallback), fallback);
  // Unreadable data is discarded rather than kept for a later reload.
  storage.setItem('stormsignal:update-place', '{bad');
  assert.deepEqual(restoreUpdatePlace(storage, fallback), fallback);
  assert.equal(storage.items.size, 0);
});
