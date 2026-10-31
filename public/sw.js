const VERSION = 'stormsignal-v1';
// Vite fills these lists. Only static entry dependencies are downloaded during
// installation; optional map/report chunks are cached only if actually opened.
const BUILD_ASSETS = [];
const OPTIONAL_ASSETS = [];
const DOCUMENTS = ['/', '/preparedness.html', '/offline.html'];
const STATIC_FILES = ['/favicon.svg', '/icon.svg', '/manifest.webmanifest'];
const ALLOWED_ASSETS = new Set([...BUILD_ASSETS, ...OPTIONAL_ASSETS, ...STATIC_FILES]);
const HASHED_SCRIPT_OR_STYLE = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/;
const DOCUMENT_ALIASES = new Map([
  ['/', '/'],
  ['/index.html', '/'],
  ['/offline', '/offline.html'],
  ['/offline.html', '/offline.html'],
  ['/preparedness', '/preparedness.html'],
  ['/preparedness.html', '/preparedness.html'],
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then(async (cache) => {
      // addAll commits as one batch. An incomplete install cannot replace the
      // active worker or report a new offline kit as ready.
      await cache.addAll([...DOCUMENTS, ...STATIC_FILES, ...BUILD_ASSETS]);
      await self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      // Keep one previous shell while already-open tabs finish their old build.
      const older = keys.filter((key) => key.startsWith('stormsignal-') && key !== VERSION);
      await Promise.all(older.slice(0, -1).map((key) => caches.delete(key)));
      await self.clients.claim();
    }),
  );
});

// An old active worker can satisfy navigator.serviceWorker.ready during an
// update. Let the UI confirm that this build's complete offline kit exists.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'STORMSIGNAL_OFFLINE_STATUS' || !event.ports?.[0]) return;
  event.waitUntil(
    (async () => {
      const paths = [...DOCUMENTS, ...STATIC_FILES, ...BUILD_ASSETS];
      let ready = false;
      try {
        const cache = await caches.open(VERSION);
        ready = (
          await Promise.all(paths.map((path) => cache.match(path, { ignoreVary: true })))
        ).every(Boolean);
      } catch {
        /* Browser storage may have been evicted or disabled. */
      }
      event.ports[0].postMessage({
        type: 'STORMSIGNAL_OFFLINE_STATUS',
        ready,
        version: VERSION,
        assetCount: paths.length,
      });
    })(),
  );
});

async function readCache(path) {
  try {
    const cache = await caches.open(VERSION);
    const response = await cache.match(path, { ignoreVary: true });
    if (
      response?.redirected &&
      DOCUMENTS.includes(path) &&
      new URL(response.url).origin === self.location.origin
    ) {
      // Some static hosts redirect /offline.html to /offline during addAll.
      // A followed-redirect Response cannot satisfy a navigation request whose
      // redirect mode is "manual". Keep the document, not its redirect history.
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  } catch {
    return undefined;
  }
}

async function fetchWithin(request, milliseconds) {
  const controller = new AbortController();
  let timer;
  try {
    // Race explicitly: not every network failure rejects fetch promptly.
    return await Promise.race([
      fetch(request, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Shell request timed out'));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cachedAsset(event, path) {
  const cached = await readCache(path);
  if (cached) return cached;
  try {
    const response = await fetchWithin(event.request, 8000);
    if (response.ok && !response.redirected) {
      const copy = response.clone();
      // Quota/private-mode failures must not discard a successful download.
      event.waitUntil(
        caches
          .open(VERSION)
          .then((cache) => cache.put(path, copy))
          .catch(() => {}),
      );
    }
    return response;
  } catch {
    return Response.error();
  }
}

async function previousBuildAsset(request, path) {
  // A newly activated worker can control a tab still using the previous HTML.
  // Reuse only exact cached build files; never revive documents or provider data.
  try {
    const names = (await caches.keys()).filter(
      (name) => name.startsWith('stormsignal-') && name !== VERSION,
    );
    for (const name of names.reverse()) {
      const previous = await caches.open(name);
      const response = await previous.match(path, { ignoreVary: true });
      if (response) return response;
    }
  } catch {
    /* Disabled or evicted storage must not prevent a normal network request. */
  }
  // The request may instead belong to an upcoming deployment. Preserve normal
  // network loading, without adding unknown files to this build's cache.
  try {
    return await fetchWithin(request, 8000);
  } catch {
    return Response.error();
  }
}

async function dashboard(request) {
  try {
    const response = await fetchWithin(request, 3000);
    if (response.ok && !response.redirected) return response;
    return (await readCache('/')) || response;
  } catch {
    return (await readCache('/')) || Response.error();
  }
  // Never overwrite this version's HTML with a newer deployment. Its worker
  // must install new hashed dependencies before the offline shell is replaced.
}

// Never intercept remote feeds, query-bearing URLs, private/API routes or writes.
// Weather snapshots are explicit local records managed by the app, not this cache.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  const documentPath = DOCUMENT_ALIASES.get(url.pathname);
  if (documentPath === '/') event.respondWith(dashboard(event.request));
  else if (documentPath || ALLOWED_ASSETS.has(url.pathname))
    event.respondWith(cachedAsset(event, documentPath || url.pathname));
  else if (HASHED_SCRIPT_OR_STYLE.test(url.pathname))
    event.respondWith(previousBuildAsset(event.request, url.pathname));
});
