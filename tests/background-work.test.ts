import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import {
  MODULE_RETRY_MS,
  createBackgroundWork,
  modeChoiceEndsPageAlerts,
  resourceModuleUrl,
  type BackgroundModule,
} from '../src/background-work';
import { networkPolicy } from '../src/connectivity';
// @ts-expect-error Shared native ESM resource-library module.
import * as background from '../resources/background.mjs';
// @ts-expect-error Shared native ESM resource-library module.
import { LIVE_CATALOG_URL } from '../resources/catalog.mjs';

const ORIGIN = 'https://stormsignal.example';
const RELEASE = 'a'.repeat(64);
const MINUTE = 60_000;
const VERSION_CHECK = `${ORIGIN}/app-version.json`;
const BUNDLED_CATALOG = `${ORIGIN}/resources/catalog.json`;
const LIBRARY_WORKER = `${ORIGIN}/resources/offline-worker.js scope=/resources/`;

function eventTarget() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  return {
    addEventListener(type: string, listener: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: any) => void) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, event: object = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, ...event });
    },
  };
}

/**
 * A dashboard page for the real resource-library modules. It records the modules, requests and
 * worker registrations the page asks for; nothing reaches the network. The release it serves is the
 * one the page already runs, and its workers are installed, so an update check ends as "current".
 */
/** `githubDelayMs` makes GitHub answer that long after a request, unless it is aborted first. */
function dashboard(t: TestContext, { githubDelayMs = 0 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const loads: number[] = [];
  const requests: string[] = [];
  const registrations: string[] = [];
  const catalog = readFileSync('resources/catalog.json', 'utf8');
  const release = JSON.stringify({
    schemaVersion: 1,
    project: 'stormsignal',
    version: RELEASE,
    workers: [
      { scope: '/', script: '/sw.js', version: RELEASE },
      { scope: '/resources/', script: '/resources/offline-worker.js', version: RELEASE },
    ],
  });
  const fetch = async (input: string | URL, init: { signal?: AbortSignal } = {}) => {
    // The bundled collection is addressed relative to its module, a file in this test.
    const url = String(input).replace(/^file:.*\/resources\//, `${ORIGIN}/resources/`);
    requests.push(url);
    if (url === LIVE_CATALOG_URL && githubDelayMs)
      await new Promise<void>((resolve, reject) => {
        const answer = setTimeout(resolve, githubDelayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(answer);
          reject(new DOMException('The request was aborted', 'AbortError'));
        });
      });
    if (url === VERSION_CHECK) return new Response(release);
    if (url === BUNDLED_CATALOG || url === LIVE_CATALOG_URL) return new Response(catalog);
    return new Response('Not found', { status: 404 });
  };
  const worker = (script: string, reply: object) => ({
    state: 'activated',
    scriptURL: script,
    addEventListener() {},
    removeEventListener() {},
    postMessage(_message: unknown, ports: MessagePort[]) {
      ports[0].postMessage(reply);
    },
  });
  const serviceWorker = {
    ...eventTarget(),
    async register(script: string, options: { scope: string }) {
      registrations.push(`${script} scope=${options.scope}`);
      const scope = new URL(options.scope, ORIGIN).href;
      const status = { type: 'RESOURCE_SHELL_STATUS', scope, ready: true, version: 'shell' };
      return { scope, installing: null, waiting: null, active: worker(script, status) };
    },
    async getRegistration(scope: string) {
      const script = new URL(scope).pathname === '/' ? '/sw.js' : '/resources/offline-worker.js';
      const status = { type: 'APP_UPDATE_STATUS', scope, version: RELEASE, ready: true };
      return {
        scope,
        installing: null,
        waiting: null,
        update: async () => {},
        active: worker(ORIGIN + script, status),
      };
    },
  };
  const meta: Record<string, string> = {
    'meta[name="app-version"]': RELEASE,
    'meta[name="app-project"]': 'stormsignal',
  };
  const document = {
    ...eventTarget(),
    visibilityState: 'visible',
    activeElement: null,
    getElementById: () => null,
    querySelector: (selector: string) => (meta[selector] ? { content: meta[selector] } : null),
    querySelectorAll: () => [],
  };
  const stored = new Map<string, string>();
  const window = {
    ...eventTarget(),
    location: { origin: ORIGIN, href: `${ORIGIN}/`, reload: () => assert.fail('No new release') },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
    // An idle dashboard: App allows an update when no search, lookup or drawer is in progress.
    appUpdateCanReload: () => true,
  };
  const page = {
    window,
    document,
    location: window.location,
    navigator: { onLine: true, serviceWorker },
    fetch,
    // Node's BroadcastChannel would keep the test process alive; browsers without one are supported.
    BroadcastChannel: undefined,
  };
  const browser = globalThis as Record<string, unknown>;
  const original = Object.keys(page).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(page))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete browser[name];
    }
  });
  /** Let every started request, worker message and promise finish. Timers do not advance. */
  const settle = async () => {
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    loads,
    registrations,
    load: async (attempt: number): Promise<BackgroundModule> => {
      loads.push(attempt);
      return background;
    },
    settle,
    /** The requests made since the last call, in a stable order. */
    requests: () => requests.splice(0).sort(),
    /** Keep the page open: its timers fire as the simulated minutes pass. */
    async stayOpen(minutes: number) {
      for (let minute = 0; minute < minutes; minute++) {
        t.mock.timers.tick(MINUTE);
        await settle();
      }
    },
    /** Everything that makes an open page check again, including a back/forward-cache restore. */
    async comeBack() {
      window.dispatch('pageshow', { persisted: true });
      window.dispatch('focus');
      window.dispatch('online');
      document.dispatch('visibilitychange');
      serviceWorker.dispatch('controllerchange');
      await settle();
    },
  };
}

