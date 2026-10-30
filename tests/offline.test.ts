import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function harness() {
  const events: Record<string, (e: any) => void> = {};
  let network = 0;
  const saved: string[] = [];
  let offline = false;
  const store = new Map<string, Response>();
  const key = (r: string | Request) => (typeof r === 'string' ? r : r.url);
  const caches = {
    open: async () => ({
      addAll: async (paths: string[]) => {
        saved.push(...paths);
      },
      put: async (r: Request, v: Response) => {
        store.set(key(r), v);
      },
    }),
    keys: async () => [],
    match: async (r: string | Request) => store.get(key(r)),
    delete: async () => true,
  };
  const fetch = async () => {
    network++;
    if (offline) throw Error('offline');
    return new Response('ok');
  };
  const self = {
    location: { origin: 'https://example.org' },
    addEventListener: (type: string, cb: any) => {
      events[type] = cb;
    },
    skipWaiting() {},
    clients: { claim() {} },
  };
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, caches, fetch, URL, Response });
  return {
    events,
    saved,
    network: () => network,
    setOffline: () => {
      offline = true;
    },
    store,
  };
}
test('service worker precaches self-contained preparedness', async () => {
  const h = harness();
  let pending: Promise<unknown> | undefined;
  h.events.install({ waitUntil: (p: Promise<unknown>) => (pending = p) });
  await pending;
  assert.ok(h.saved.includes('/preparedness.html'));
});
test('service worker never intercepts remote feeds, private endpoints, arbitrary paths or query-bearing requests', () => {
  const h = harness();
  for (const url of [
    'https://api.weather.gov/alerts',
    'https://example.org/api/forecast',
    'https://example.org/auth/callback',
    'https://example.org/?token=private',
    'https://example.org/private-document',
  ]) {
    let intercepted = false;
    h.events.fetch({
      request: new Request(url),
      respondWith: () => (intercepted = true),
      waitUntil() {},
    });
    assert.equal(intercepted, false, url);
  }
});
test('offline preparedness document is served from cache', async () => {
  const h = harness();
  h.setOffline();
  h.store.set('https://example.org/preparedness.html', new Response('offline checklist'));
  let response: Promise<Response> | undefined;
  h.events.fetch({
    request: new Request('https://example.org/preparedness.html'),
    respondWith: (p: Promise<Response>) => (response = p),
    waitUntil() {},
  });
  assert.equal(await (await response!)?.text(), 'offline checklist');
});
