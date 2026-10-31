import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import vm from 'node:vm';

type EventHandler = (event: any) => void;
function harness(origin = 'https://example.org') {
  const events: Record<string, EventHandler> = {};
  const store = new Map<string, Response>();
  const stores = new Map<string, Map<string, Response>>([
    ['stormsignal-ancient', new Map()],
    ['unrelated-app', new Map()],
    ['stormsignal-previous', new Map()],
    ['stormsignal-v1', store],
  ]);
  const saved: string[] = [],
    deleted: string[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0,
    requests = 0,
    skipped = 0,
    claimed = 0,
    aborted = 0;
  let mode: 'online' | 'offline' | 'hang' | 'error' = 'online';
  let quota = false,
    installFailure = false,
    cacheUnavailable = false;
  const key = (request: string | Request) =>
    new URL(typeof request === 'string' ? request : request.url, origin).href;
  const caches = {
    open: async (name: string) => {
      if (cacheUnavailable) throw Error('storage unavailable');
      if (!stores.has(name)) stores.set(name, new Map());
      const contents = stores.get(name)!;
      return {
        addAll: async (paths: string[]) => {
          if (installFailure) throw Error('failed critical asset');
          saved.push(...paths);
          for (const path of paths) contents.set(key(path), new Response(`cached ${path}`));
        },
        match: async (request: string | Request) => contents.get(key(request))?.clone(),
        put: async (request: string | Request, response: Response) => {
          if (quota) throw Error('quota exceeded');
          contents.set(key(request), response);
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => {
      deleted.push(name);
      return stores.delete(name);
    },
  };
  const fetch = async (_request: Request, options: { signal: AbortSignal }) => {
    requests++;
    options.signal.addEventListener('abort', () => aborted++);
    if (mode === 'offline') throw Error('offline');
    if (mode === 'hang') return new Promise<Response>(() => {});
    if (mode === 'error') return new Response('provider error', { status: 503 });
    return new Response('network document');
  };
  const self = {
    location: { origin },
    addEventListener: (type: string, callback: EventHandler) => {
      events[type] = callback;
    },
    skipWaiting: async () => {
      skipped++;
    },
    clients: {
      claim: async () => {
        claimed++;
      },
    },
  };
  const source = readFileSync('public/sw.js', 'utf8')
    .replace(
      'const BUILD_ASSETS = [];',
      "const BUILD_ASSETS = ['/assets/main-a1.js', '/assets/main-a1.css'];",
    )
    .replace(
      'const OPTIONAL_ASSETS = [];',
      "const OPTIONAL_ASSETS = ['/assets/WeatherMap-b2.js'];",
    );
  vm.runInNewContext(source, {
    self,
    caches,
    fetch,
    URL,
    Response,
    AbortController,
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  });
  function dispatch(path: string, method = 'GET', redirect: RequestRedirect = 'follow') {
    let response: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    events.fetch({
      request: new Request(new URL(path, origin), { method, redirect }),
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
      waitUntil: (value: Promise<unknown>) => {
        pending.push(value);
      },
    });
    return {
      response,
      done: async () => {
        const value = await response;
        await Promise.all(pending);
        return value;
      },
    };
  }
  async function lifecycle(type: string) {
    const pending: Promise<unknown>[] = [];
    events[type]({
      waitUntil: (value: Promise<unknown>) => {
        pending.push(value);
      },
    });
    await Promise.all(pending);
  }
  return {
    dispatch,
    lifecycle,
    saved,
    deleted,
    timers,
    status: async () => {
      let reply: any;
      let pending: Promise<unknown> | undefined;
      events.message({
        data: { type: 'STORMSIGNAL_OFFLINE_STATUS' },
        ports: [
          {
            postMessage: (value: unknown) => {
              reply = value;
            },
          },
        ],
        waitUntil: (value: Promise<unknown>) => {
          pending = value;
        },
      });
      await pending;
      return reply;
    },
    counts: () => ({ requests, skipped, claimed, aborted }),
    setMode: (value: typeof mode) => {
      mode = value;
    },
    setQuota: () => {
      quota = true;
    },
    failInstall: () => {
      installFailure = true;
    },
    failCache: () => {
      cacheUnavailable = true;
    },
    put: (path: string, content: string) => store.set(key(path), new Response(content)),
    putResponse: (path: string, response: Response) => store.set(key(path), response),
    putInCache: (name: string, path: string, content: string) =>
      stores.get(name)!.set(key(path), new Response(content)),
    get: async (path: string) => store.get(key(path))?.clone().text(),
    fireTimers: () => {
      for (const timer of [...timers.values()]) timer.callback();
    },
  };
}

// Use a real followed redirect so clone() preserves the native Response URL and
// redirected metadata that Cache.addAll saves on clean-URL static hosting.
async function withRedirectedDocument(run: (origin: string, response: Response) => Promise<void>) {
  const server = createServer((request, response) => {
    if (request.url === '/offline.html') {
      response.writeHead(307, { Location: '/offline' }).end();
    } else {
      response.writeHead(200, 'OK', {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Kit-Version': 'test-kit',
      });
      response.end('<!doctype html><h1>Emergency kit</h1>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/offline.html`);
    assert.equal(response.redirected, true);
    await run(origin, response);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('offline installation atomically precaches core and standalone kit, not optional map code', async () => {
  const h = harness();
  await h.lifecycle('install');
  for (const path of [
    '/',
    '/preparedness.html',
    '/offline.html',
    '/manifest.webmanifest',
    '/icon.svg',
    '/assets/main-a1.js',
  ])
    assert.ok(h.saved.includes(path), path);
  assert.ok(!h.saved.includes('/assets/WeatherMap-b2.js'));
  assert.equal(h.counts().skipped, 1);
});

test('failed installation cannot activate a partially downloaded offline shell', async () => {
  const h = harness();
  h.failInstall();
  await assert.rejects(h.lifecycle('install'), /failed critical asset/);
  assert.equal(h.counts().skipped, 0);
  assert.equal(h.saved.length, 0);
});

test('offline readiness confirms every critical file, not just an active worker', async () => {
  const h = harness();
  assert.equal((await h.status()).ready, false);
  h.put('/', 'shell without kit');
  assert.equal((await h.status()).ready, false);
  await h.lifecycle('install');
  const status = await h.status();
  assert.equal(status.ready, true);
  assert.equal(status.version, 'stormsignal-v1');
  assert.equal(status.assetCount, h.saved.length);
});

test('activation retains previous shell and unrelated applications', async () => {
  const h = harness();
  await h.lifecycle('activate');
  assert.deepEqual(h.deleted, ['stormsignal-ancient']);
  assert.equal(h.counts().claimed, 1);
});

test('worker never intercepts remote feeds, API/private/arbitrary assets, query strings or writes', () => {
  const h = harness();
  for (const path of [
    'https://api.weather.gov/alerts',
    '/api/forecast',
    '/auth/callback',
    '/?token=private',
    '/offline.html?token=private',
    '/private-document',
    '/assets/private.json',
    '/assets/private.js',
    '/assets/main-Ab123456.js?token=private',
    '/assets/main-a1.js?token=private',
  ])
    assert.equal(h.dispatch(path).response, undefined, path);
  assert.equal(h.dispatch('/', 'POST').response, undefined);
});

test('cached immutable assets and standalone documents require zero network requests', async () => {
  const h = harness();
  h.put('/assets/main-a1.js', 'script');
  h.put('/offline.html', 'kit');
  h.put('/preparedness.html', 'checklist');
  for (const [path, expected] of [
    ['/assets/main-a1.js', 'script'],
    ['/offline.html', 'kit'],
    ['/offline', 'kit'],
    ['/preparedness', 'checklist'],
  ])
    assert.equal(await (await h.dispatch(path).done())?.text(), expected);
  assert.equal(h.counts().requests, 0);
});

test('cached clean-URL documents satisfy manual-redirect navigation without losing body or headers', async () => {
  await withRedirectedDocument(async (origin, response) => {
    const h = harness(origin);
    h.putResponse('/offline.html', response);
    h.setMode('offline');
    for (const path of ['/offline.html', '/offline']) {
      const result = await h.dispatch(path, 'GET', 'manual').done();
      assert.ok(result);
      assert.equal(result.redirected, false);
      assert.equal(result.status, 200);
      assert.equal(result.statusText, 'OK');
      assert.equal(result.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(result.headers.get('x-kit-version'), 'test-kit');
      assert.equal(await result.text(), '<!doctype html><h1>Emergency kit</h1>');
    }
    assert.equal(h.counts().requests, 0);
  });
});

test('the cached root fallback also removes same-origin redirect history', async () => {
  await withRedirectedDocument(async (origin, response) => {
    const h = harness(origin);
    h.putResponse('/', response);
    h.setMode('offline');
    const result = await h.dispatch('/', 'GET', 'manual').done();
    assert.ok(result);
    assert.equal(result.redirected, false);
    assert.equal(result.headers.get('x-kit-version'), 'test-kit');
    assert.equal(await result.text(), '<!doctype html><h1>Emergency kit</h1>');
  });
});

test('redirect normalization is limited to same-origin cached documents', async () => {
  await withRedirectedDocument(async (origin, response) => {
    const sameOrigin = harness(origin);
    sameOrigin.putResponse('/assets/main-a1.js', response.clone());
    assert.equal((await sameOrigin.dispatch('/assets/main-a1.js').done())?.redirected, true);
    const otherOrigin = harness();
    otherOrigin.putResponse('/offline.html', response);
    assert.equal((await otherOrigin.dispatch('/offline.html').done())?.redirected, true);
  });
});

test('optional map code is cached only after an explicit request', async () => {
  const h = harness();
  assert.equal(
    await (await h.dispatch('/assets/WeatherMap-b2.js').done())?.text(),
    'network document',
  );
  assert.equal(await h.get('/assets/WeatherMap-b2.js'), 'network document');
  h.setMode('offline');
  assert.equal(
    await (await h.dispatch('/assets/WeatherMap-b2.js').done())?.text(),
    'network document',
  );
  assert.equal(h.counts().requests, 1);
});

test('an updated worker serves old cached hashed chunks to an already-open tab offline', async () => {
  const h = harness();
  for (const path of ['/assets/WeatherMap-Ab123456.js', '/assets/WeatherMap-Ab123456.css'])
    h.putInCache('stormsignal-previous', path, `previous ${path}`);
  await h.lifecycle('activate');
  h.setMode('offline');
  for (const path of ['/assets/WeatherMap-Ab123456.js', '/assets/WeatherMap-Ab123456.css']) {
    assert.equal(await (await h.dispatch(path).done())?.text(), `previous ${path}`);
    assert.equal(await h.get(path), undefined, 'do not move old files into the new build');
  }
  assert.equal(h.counts().requests, 0);
});

test('unknown upcoming build chunks use the network without entering this build cache', async () => {
  const h = harness();
  const path = '/assets/upcoming-Ab123456.js';
  assert.equal(await (await h.dispatch(path).done())?.text(), 'network document');
  assert.equal(await h.get(path), undefined);
  assert.equal(h.counts().requests, 1);
  assert.equal(h.timers.size, 0);
});

test('old build recovery never reads a different application cache', async () => {
  const h = harness();
  const path = '/assets/another-App12345.js';
  h.putInCache('unrelated-app', path, 'another application data');
  h.setMode('offline');
  assert.equal((await h.dispatch(path).done())?.type, 'error');
  assert.equal(h.counts().requests, 1);
});

test('unknown build chunks still load when previous CacheStorage is unavailable', async () => {
  const h = harness();
  h.failCache();
  assert.equal(
    await (await h.dispatch('/assets/upcoming-Ab123456.js').done())?.text(),
    'network document',
  );
  assert.equal(h.timers.size, 0);
});

test('successful network response survives cache quota failures', async () => {
  const h = harness();
  h.setQuota();
  assert.equal(await (await h.dispatch('/assets/main-a1.js').done())?.text(), 'network document');
  assert.equal(await h.get('/assets/main-a1.js'), undefined);
  assert.equal(h.timers.size, 0);
});

test('successful network response survives unavailable CacheStorage', async () => {
  const h = harness();
  h.failCache();
  assert.equal(await (await h.dispatch('/assets/main-a1.js').done())?.text(), 'network document');
});

test('offline index aliases reopen the cached dashboard', async () => {
  const h = harness();
  h.setMode('offline');
  h.put('/', 'cached dashboard');
  for (const path of ['/', '/index.html'])
    assert.equal(await (await h.dispatch(path).done())?.text(), 'cached dashboard');
  assert.equal(h.timers.size, 0);
});

test('a hanging dashboard request falls back after 3 seconds and aborts its transfer', async () => {
  const h = harness();
  h.setMode('hang');
  h.put('/', 'cached dashboard');
  const pending = h.dispatch('/');
  assert.deepEqual(
    [...h.timers.values()].map((timer) => timer.delay),
    [3000],
  );
  h.fireTimers();
  assert.equal(await (await pending.done())?.text(), 'cached dashboard');
  assert.equal(h.counts().aborted, 1);
  assert.equal(h.timers.size, 0);
});

test('server errors prefer the installed dashboard instead of breaking offline readiness', async () => {
  const h = harness();
  h.setMode('error');
  h.put('/', 'stable shell');
  assert.equal(await (await h.dispatch('/').done())?.text(), 'stable shell');
});

test('new online HTML never overwrites the installed shell with mismatched hashed dependencies', async () => {
  const h = harness();
  h.put('/', 'old matching shell');
  assert.equal(await (await h.dispatch('/').done())?.text(), 'network document');
  assert.equal(await h.get('/'), 'old matching shell');
  h.setMode('offline');
  assert.equal(await (await h.dispatch('/').done())?.text(), 'old matching shell');
});

test('missing offline shell fails honestly instead of manufacturing live data', async () => {
  const h = harness();
  h.setMode('offline');
  assert.equal((await h.dispatch('/').done())?.type, 'error');
});

test('manifest uses local assets and provides an offline-kit shortcut', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.shortcuts[0].url, '/offline.html');
  assert.ok(
    manifest.icons.every(
      (icon: { src: string }) => icon.src.startsWith('/') && !icon.src.startsWith('//'),
    ),
  );
});