// App passes its polling policy to setBackgroundWork: Full workspace while the browser is online.
for (const [name, mode, online] of [
  ['Data saver', 'lite', true],
  ['Offline only', 'offline', true],
  ['Full workspace without a connection', 'full', false],
] as const)
  test(`${name} starts no background work: no module, request or worker, however long the page is open`, async (t) => {
    const page = dashboard(t);
    const work = createBackgroundWork(page.load);
    work.set(networkPolicy(mode, online).polling);
    await page.settle();
    await page.comeBack();
    await page.stayOpen(31);
    assert.deepEqual(page.loads, [], 'no resource-library code is requested');
    assert.deepEqual(page.requests(), []);
    assert.deepEqual(page.registrations, []);
  });

test('loading resources/background.mjs starts nothing, so a dashboard shell saved by an earlier release makes no request', async (t) => {
  const page = dashboard(t);
  // Earlier releases loaded it with a script tag in every connection mode. The dashboard shell they
  // saved for offline use still does, and gets this file from the site: here a fresh copy of it.
  const entry = '../resources/background.mjs?saved-shell';
  await import(entry);
  await page.settle();
  await page.comeBack();
  await page.stayOpen(31);
  assert.deepEqual(page.requests(), []);
  assert.deepEqual(page.registrations, []);
});

test('Full workspace checks for a release and the resource collection, and saves the library offline', async (t) => {
  const page = dashboard(t);
  const work = createBackgroundWork(page.load);
  work.set(networkPolicy('full', true).polling);
  await page.settle();
  assert.deepEqual(page.loads, [0]);
  assert.deepEqual(page.requests(), [VERSION_CHECK, BUNDLED_CATALOG, LIVE_CATALOG_URL].sort());
  assert.deepEqual(page.registrations, [LIBRARY_WORKER]);
  await page.stayOpen(14);
  assert.deepEqual(page.requests(), [], 'neither check repeats within 15 minutes');
  await page.stayOpen(1);
  assert.deepEqual(page.requests(), [VERSION_CHECK, LIVE_CATALOG_URL].sort());
  assert.deepEqual(page.loads, [0], 'the modules are requested once');
  work.set(false);
});

test('leaving Full workspace stops background work without a reload, and returning resumes it', async (t) => {
  const page = dashboard(t);
  const work = createBackgroundWork(page.load);
  work.set(networkPolicy('full', true).polling);
  await page.settle();
  await page.stayOpen(1);
  page.requests();
  page.registrations.length = 0;

  work.set(networkPolicy('lite', true).polling);
  // The shared updater keeps its page listeners. None of them may start it again here, least of
  // all the one that resumes a page restored from the back/forward cache.
  await page.comeBack();
  await page.stayOpen(31);
  assert.deepEqual(page.requests(), [], 'Data saver does not poll');
  assert.deepEqual(page.registrations, []);

  work.set(networkPolicy('full', true).polling);
  await page.settle();
  assert.deepEqual(page.requests(), [VERSION_CHECK, LIVE_CATALOG_URL].sort());
  assert.deepEqual(page.registrations, [LIBRARY_WORKER]);
  assert.deepEqual(page.loads, [0], 'the modules already on the page are used again');

  work.set(networkPolicy('offline', true).polling);
  await page.comeBack();
  await page.stayOpen(31);
  assert.deepEqual(page.requests(), [], 'Offline only starts no request');
});

