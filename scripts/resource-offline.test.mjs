import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {publicResourceFiles, renderResourceWorker} from './stage-resource-explorer.mjs';
import {ensureOfflineShell} from '../resources/offline.mjs';

const origin = 'https://resource.example';
const scope = origin + '/resources/';
const type = file => file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/javascript';
async function fixture() {
  const files = new Map(publicResourceFiles.map(file => [file, Buffer.from(file === 'catalog.json'
    ? JSON.stringify({schemaVersion: 1, project: 'fixture', title: 'Public snapshot', items: []})
    : file === 'index.html' ? '<!doctype html><h1>Library</h1>' : file.endsWith('.css') ? 'body{color:green}' : 'export const publicAsset = true;')]));
  files.set('offline-worker.js', await readFile(new URL('../resources/offline-worker.js', import.meta.url)));
  return files;
}

function runtime(files, {timeout = 8000} = {}) {
  const handlers = {}, storage = new Map(), calls = [];
  let claims = 0, skips = 0, failWrites = false;
  const caches = {
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Map());
      const saved = storage.get(name);
      return {async match(url) { return saved.get(String(url))?.clone(); }, async put(url, response) {
        if (failWrites) throw new Error('Quota exceeded');
        saved.set(String(url), response.clone());
      }};
    },
    async has(name) { return storage.has(name); }, async keys() { return [...storage.keys()]; },
    async delete(name) { return storage.delete(name); },
  };
  const context = vm.createContext({URL, Response, Headers, AbortController, Uint8Array, TextDecoder, crypto: webcrypto,
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, timeout)), clearTimeout, caches,
    self: {registration: {scope}, addEventListener(name, handler) { const previous=handlers[name];handlers[name]=event=>{previous?.(event);handler(event);}; },
      async skipWaiting() { skips++; }, clients: {async claim() { claims++; }}},
    async fetch(url, options) {
      calls.push({url, options});
      const file = url === scope ? 'index.html' : new URL(url).pathname.slice('/resources/'.length);
      if (!files.has(file)) return new Response('missing', {status: 404});
      return new Response(files.get(file), {headers: {'Content-Type': type(file)}});
    },
  });
  vm.runInContext(renderResourceWorker(files).toString(), context);
  async function lifecycle(name) { let waiting; handlers[name]({waitUntil(value) { waiting = value; }}); await waiting; }
  async function request(url, {method = 'GET', mode = 'cors'} = {}) {
    let response; handlers.fetch({request: {url, method, mode}, respondWith(value) { response = value; }});
    return response ? await response : undefined;
  }
  async function status() {
    let waiting, result;
    handlers.message({data: {type: 'RESOURCE_SHELL_STATUS'}, ports: [{postMessage(value) { result = value; }}], waitUntil(value) { waiting = value; }});
    await waiting; return result;
  }
  return {context, storage, calls, lifecycle, request, status, counters: () => ({claims, skips}), setFailWrites: value => { failWrites = value; }};
}

test('worker code release changes for shell edits but remains stable for daily catalog refresh', async () => {
  const files = await fixture(), original = renderResourceWorker(files).toString();
  files.set('catalog.json', Buffer.from(JSON.stringify({schemaVersion: 1, project: 'fixture', title: 'Tomorrow', items: [], fetchedAt: '2030-01-01T00:00:00Z'})));
  assert.equal(renderResourceWorker(files).toString(), original);
  files.set('explorer.mjs', Buffer.from('export const changed = true;'));
  assert.notEqual(renderResourceWorker(files).toString(), original);
  assert.equal(publicResourceFiles.length, 11);
  assert.ok(!publicResourceFiles.some(file => /sources|cache|secret/.test(file)));
});

test('canonical install creates complete isolated offline shell and preserves main-app caches', async () => {
  const app = runtime(await fixture());
  app.storage.set('resource-library-shell:/resources/:old', new Map());
  app.storage.set('resource-library-shell:/elsewhere/:old', new Map());
  app.storage.set('avenquellis-offline:/:old', new Map());
  app.storage.set('vedaris-static:https://resource.example/:old', new Map());
  app.storage.set('stormsignal-v1', new Map());
  await app.lifecycle('install');
  assert.equal(app.calls.length, 10);
  assert.ok(app.calls.some(call => call.url === scope));
  assert.ok(app.calls.every(call => !call.url.endsWith('/index.html') && call.options.redirect === 'error' && call.options.credentials === 'omit'));
  assert.equal((await app.status()).ready, true);
  await app.lifecycle('activate');
  assert.equal(app.storage.has('resource-library-shell:/resources/:old'), true);
  for (const name of ['resource-library-shell:/elsewhere/:old', 'avenquellis-offline:/:old', 'vedaris-static:https://resource.example/:old', 'stormsignal-v1']) assert.ok(app.storage.has(name), name);
  assert.deepEqual(app.counters(), {claims: 1, skips: 0});
  app.context.fetch = async () => { throw new Error('Offline'); };
  assert.match(await (await app.request(scope, {mode: 'navigate'})).text(), /Library/);
  assert.match(await (await app.request(scope + 'index.html', {mode: 'navigate'})).text(), /Library/);
  assert.match(await (await app.request(scope + '?q=math', {mode: 'navigate'})).text(), /Library/);
  for (const file of publicResourceFiles.filter(file => !['offline-worker.js', 'index.html'].includes(file))) assert.equal((await app.request(scope + file)).status, 200, file);
});

