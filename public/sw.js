const VERSION = 'stormsignal-v1';
const BUILD_ASSETS = [];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(['/', '/preparedness.html', '/favicon.svg', ...BUILD_ASSETS])),
  );
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('stormsignal-') && k !== VERSION)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
// Only the app shell is cached. External weather, satellite and warning data are never served as live from this cache.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const shellPath =
    ['/', '/index.html', '/preparedness.html', '/favicon.svg'].includes(url.pathname) ||
    url.pathname.startsWith('/assets/');
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.search ||
    !shellPath
  )
    return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && !response.redirected) {
          const copy = response.clone();
          event.waitUntil(caches.open(VERSION).then((cache) => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(async () => {
        // All matched paths are this public, versioned app shell. Ignore transport-only Vary headers (e.g. Origin) on precached module assets.
        const cached = await caches.match(event.request, { ignoreVary: true });
        if (cached) return cached;
        if (event.request.mode === 'navigate') return (await caches.match('/')) || Response.error();
        return Response.error();
      }),
  );
});