test('switching modes back and forth does not repeat the GitHub check before it is due', async (t) => {
  const page = dashboard(t);
  const work = createBackgroundWork(page.load);
  work.set(true);
  await page.settle();
  assert.deepEqual(page.requests(), [VERSION_CHECK, BUNDLED_CATALOG, LIVE_CATALOG_URL].sort());
  await page.stayOpen(1);
  work.set(false);
  await page.stayOpen(1);
  work.set(true);
  await page.settle();
  // Entering Full workspace asks this site for its release at once. GitHub was asked 2 minutes ago.
  assert.deepEqual(page.requests(), [VERSION_CHECK]);
  await page.stayOpen(12);
  assert.deepEqual(page.requests(), []);
  await page.stayOpen(1);
  assert.deepEqual(page.requests(), [LIVE_CATALOG_URL], '15 minutes after the first check');
  work.set(false);
});

test('leaving Full workspace while the GitHub check is still running does not ask again on return', async (t) => {
  // A slow link: GitHub has the request but has not answered when the user leaves Full workspace.
  const page = dashboard(t, { githubDelayMs: 4_000 });
  const work = createBackgroundWork(page.load);
  work.set(true);
  await page.settle();
  assert.deepEqual(page.requests(), [VERSION_CHECK, BUNDLED_CATALOG, LIVE_CATALOG_URL].sort());
  work.set(false);
  t.mock.timers.tick(1_000);
  await page.settle();
  work.set(true);
  await page.settle();
  // Entering Full workspace asks this site for its release at once. GitHub was asked a second ago.
  assert.deepEqual(page.requests(), [VERSION_CHECK]);
  await page.stayOpen(14);
  assert.deepEqual(page.requests(), [], 'the interrupted check counts towards the 15 minutes');
  await page.stayOpen(1);
  // Both are due in this minute: GitHub 15 minutes after the interrupted check, this site 15 minutes
  // after the release check made on entering Full workspace again.
  assert.deepEqual(page.requests(), [VERSION_CHECK, LIVE_CATALOG_URL].sort());
  work.set(false);
});

test('a dashboard opened offline in Full workspace starts its background work when the connection returns', async (t) => {
  const page = dashboard(t);
  const work = createBackgroundWork(page.load);
  work.set(networkPolicy('full', false).polling);
  await page.stayOpen(5);
  assert.deepEqual(page.loads, [], 'no module request that could fail while offline');
  work.set(networkPolicy('full', true).polling);
  await page.settle();
  assert.deepEqual(page.loads, [0]);
  assert.deepEqual(page.requests(), [VERSION_CHECK, BUNDLED_CATALOG, LIVE_CATALOG_URL].sort());
  assert.deepEqual(page.registrations, [LIBRARY_WORKER]);
  // The connection drops again: the checks stop rather than fail every 15 minutes.
  work.set(networkPolicy('full', false).polling);
  await page.stayOpen(31);
  assert.deepEqual(page.requests(), []);
});

test('the privacy page names every other party that background work contacts', async (t) => {
  const page = dashboard(t);
  const work = createBackgroundWork(page.load);
  work.set(true);
  await page.stayOpen(16);
  work.set(false);
  const hosts = new Set(page.requests().map((url) => new URL(url).host));
  hosts.delete(new URL(ORIGIN).host);
  assert.deepEqual([...hosts], ['raw.githubusercontent.com']);
  const privacy = readFileSync('docs/privacy.md', 'utf8');
  for (const host of hosts)
    assert.ok(privacy.includes(host), `docs/privacy.md does not name ${host}`);
});