test('worker ignores external metadata, APIs, writes and every non-allowlisted path', async () => {
  const app = runtime(await fixture());
  for (const url of [origin + '/', origin + '/api/resources', scope + 'sources.json', scope + '.cache.json', scope + 'anything.js', scope + 'explorer.mjs?private=1', 'https://raw.githubusercontent.com/owner/repo/main/resources/catalog.json']) assert.equal(await app.request(url), undefined, url);
  assert.equal(await app.request(scope, {method: 'POST', mode: 'navigate'}), undefined);
  assert.equal(await app.request(scope + 'catalog.json', {method: 'DELETE'}), undefined);
});

test('invalid or incomplete installation cannot replace a working offline shell', async () => {
  const files = await fixture(), app = runtime(files);
  app.storage.set('resource-library-shell:/resources/:previous', new Map([[scope, new Response('Previous')]]));
  files.set('explorer.mjs', Buffer.from('Unexpected deployment'));
  await assert.rejects(app.lifecycle('install'), /Shell (release mismatch|byte budget exceeded)/);
  assert.deepEqual([...app.storage.keys()], ['resource-library-shell:/resources/:previous']);
  assert.equal((await app.status()).ready, false);
  const quota = runtime(await fixture()); quota.setFailWrites(true);
  await assert.rejects(quota.lifecycle('install'), /Quota/);
  assert.equal((await quota.status()).ready, false);
});

test('evicted shell assets recover only from the correct version and readiness detects eviction', async () => {
  const files = await fixture(), app = runtime(files);
  await app.lifecycle('install');
  const cache = [...app.storage.values()][0]; cache.delete(scope + 'live.mjs');
  assert.equal((await app.status()).ready, false);
  const original = files.get('live.mjs'); files.set('live.mjs', Buffer.from('New incompatible module'));
  assert.equal((await app.request(scope + 'live.mjs')).status, 503);
  assert.equal(cache.has(scope + 'live.mjs'), false);
  files.set('live.mjs', original);
  assert.equal((await app.request(scope + 'live.mjs')).status, 200);
  assert.equal((await app.status()).ready, true);
});

test('missing-asset fallback bounds stalled fetch and stalled body even when cancellation hangs', async () => {
  for (const stalledBody of [false, true]) {
    const app = runtime(await fixture(), {timeout: 20});
    app.context.fetch = async () => stalledBody
      ? new Response(new ReadableStream({start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { return new Promise(() => {}); }}), {headers: {'Content-Type': 'text/javascript'}})
      : new Promise(() => {});
    const started = performance.now();
    assert.equal((await app.request(scope + 'live.mjs')).status, 503);
    assert.ok(performance.now() - started < 500, 'Fallback exceeded its whole-transfer deadline');
  }
});

function activeRegistration({ready = true, returnedScope = scope} = {}) {
  const worker = {state: 'activated', scriptURL: scope + 'offline-worker.js', postMessage(message, [port]) {
    port.postMessage({type: message.type, ready, version: 'fixture-version', scope: returnedScope});
  }};
  return {scope, active: worker};
}

test('main-page registration checks its own narrow worker instead of root serviceWorker.ready', async () => {
  let called;
  const serviceWorker = {get ready() { throw new Error('Must not inspect the main app registration'); }, async register(url, options) { called = {url, options}; return activeRegistration(); }};
  const result = await ensureOfflineShell({serviceWorker, origin, timeoutMs: 100});
  assert.equal(result.available, true);
  assert.equal(result.scope, scope);
  assert.deepEqual(called, {url: scope + 'offline-worker.js', options: {scope: '/resources/', updateViaCache: 'none'}});
});

test('offline helper never claims readiness from unrelated, incomplete, unavailable or stalled storage', async () => {
  for (const registration of [activeRegistration({ready: false}), activeRegistration({returnedScope: origin + '/'}), {...activeRegistration(), scope: origin + '/'}]) {
    assert.equal((await ensureOfflineShell({serviceWorker: {register: async () => registration}, origin, timeoutMs: 100})).available, false);
  }
  assert.equal((await ensureOfflineShell({serviceWorker: undefined, origin})).available, false);
  assert.equal((await ensureOfflineShell({serviceWorker: {register: async () => { throw new Error('Denied'); }}, origin})).available, false);
  const start = performance.now();
  assert.equal((await ensureOfflineShell({serviceWorker: {register: () => new Promise(() => {})}, origin, timeoutMs: 20})).available, false);
  assert.ok(performance.now() - start < 500);
});
