import assert from 'node:assert/strict';
import { test } from 'node:test';
import pages from '../server/pages';
import { clearWarningCache, pendingReads } from '../server/http';

const env = {
  ASSETS: {
    async fetch(): Promise<Response> {
      throw new Error('An API request must not fall back to a static file');
    },
  },
};
const registry = JSON.stringify({
  sources: [
    {
      source: {
        authorityCountry: 'de',
        sourceIsOfficial: true,
        capAlertFeedStatus: 'operating',
        sourceId: 'de-dwd-en',
        memID: '71',
        byLanguage: [{ code: 'en', name: 'DWD' }],
      },
    },
  ],
});
const berlin = 'https://stormsignal.invalid/api/alerts?lat=52.52&lon=13.405&country=DE&name=Berlin';
const turns = async (count: number) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Workers cancel a request's timers and subrequests once its client has gone or its response has
// been sent, unless they are covered by ctx.waitUntil; cancelled code never resumes, so neither a
// shared read (http.ts) nor the check's admission release (router.ts) would ever settle. Node never
// cancels, so this checks the contract the runtime relies on.
test('the Pages entry keeps a check its client left, and the shared reads it started, alive', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let reads = 0;
  let answer = () => {};
  const originalFetch = globalThis.fetch;
  // The WMO point lookup waits until released, as when WMO is slow.
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/json/sources.json')) return new Response(registry);
    if (url.includes('/f/ows/')) {
      reads++;
      return new Promise<Response>((resolve) => {
        answer = () =>
          resolve(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] })));
      });
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  };
  clearWarningCache();
  const kept: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void kept.push(promise) };
  const headers = { 'CF-Connecting-IP': '198.51.100.7' };
  try {
    const client = new AbortController();
    const response = pages.fetch(new Request(berlin, { headers, signal: client.signal }), env, ctx);
    for (let i = 0; i < 200 && !reads; i++) await turns(1);
    assert.equal(reads, 1);
    assert.equal(kept.length, 1, 'the running check is handed to ctx.waitUntil');
    let settled = false;
    void kept[0].then(() => (settled = true));
    // The visitor chooses another place while the point lookup is running.
    client.abort();
    assert.equal((await response).status, 503);
    await turns(20);
    assert.equal(pendingReads(), 1, 'the shared read continues for other callers');
    assert.equal(settled, false, 'the invocation outlives the shared read it started');
    answer();
    await kept[0];
    assert.equal(pendingReads(), 0, 'no shared read outlives the promise given to waitUntil');
    // The read was allowed to finish and is kept: a repeat needs no second upstream read.
    const repeat = await pages.fetch(new Request(berlin, { headers }), env, ctx);
    assert.equal(repeat.status, 200);
    assert.equal(reads, 1);
    await Promise.all(kept);
  } finally {
    answer();
    await Promise.allSettled(kept);
    globalThis.fetch = originalFetch;
    clearWarningCache();
  }
});

// scripts/verify-pages.mjs, the preview and the live check call the entry without a context.
test('the Pages entry answers without an execution context', async () => {
  const invalid = await pages.fetch(
    new Request('https://stormsignal.invalid/api/alerts?lat=bad&lon=0&country=US'),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.equal(
    (await pages.fetch(new Request('https://stormsignal.invalid/api/unknown'), env)).status,
    404,
  );
});
