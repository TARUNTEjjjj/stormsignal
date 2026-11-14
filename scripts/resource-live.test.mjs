import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECT, normalizeCatalog, isOlderCatalog, catalogJSON, loadRemoteCatalog} from '../resources/catalog.mjs';
import {createCatalogStore} from '../resources/storage.mjs';
import {createCatalogController, bindCatalogLifecycle, REFRESH_INTERVAL_MS} from '../resources/live.mjs';

const snapshot = (date = '2026-11-14T00:00:00Z', title = 'Latest collection') => normalizeCatalog({schemaVersion: 1, project: PROJECT,
  title, status: 'live', fetchedAt: date, categories: [{id: 'math', title: 'Mathematics'}],
  items: [{id: 1, category: 'math', fullName: 'example/library', url: 'https://github.com/example/library', topics: [], stars: 200, fetchedAt: date}]});
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
function clock(initial = 10000) {
  let wall = initial, elapsed = 0, serial = 0;
  const timers = new Map();
  return {now: () => wall,
    setTimer(fn, delay) { const id = ++serial; timers.set(id, {fn, due: elapsed + delay}); return id; },
    clearTimer(id) { timers.delete(id); },
    wall(value) { wall = value; },
    async advance(ms) { wall += ms; elapsed += ms; for (const [id, timer] of [...timers]) if (timer.due <= elapsed) { timers.delete(id); timer.fn(); } await tick(); },
    count: () => timers.size};
}
function memoryStore(initial = null) {
  let stored = initial;
  const listeners = new Set();
  return {
    load: async () => stored,
    async save(incoming) {
      const accepted = !isOlderCatalog(incoming, stored);
      if (accepted) stored = normalizeCatalog(incoming);
      return {catalog: stored, saved: true, accepted};
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    replace(value) { stored = value; for (const fn of listeners) fn(); },
    value: () => stored,
  };
}
function setup(options = {}) {
  const timer = clock(), store = memoryStore();
  const controller = createCatalogController({store, fetchBundled: async () => snapshot('2026-11-12T00:00:00Z', 'Bundled'),
    fetchRemote: async () => snapshot(), ...timer, ...options});
  return {controller, timer, store};
}

test('saved data appears before the network check and a newer download is persisted', async () => {
  const events = [], store = memoryStore(snapshot('2026-11-13T00:00:00Z', 'Saved'));
  const {controller} = setup({store, onChange: state => events.push(state), fetchRemote: async () => {
    assert.equal(events.find(event => event.catalog)?.catalog.title, 'Saved');
    assert.equal(events.find(event => event.catalog)?.source, 'saved');
    return snapshot();
  }});
  await controller.start();
  assert.equal(controller.getState().source, 'github');
  assert.equal(controller.getState().savedOffline, true);
  assert.equal(store.value().title, 'Latest collection');
  assert.equal(controller.getState().lastSuccessfulCheck, 10000);
  controller.stop();
});

test('completion-based timer, manual refresh, and focus checks coalesce in-flight requests', async () => {
  const pending = deferred(); let calls = 0;
  const {controller, timer} = setup({fetchRemote: () => ++calls === 1 ? pending.promise : Promise.resolve(snapshot())});
  const startup = controller.start(); await tick();
  const manual = controller.refresh(), focused = controller.checkIfDue();
  await timer.advance(5000);
  assert.equal(calls, 1);
  pending.resolve(snapshot()); await Promise.all([startup, manual, focused]);
  assert.equal(controller.getState().nextCheckAt, 15000 + REFRESH_INTERVAL_MS);
  assert.equal(timer.count(), 1);
  await timer.advance(REFRESH_INTERVAL_MS - 1); assert.equal(calls, 1);
  await timer.advance(1); assert.equal(calls, 2);
  await controller.refresh(); assert.equal(calls, 3);
  await controller.checkIfDue(); assert.equal(calls, 3);
  controller.stop(); assert.equal(timer.count(), 0);
});

test('failed checks retain the saved collection and retry at a bounded cadence', async () => {
  const store = memoryStore(snapshot()), timer = clock(); let calls = 0;
  const controller = createCatalogController({...timer, store, fetchBundled: async () => snapshot('2026-11-12T00:00:00Z'),
    fetchRemote: async () => { calls++; throw new Error('offline'); }});
  await controller.start();
  assert.equal(controller.getState().source, 'saved');
  assert.equal(controller.getState().savedOffline, true);
  assert.equal(controller.getState().lastSuccessfulCheck, null);
  assert.match(controller.getState().error, /could not be completed/);
  await Promise.all([controller.checkIfDue(), controller.checkIfDue()]); assert.equal(calls, 1);
  await timer.advance(REFRESH_INTERVAL_MS); assert.equal(calls, 2);
  controller.stop();
});

test('first offline launch saves its validated bundled fallback without inventing a successful check', async () => {
  const {controller, store} = setup({fetchRemote: async () => { throw new Error('offline'); }});
  await controller.start();
  assert.equal(controller.getState().source, 'bundled');
  assert.equal(controller.getState().savedOffline, true);
  assert.equal(controller.getState().lastSuccessfulCheck, null);
  assert.equal(store.value().title, 'Bundled');
  controller.stop();
});

test('denied or corrupt storage and quota failures do not prevent a verified live collection', async () => {
  for (const corrupt of [false, true]) {
    const store = {load: async () => { if (corrupt) return {schemaVersion: 999}; throw new Error('denied'); }, save: async () => { throw new Error('quota'); }};
    const {controller} = setup({store});
    await controller.start();
    assert.equal(controller.getState().source, 'github');
    assert.equal(controller.getState().catalog.title, 'Latest collection');
    assert.equal(controller.getState().savedOffline, false);
    assert.equal(controller.getState().storageError, true);
    assert.notEqual(controller.getState().lastSuccessfulCheck, null);
    controller.stop();
  }
});

test('older and undated CDN responses cannot downgrade newer saved data', async () => {
  for (const old of [snapshot('2026-11-13T00:00:00Z', 'Old CDN'), snapshot(null, 'Undated')]) {
    const store = memoryStore(snapshot());
    const {controller} = setup({store, fetchRemote: async () => old});
    await controller.start();
    assert.equal(controller.getState().catalog.title, 'Latest collection');
    assert.equal(store.value().title, 'Latest collection');
    assert.equal(controller.getState().retainedNewer, true);
    assert.equal(controller.getState().savedOffline, true);
    controller.stop();
  }
  const sameCollection = snapshot();
  sameCollection.attemptedAt = '2026-11-14T12:00:00Z';
  assert.equal(isOlderCatalog(snapshot(), sameCollection), true, 'a previous partial-attempt state must not replace a newer attempt at the same source date');
});

test('a concurrently saved newer collection wins the write transaction and displayed state', async () => {
  const newer = snapshot('2026-11-15T00:00:00Z', 'Other tab');
  const store = {load: async () => null, save: async () => ({catalog: newer, saved: true, accepted: false})};
  const {controller} = setup({store});
  await controller.start();
  assert.equal(controller.getState().catalog.title, 'Other tab');
  assert.equal(controller.getState().source, 'saved');
  assert.equal(controller.getState().retainedNewer, true);
  controller.stop();
});

test('cross-tab notification reloads newer stored data without a network storm', async () => {
  const store = memoryStore(); let calls = 0;
  const {controller} = setup({store, fetchRemote: async () => { calls++; return snapshot(); }});
  await controller.start();
  store.replace(snapshot('2026-11-16T00:00:00Z', 'New tab data')); await tick();
  assert.equal(controller.getState().catalog.title, 'New tab data');
  assert.equal(controller.getState().savedOffline, true);
  assert.equal(calls, 1);
  controller.stop();
  store.replace(snapshot('2026-11-17T00:00:00Z')); await tick();
  assert.equal(controller.getState().catalog.title, 'New tab data');
});

test('cancellation rejects late completions, preserves disk, and permits a fresh resumed request', async () => {
  const first = deferred(), second = deferred(); let calls = 0, firstSignal;
  const {controller, store} = setup({fetchRemote: ({signal}) => { calls++; if (calls === 1) { firstSignal = signal; return first.promise; } return second.promise; }});
  const oldStart = controller.start(); await tick();
  controller.stop(); assert.equal(firstSignal.aborted, true);
  const resumed = controller.start(); await tick();
  first.resolve(snapshot('2026-11-20T00:00:00Z', 'Cancelled late response')); await oldStart;
  assert.equal(store.value(), null);
  second.resolve(snapshot()); await resumed;
  assert.equal(controller.getState().catalog.title, 'Latest collection');
  assert.equal(store.value().title, 'Latest collection');
  assert.equal(controller.getState().refreshing, false);
  controller.stop();
});

test('a backward wall clock is bounded by the elapsed timer and resume checks when overdue', async () => {
  let calls = 0;
  const {controller, timer} = setup({fetchRemote: async () => { calls++; return snapshot(); }});
  await controller.start(); timer.wall(-10000000);
  await controller.checkIfDue(); assert.equal(calls, 1);
  assert.equal(controller.getState().nextCheckAt, -10000000 + REFRESH_INTERVAL_MS);
  await timer.advance(REFRESH_INTERVAL_MS); assert.equal(calls, 2);
  controller.stop(); await timer.advance(REFRESH_INTERVAL_MS + 1);
  await controller.start(); assert.equal(calls, 3);
  controller.stop();
});

test('malformed network metadata keeps last good data and does not count as a successful check', async () => {
  const {controller} = setup({store: memoryStore(snapshot()), fetchRemote: async () => ({...snapshot(), project: 'another-project'})});
  await controller.start();
  assert.equal(controller.getState().catalog.title, 'Latest collection');
  assert.equal(controller.getState().lastSuccessfulCheck, null);
  assert.ok(controller.getState().error);
  controller.stop();
});

test('lifecycle bindings pause, resume, and check due state only when visible', async () => {
  const windowObject = new EventTarget(), documentObject = new EventTarget();
  documentObject.visibilityState = 'hidden';
  const calls = [];
  const controller = Object.fromEntries(['start', 'stop', 'reconcileSaved', 'checkIfDue'].map(name => [name, () => { calls.push(name); return Promise.resolve(); }]));
  const cleanup = bindCatalogLifecycle(controller, {windowObject, documentObject});
  documentObject.dispatchEvent(new Event('visibilitychange')); assert.deepEqual(calls, []);
  documentObject.visibilityState = 'visible'; documentObject.dispatchEvent(new Event('visibilitychange'));
  windowObject.dispatchEvent(new Event('online')); windowObject.dispatchEvent(new Event('focus'));
  windowObject.dispatchEvent(new Event('pagehide')); windowObject.dispatchEvent(new Event('pageshow'));
  assert.deepEqual(calls, ['reconcileSaved', 'checkIfDue', 'reconcileSaved', 'checkIfDue', 'reconcileSaved', 'checkIfDue', 'stop', 'start']);
  cleanup(); const length = calls.length;
  windowObject.dispatchEvent(new Event('online')); assert.equal(calls.length, length);
});

test('explicit cancellation bounds uncooperative transport without trying another origin', async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = loadRemoteCatalog({signal: controller.signal, timeoutMs: 1000, fetchImpl: () => { calls++; return new Promise(() => {}); }});
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(calls, 1);
});

