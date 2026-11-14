/* Public resource page only. The staging script supplies a complete shell inventory. */
const VERSION = /* RESOURCE_SHELL_VERSION */ 'development';
const PROJECT = /* RESOURCE_PROJECT */ '';
const INVENTORY = /* RESOURCE_SHELL_MANIFEST */ [];
const SCOPE = new URL(self.registration.scope);
const PREFIX = 'resource-library-shell:' + SCOPE.pathname + ':';
const CACHE = PREFIX + VERSION;
const MAX_CATALOG_BYTES = 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 8000;
const ASSETS = new Map(INVENTORY.map(asset => [new URL(asset.file === 'index.html' ? './' : asset.file, SCOPE).href, asset]));
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

async function verifiedAsset(url, asset) {
  const controller = new AbortController();
  let reader, response, timer;
  const cancel = () => {
    controller.abort();
    try { reader?.cancel().catch(() => {}); } catch {}
    try { response?.body?.cancel().catch(() => {}); } catch {}
  };
  const transfer = (async () => {
    try {
      // The canonical directory URL avoids Pages' /index.html redirect.
      response = await fetch(url, {credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal});
      controller.signal.throwIfAborted();
      if (response.status !== 200 || response.redirected || response.type === 'opaque' || (response.url && response.url !== url)) throw new Error('Unexpected shell response');
      const type = response.headers.get('content-type') || '';
      const expectedType = asset.file.endsWith('.html') ? /text\/html/i : asset.file.endsWith('.css') ? /text\/css/i : asset.file.endsWith('.json') ? /application\/json/i : /(?:text|application)\/(?:javascript|x-javascript|ecmascript)/i;
      if (!expectedType.test(type)) throw new Error('Unexpected shell content type');
      const maximum = asset.sha256 ? asset.bytes : MAX_CATALOG_BYTES;
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error('Shell byte budget exceeded');
      if (!response.body) throw new Error('Empty shell response');
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const {done, value} = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) throw new Error('Shell byte budget exceeded');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (asset.sha256) {
        if (size !== asset.bytes || await digest(bytes) !== asset.sha256) throw new Error('Shell release mismatch');
      } else {
        const catalog = JSON.parse(new TextDecoder().decode(bytes));
        if (catalog?.schemaVersion !== 1 || catalog.project !== PROJECT || !Array.isArray(catalog.items)) throw new Error('Invalid bundled collection');
      }
      controller.signal.throwIfAborted();
      const headers = new Headers(response.headers);
      headers.delete('Content-Encoding'); headers.delete('Transfer-Encoding');
      headers.set('Content-Length', String(size));
      return new Response(bytes, {status: 200, headers});
    } catch (error) { cancel(); throw error; }
  })();
  try {
    return await Promise.race([transfer, new Promise((_, reject) => {
      timer = setTimeout(() => { cancel(); reject(new Error('Shell request timed out')); }, TRANSFER_TIMEOUT_MS);
    })]);
  } finally {
    clearTimeout(timer);
    try { reader?.releaseLock(); } catch {}
  }
}

async function shellReady() {
  try {
    if (!ASSETS.size || !await caches.has(CACHE)) return false;
    const cache = await caches.open(CACHE);
    return (await Promise.all([...ASSETS.keys()].map(url => cache.match(url)))).every(Boolean);
  } catch { return false; }
}

self.addEventListener('install', event => event.waitUntil((async () => {
  if (SCOPE.pathname !== '/resources/' || ASSETS.size !== 9) throw new Error('Invalid resource shell scope or inventory');
  try {
    const responses = await Promise.all([...ASSETS].map(async ([url, asset]) => [url, await verifiedAsset(url, asset)]));
    const cache = await caches.open(CACHE);
    await Promise.all(responses.map(([url, response]) => cache.put(url, response)));
  } catch (error) { await caches.delete(CACHE).catch(() => {}); throw error; }
  // Existing resource tabs keep their current code until closed. No skipWaiting.
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
  // This registration's narrow scope never takes control of the main application.
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin) return;
  const navigation = request.mode === 'navigate' && (url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + 'index.html');
  if (!navigation && url.search) return;
  const key = navigation ? SCOPE.href : url.href;
  const asset = ASSETS.get(key);
  if (!asset) return; // No private files, APIs, remote GitHub metadata, or arbitrary paths.
  event.respondWith((async () => {
    let cache;
    try { cache = await caches.open(CACHE); const saved = await cache.match(key); if (saved) return saved; } catch {}
    try {
      const response = await verifiedAsset(key, asset);
      if (cache) { try { await cache.put(key, response.clone()); } catch {} }
      return response;
    } catch {
      return new Response('The resource page is not saved on this device yet. Reconnect and reopen it.', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'}});
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'RESOURCE_SHELL_STATUS' || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    event.ports[0].postMessage({type: 'RESOURCE_SHELL_STATUS', ready: await shellReady(), version: VERSION, scope: SCOPE.href});
  })());
});