test('the resource-library README describes what this project stores, commits and checks', () => {
  const readme = readFileSync('resources/README.md', 'utf8');
  // Text carried over from another product that shares the resource library.
  assert.doesNotMatch(
    readme,
    /Forge for Mac|native bundle|study (?:sessions?|progress)|learning progress/i,
  );
  const workflow = readFileSync('.github/workflows/resources.yml', 'utf8');
  const committed = [...workflow.matchAll(/git add (.+)/g)].map((match) => match[1].trim());
  assert.deepEqual(committed, ['resources/catalog.json']);
  const commits = readme.split(/(?<=\.)\s+/).find((sentence) => sentence.includes('commits only'));
  assert.ok(commits, 'the README says what a refresh commits');
  assert.ok(
    committed.every((path) => commits.includes(path)),
    commits,
  );
  assert.doesNotMatch(commits, /\(and /, 'a refresh commits nothing else');
});

test('choosing the connection mode already in use keeps page alerts on; a real change ends them', () => {
  const modes = ['lite', 'full', 'offline'] as const;
  // Page alerts are on in Full workspace, and its already-pressed button is activated again.
  assert.equal(modeChoiceEndsPageAlerts('full', 'full', true), false);
  for (const current of modes)
    for (const next of modes) {
      assert.equal(modeChoiceEndsPageAlerts(current, next, true), next !== current);
      // Nothing to end, so nothing to announce.
      assert.equal(modeChoiceEndsPageAlerts(current, next, false), false);
    }
});

/** A stand-in for resources/background.mjs that records what the dashboard asks of it. */
function recorded(log: string[]): BackgroundModule {
  const controller = {
    start: async () => void log.push('catalog started'),
    stop: () => void log.push('catalog stopped'),
  };
  const updater = {
    start: async () => void log.push('updates started'),
    stop: () => void log.push('updates stopped'),
    getState: () => ({}),
  };
  return {
    createCatalogController: () => controller,
    bindCatalogLifecycle: (bound) => () => bound.stop(),
    ensureOfflineShell: async () => void log.push('library saved'),
    startAppUpdates: () => updater,
  };
}

test('a failed module download is retried under a new address, and only while background work is on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const log: string[] = [];
  const attempts: number[] = [];
  let reachable = false;
  const work = createBackgroundWork(async (attempt) => {
    attempts.push(attempt);
    if (!reachable) throw new TypeError('Failed to fetch dynamically imported module');
    return recorded(log);
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  work.set(true);
  await settle();
  assert.deepEqual(attempts, [0]);
  // Left on, it tries again after the same interval as the checks themselves.
  t.mock.timers.tick(MODULE_RETRY_MS - 1);
  await settle();
  assert.deepEqual(attempts, [0]);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(attempts, [0, 1]);
  // Switched off, it does not.
  work.set(false);
  t.mock.timers.tick(MODULE_RETRY_MS * 2);
  await settle();
  assert.deepEqual(attempts, [0, 1]);
  // Switched on again (the user returns to Full workspace, or the connection returns): at once.
  reachable = true;
  work.set(true);
  await settle();
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(log, ['catalog started', 'updates started', 'library saved']);
  t.mock.timers.tick(MODULE_RETRY_MS * 2);
  await settle();
  assert.deepEqual(attempts, [0, 1, 2], 'loaded modules are not requested again');
  // A browser can remember a failed module download for the life of the page.
  const urls = attempts.map((attempt) => resourceModuleUrl('background.mjs', ORIGIN, attempt));
  assert.deepEqual(urls, [
    `${ORIGIN}/resources/background.mjs`,
    `${ORIGIN}/resources/background.mjs?retry=1`,
    `${ORIGIN}/resources/background.mjs?retry=2`,
  ]);
});

test('modules that arrive after the user has left Full workspace do not start', async () => {
  const log: string[] = [];
  let arrive: (entry: BackgroundModule) => void = () => {};
  const work = createBackgroundWork(() => new Promise((resolve) => (arrive = resolve)));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  work.set(true);
  work.set(false);
  arrive(recorded(log));
  await settle();
  assert.deepEqual(log, []);
  work.set(true);
  work.set(true);
  assert.deepEqual(log, ['catalog started', 'updates started', 'library saved']);
  work.set(false);
  work.set(false);
  assert.deepEqual(log.slice(3), ['catalog stopped', 'updates stopped']);
});

test('a fault in the background modules never reaches the dashboard', async () => {
  const fault = () => {
    throw new TypeError('The published modules do not match this page');
  };
  const broken = recorded([]);
  broken.createCatalogController = fault;
  broken.startAppUpdates = fault;
  broken.ensureOfflineShell = fault;
  const work = createBackgroundWork(async () => broken);
  work.set(true);
  await new Promise((resolve) => setImmediate(resolve));
  // App switches background work from an effect: a throw there would replace the dashboard with
  // its error screen.
  assert.doesNotThrow(() => work.set(false));
  assert.doesNotThrow(() => work.set(true));
  assert.doesNotThrow(() => work.set(false));
});