test('storage denial and blocked open are bounded and an eventual late connection is closed', async () => {
  await assert.rejects(createCatalogStore({indexedDB: null, BroadcastChannel: null}).load(), /unavailable/);
  let request, closed = false;
  const store = createCatalogStore({indexedDB: {open: () => (request = {})}, BroadcastChannel: null, timeoutMs: 10});
  await assert.rejects(store.load(), /open in time/);
  request.result = {close() { closed = true; }}; request.onsuccess();
  assert.equal(closed, true);
  store.close();
});

test('storage strips unrelated data, bounds snapshots, and catches asynchronous put exceptions', async () => {
  const raw = {...snapshot(), token: 'must not persist'};
  raw.items[0].id = {secret: 'must not persist'};
  const clean = JSON.parse(catalogJSON(raw));
  assert.equal(Object.hasOwn(clean, 'token'), false);
  assert.equal(typeof clean.items[0].id, 'string');
  let aborted = false;
  const db = {close() {}, transaction() {
    const tx = {abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); }, objectStore() { return {
      get() { const request = {}; queueMicrotask(() => { request.result = null; request.onsuccess(); }); return request; },
      put() { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
    }; }};
    return tx;
  }};
  const database = {open() { const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess(); }); return request; }};
  const store = createCatalogStore({indexedDB: database, BroadcastChannel: null});
  await assert.rejects(store.save(raw), /could not save/);
  assert.equal(aborted, true); store.close();
  const oversized = snapshot(); oversized.items = Array.from({length: 2000}, (_, id) => ({...oversized.items[0], id, description: 'a'.repeat(500), reason: 'b'.repeat(240)}));
  assert.throws(() => catalogJSON(oversized), /byte limit/);
});
