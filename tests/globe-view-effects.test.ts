import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { RECHECK_MS, type LatLon, type MosaicLoader } from '../src/globe';
import type { GlobeEvents, SceneOptions } from '../src/globe-scene';
import type { Place } from '../src/types';
import { REACT_STAND_IN, mount, type Element } from './support/hooks';

// GlobeView's effects and handlers, run in Node: React's hooks are a stand-in
// (tests/support/hooks.ts), and the globe reaches WebGL, three.js, the scene and NASA only
// through the `engine` prop, which these tests replace. So each decision GlobeView makes about
// downloads, imagery, focus and keys is checked where it is wired, not only in globe.ts.
const source = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
const icons = [
  ...readFileSync(source('components/GlobeView.tsx'), 'utf8')
    .match(/import \{([^}]*)\} from 'lucide-react'/)![1]
    .matchAll(/\w+/g),
].map(([name]) => name);
const temporary = await mkdtemp(join(tmpdir(), 'stormsignal-globe-effects-'));
let view: typeof import('../src/components/GlobeView');
try {
  await build({
    entryPoints: [source('components/GlobeView.tsx')],
    outfile: join(temporary, 'globe-view.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    loader: { '.css': 'empty' },
    external: ['three', 'three/*'],
    logLevel: 'error',
    plugins: [
      {
        name: 'stand-ins',
        setup(builder) {
          builder.onResolve({ filter: /^react(?:\/jsx-(?:dev-)?runtime)?$/ }, () => ({
            path: 'react',
            namespace: 'stand-in',
          }));
          builder.onResolve({ filter: /^lucide-react$/ }, () => ({
            path: 'icons',
            namespace: 'stand-in',
          }));
          builder.onLoad({ filter: /^react$/, namespace: 'stand-in' }, () => ({
            contents: REACT_STAND_IN,
            loader: 'js',
          }));
          builder.onLoad({ filter: /^icons$/, namespace: 'stand-in' }, () => ({
            contents: icons.map((name) => `export const ${name} = () => null;`).join('\n'),
            loader: 'js',
          }));
        },
      },
    ],
  });
  view = await import(pathToFileURL(join(temporary, 'globe-view.mjs')).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
type Engine = NonNullable<Parameters<typeof view.default>[0]['engine']>;

const chennai: Place = {
  id: 'chennai',
  name: 'Chennai',
  country: 'India',
  countryCode: 'IN',
  latitude: 13.0827,
  longitude: 80.2707,
};
const MORNING = Date.parse('2026-11-19T07:30:00Z');

/** The page around the globe: focus, visibility, the connection and the window's timers. */
/** A timer that never keeps the test process alive, should a view be left running. */
const unref = <T>(timer: T) => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};
/** The reduced-motion preference: set before the globe starts, or switched while it runs. */
const reducedMotion = {
  matches: false,
  listeners: new Set<() => void>(),
  addEventListener(_type: string, listener: () => void) {
    reducedMotion.listeners.add(listener);
  },
  removeEventListener(_type: string, listener: () => void) {
    reducedMotion.listeners.delete(listener);
  },
  /** The user changes the setting while the page is open. */
  switch(on: boolean) {
    reducedMotion.matches = on;
    for (const listener of [...reducedMotion.listeners]) listener();
  },
};
const page = {
  document: { activeElement: null as unknown, visibilityState: 'visible' },
  navigator: { onLine: true },
  window: {
    setTimeout: (run: () => void, ms: number) => unref(setTimeout(run, ms)),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (run: () => void, ms: number) => unref(setInterval(run, ms)),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  },
  matchMedia: (query: string) =>
    query === '(prefers-reduced-motion: reduce)'
      ? reducedMotion
      : { matches: false, addEventListener() {}, removeEventListener() {} },
};
const saved = Object.keys(page).map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
beforeEach(() => {
  for (const [key, value] of Object.entries(page))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  page.document.activeElement = null;
  page.document.visibilityState = 'visible';
  page.navigator.onLine = true;
  reducedMotion.matches = false;
  reducedMotion.listeners.clear();
});
/** Views still mounted when a test ends, as after a failed assertion: unmounted after it. */
const views: { unmount(): void }[] = [];
afterEach(() => {
  for (const mounted of views.splice(0)) mounted.unmount();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
});

/** An element that takes focus. */
function focusable(name: string) {
  return {
    name,
    focused: 0,
    focus() {
      this.focused++;
      page.document.activeElement = this;
    },
  };
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * A stand-in engine: what was asked of it, in order, and the scenes it made. three.js arrives
 * when the test says; NASA answers from `answers` (a coverage for each daily mosaic's date, the
 * base image, or an Error).
 */
function engine({
  webgl = true,
  answers = {} as Record<string, number | Error>,
  dates = ['2026-11-16', '2026-11-17', '2026-11-18'],
} = {}) {
  const asked: string[] = [];
  const three: Deferred<unknown>[] = [];
  const scenes: {
    log: string[];
    events: GlobeEvents;
    options: SceneOptions;
    disposed: number;
    view: LatLon;
  }[] = [];
  const mosaics: MosaicLoader<string> = {
    online: () => page.navigator.onLine,
    frames: async (_, force) => {
      asked.push(`dates${force ? ' (asked again)' : ''}`);
      return dates;
    },
    image: async (url) => {
      const date = /TIME=([\d-]+)/.exec(url)![1];
      asked.push(`mosaic ${date}`);
      const answer = answers[date] ?? 0.95;
      if (answer instanceof Error) throw answer;
      return { source: `mosaic ${date}`, width: 2048, height: 1024 };
    },
    held: () => undefined,
    measure: ({ source }) => {
      const answer = answers[source.slice('mosaic '.length)] ?? 0.95;
      if (typeof answer !== 'number') return null;
      const data = new Uint8Array(360 * 180);
      for (let row = 0; row < 180; row++) data.fill(1, row * 360, row * 360 + answer * 360);
      return { width: 360, height: 180, data };
    },
    forget: () => {},
  };
  const stand: Engine = {
    openContext: () => {
      asked.push('context');
      return webgl ? ({ canvas: {}, context: {} } as never) : null;
    },
    releaseContext: () => void asked.push('context released'),
    loadThree: () => {
      asked.push('three.js');
      const next = deferred<unknown>();
      three.push(next);
      return next.promise as never;
    },
    createGlobe: ((_kit: unknown, _probe: unknown, _stage, _host, _label, events, options) => {
      asked.push('scene');
      const log: string[] = [];
      const record =
        (name: string) =>
        (...args: unknown[]) => {
          log.push(`${name}(${args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(', ')})`);
          return undefined;
        };
      const scene = {
        log,
        events,
        options,
        disposed: 0,
        /** The place shown, and the centre of the view: a test moves it as auto-rotation would. */
        place: null as Place | null,
        view: { latitude: 0, longitude: 0 } as LatLon,
        // As the real scene: the view goes to a new place, and setPlace says whether it moved.
        setPlace: (place: Place) => {
          log.push(`setPlace(${place.name})`);
          const last = scene.place;
          const moved =
            !!last && (last.latitude !== place.latitude || last.longitude !== place.longitude);
          scene.place = place;
          if (moved || !last) scene.view = { latitude: place.latitude, longitude: place.longitude };
          return moved;
        },
        setSaved: record('setSaved'),
        setOutlines: record('setOutlines'),
        setImage: (layer: string, image: unknown) => void log.push(`setImage(${layer}, ${image})`),
        setDailyVisible: record('setDailyVisible'),
        setMotion: record('setMotion'),
        rotate: ({ latitude, longitude }: LatLon) => {
          scene.view = {
            latitude: scene.view.latitude + latitude,
            longitude: scene.view.longitude + longitude,
          };
          return scene.view;
        },
        zoom: () => 'in' as const,
        reset: () => {
          log.push('reset()');
          const { place } = scene;
          if (place) scene.view = { latitude: place.latitude, longitude: place.longitude };
        },
        centre: () => ({ ...scene.view }),
        dispose: () => {
          scene.disposed++;
        },
      };
      scenes.push(scene);
      return scene as never;
    }) as Engine['createGlobe'],
    loadImage: async (url) => {
      asked.push('base');
      const answer = answers.base;
      if (answer instanceof Error) throw answer;
      return { source: 'blue marble' as never, width: 2048, height: 1024 };
    },
    mosaics: mosaics as never,
    images: {
      hold: () => void asked.push('hold images'),
      release: () => void asked.push('release images'),
    },
  };
  return { engine: stand, asked, three, scenes };
}

/** GlobeView on a stand-in page: its refs point at stand-in elements, as React would attach. */
function globeView(stand: Engine, props: Partial<Parameters<typeof view.default>[0]> = {}) {
  const surface = focusable('globe');
  const restart = focusable('Restart');
  const control = focusable('Zoom in');
  const inCard = new Set<unknown>([surface, restart, control]);
  const card = { contains: (node: unknown) => inCard.has(node) };
  const mounted = mount(
    view.default as unknown as (props: Record<string, unknown>) => Element,
    {
      place: chennai,
      saved: [],
      alerts: [],
      clockOffset: undefined,
      onSelect: () => {},
      engine: stand,
      ...props,
    },
    {
      attach(element) {
        const refs = element.props as Record<string, { current: unknown } | undefined>;
        if (refs.sectionRef) refs.sectionRef.current = card;
        if (refs.stageRef) refs.stageRef.current = surface;
        if (refs.hostRef) refs.hostRef.current = { append() {} };
        if (refs.labelRef) refs.labelRef.current = { dataset: {}, style: {} };
        const stopped = ['lost', 'failed'].includes(element.props.status as string);
        if (refs.restartRef) refs.restartRef.current = stopped ? restart : null;
      },
    },
  );
  views.push(mounted);
  return { mounted, surface, restart, control };
}
/** A key press on the globe, and whether the globe took it from the page. */
function press(handler: unknown, key: string, held: Record<string, boolean> = {}) {
  let prevented = false;
  (handler as (event: unknown) => void)({
    key,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...held,
    preventDefault: () => void (prevented = true),
  });
  return prevented;
}

test('without WebGL 2 three.js is never requested, and the card says so', async () => {
  const fake = engine({ webgl: false });
  const { mounted } = globeView(fake.engine);
  await mounted.settle();
  assert.equal(mounted.props.status, 'unsupported');
  assert.deepEqual(fake.asked, ['hold images', 'context']);
  mounted.unmount();
  assert.deepEqual(fake.asked.slice(-1), ['release images']);
});

test('three.js is requested after the context; leaving while it loads gives the context back', async () => {
  const fake = engine();
  const { mounted } = globeView(fake.engine);
  assert.equal(mounted.props.status, 'starting');
  assert.deepEqual(fake.asked, ['hold images', 'context', 'three.js']);
  // A switch to Data saver while three.js downloads.
  mounted.unmount();
  assert.deepEqual(fake.asked.slice(-2).sort(), ['context released', 'release images']);
  fake.three[0].resolve({});
  await mounted.settle();
  assert.ok(!fake.asked.includes('scene'), 'nothing is made after the globe left');
});

test('a ready globe is given its place, motion and imagery, and is disposed once when it leaves', async () => {
  const fake = engine();
  const { mounted } = globeView(fake.engine);
  fake.three[0].resolve({});
  await mounted.settle();
  assert.equal(mounted.props.status, 'ready');
  const [scene] = fake.scenes;
  assert.ok(scene.log.includes('setPlace(Chennai)'));
  assert.ok(scene.log.includes('setMotion(true, true)'), 'it turns by itself as it starts');
  // The first daily load reads NASA's dates from the five-minute cache, then the newest mosaic.
  assert.deepEqual(fake.asked.slice(3), ['scene', 'base', 'dates', 'mosaic 2026-11-18']);
  // The scene draws what the card dates.
  assert.ok(scene.log.includes('setImage(base, blue marble)'));
  assert.ok(scene.log.includes('setImage(daily, mosaic 2026-11-18)'));
  assert.equal(mounted.props.daily && (mounted.props.daily as { date: string }).date, '2026-11-18');
  mounted.unmount();
  assert.equal(scene.disposed, 1, 'disposed once');
  assert.ok(!fake.asked.includes('context released'), 'the scene owned the context');
  assert.deepEqual(fake.asked.slice(-1), ['release images']);
});

test('a failed three.js download is handed to App’s notice, not left on Starting', async () => {
  const fake = engine();
  const { mounted } = globeView(fake.engine);
  fake.three[0].reject(new Error('Failed to fetch dynamically imported module'));
  await mounted.settle();
  assert.match(String((mounted.error as Error)?.message), /Failed to fetch/);
  assert.ok(fake.asked.includes('context released'));
});

test('Try again asks NASA only for the layer that failed', async () => {
  // The base image failed; the daily mosaic did not.
  const answers: Record<string, number | Error> = {
    base: new Error('NASA imagery is unavailable (503).'),
  };
  let fake = engine({ answers });
  let { mounted } = globeView(fake.engine);
  fake.three[0].resolve({});
  await mounted.settle();
  assert.equal((mounted.props.base as { state: string }).state, 'failed');
  let before = fake.asked.length;
  delete answers.base;
  (mounted.props.onRetryImagery as () => void)();
  await mounted.settle();
  assert.deepEqual(fake.asked.slice(before), ['base'], 'the base again, not the mosaic');
  mounted.unmount();
  // The daily mosaic failed; the base did not.
  fake = engine({ answers: { '2026-11-18': new Error('x'), '2026-11-17': new Error('y') } });
  ({ mounted } = globeView(fake.engine));
  fake.three[0].resolve({});
  await mounted.settle();
  assert.equal((mounted.props.daily as { state: string }).state, 'failed');
  before = fake.asked.length;
  (mounted.props.onRetryImagery as () => void)();
  await mounted.settle();
  assert.deepEqual(fake.asked.slice(before), [
    'dates (asked again)',
    'mosaic 2026-11-18',
    'mosaic 2026-11-17',
  ]);
  mounted.unmount();
});

test('a page left open looks for a newer mosaic hourly, not every minute', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: MORNING });
  // The newest mosaic is partial: the globe shows the day before and should look again hourly.
  const fake = engine({ answers: { '2026-11-18': 0.45, '2026-11-17': 0.93 } });
  const { mounted } = globeView(fake.engine);
  fake.three[0].resolve({});
  await mounted.settle();
  assert.equal((mounted.props.daily as { date: string }).date, '2026-11-17');
  const looks = () => fake.asked.filter((entry) => entry === 'dates (asked again)').length;
  for (let minute = 1; minute < 60; minute++) {
    t.mock.timers.tick(60_000);
    await mounted.settle();
  }
  assert.equal(looks(), 0, 'nothing in the first 59 minutes');
  t.mock.timers.tick(RECHECK_MS - 59 * 60_000);
  await mounted.settle();
  assert.equal(looks(), 1, 'one look on the hour');
  // A hidden page or no connection: the timer asks for nothing.
  page.document.visibilityState = 'hidden';
  t.mock.timers.tick(2 * RECHECK_MS);
  await mounted.settle();
  assert.equal(looks(), 1);
  page.document.visibilityState = 'visible';
  page.navigator.onLine = false;
  t.mock.timers.tick(60_000);
  await mounted.settle();
  assert.equal(looks(), 1);
  mounted.unmount();
});

test('Escape is left to the page once the help is hidden, and focus shows the help again', async () => {
  const fake = engine();
  const { mounted } = globeView(fake.engine);
  fake.three[0].resolve({});
  await mounted.settle();
  assert.equal(mounted.props.assist, 'full');
  assert.equal(press(mounted.props.onKeyDown, 'Escape'), true, 'Escape hides the help');
  mounted.flush();
  assert.equal(mounted.props.assist, 'none');
  assert.equal(press(mounted.props.onKeyDown, 'Escape'), false, 'a second Escape is the page’s');
  assert.equal(press(mounted.props.onKeyDown, 'ArrowLeft', { ctrlKey: true }), false);
  assert.equal(press(mounted.props.onKeyDown, 'ArrowLeft'), true, 'the globe still turns');
  (mounted.props.onSurfaceFocus as () => void)();
  mounted.flush();
  assert.equal(mounted.props.assist, 'full', 'focusing the globe shows the help again');
  assert.equal(press(mounted.props.onKeyDown, '+'), true);
  mounted.flush();
  assert.equal(mounted.props.assist, 'crosshair', 'a globe key hides the help');
  mounted.unmount();
});

test('focus moves to Restart when the globe stops, and stays on the globe through a restart', async () => {
  const fake = engine();
  const { mounted, surface, restart, control } = globeView(fake.engine);
  fake.three[0].resolve({});
  await mounted.settle();
  // Focus on a globe control when the browser takes the context away.
  control.focus();
  fake.scenes[0].events.lost();
  mounted.flush();
  assert.equal(mounted.props.status, 'lost');
  assert.equal(page.document.activeElement, restart, 'focus is on Restart, not the page');
  // Restart: focus waits on the globe while it starts again, and is there once it is back.
  (mounted.props.onRestart as () => void)();
  mounted.flush();
  assert.equal(page.document.activeElement, surface);
  assert.equal(fake.scenes[0].disposed, 1, 'the stopped globe is let go');
  assert.equal(mounted.props.status, 'starting');
  const focused = surface.focused;
  fake.three[1].resolve({});
  await mounted.settle();
  assert.equal(mounted.props.status, 'ready');
  assert.equal(surface.focused, focused + 1, 'focus is put on the globe once it draws');
  // A draw failure while focus is elsewhere on the page: focus stays where it is.
  const elsewhere = focusable('search');
  elsewhere.focus();
  fake.scenes[1].events.failed();
  mounted.flush();
  assert.equal(mounted.props.status, 'failed');
  assert.equal(page.document.activeElement, elsewhere);
  mounted.unmount();
});

test("the globe keeps the warning source's clock: the sun and the mosaic follow it", async (t: TestContext) => {
  // The device clock reads 00:30 UTC on 19 November, an hour fast: on the source's clock it is
  // still the 18th, so the newest mosaic whose day has ended is the 17th.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-19T00:30:00Z') });
  const fake = engine();
  const { mounted } = globeView(fake.engine, { clockOffset: 3_600_000 });
  fake.three[0].resolve({});
  await mounted.settle();
  const source = Date.parse('2026-11-18T23:30:00Z');
  assert.equal(mounted.props.now, source, 'the card’s sun and daylight');
  assert.equal(fake.scenes[0].options.clock(), source, 'the scene’s sun');
  assert.ok(fake.asked.includes('mosaic 2026-11-17'));
  assert.ok(!fake.asked.includes('mosaic 2026-11-18'));
  // No check has measured the source's clock: the device's.
  mounted.unmount();
  const own = engine();
  const second = globeView(own.engine);
  own.three[0].resolve({});
  await second.mounted.settle();
  assert.equal(second.mounted.props.now, Date.now());
  assert.ok(own.asked.includes('mosaic 2026-11-18'));
  second.mounted.unmount();
});

const london: Place = {
  id: 'london',
  name: 'London',
  country: 'United Kingdom',
  countryCode: 'GB',
  latitude: 51.5072,
  longitude: -0.1276,
};
/** A globe that has started, and the scene it made. */
async function ready(props: Partial<Parameters<typeof view.default>[0]> = {}) {
  const fake = engine();
  const shown = globeView(fake.engine, props);
  fake.three[0].resolve({});
  await shown.mounted.settle();
  assert.equal(shown.mounted.props.status, 'ready');
  return { ...shown, fake, scene: fake.scenes[0] };
}
/** The last call of `method` the scene was given, as `method(arguments)`. */
const lastCall = (scene: { log: string[] }, method: string) =>
  scene.log.filter((entry) => entry.startsWith(`${method}(`)).at(-1);

test('under reduced motion nothing on the globe moves by itself, even when the setting changes while it turns', async () => {
  reducedMotion.matches = true;
  let { mounted, scene } = await ready();
  assert.deepEqual(
    scene.log.filter((entry) => entry.startsWith('setMotion(')),
    ['setMotion(false, false)'],
    'no turning, pulse, glide or fade',
  );
  assert.equal(mounted.props.reducedMotion, true, 'and no motion switch');
  // Keys and a new place move the view, never set it turning.
  press(mounted.props.onKeyDown, 'ArrowLeft');
  mounted.update({ place: london });
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(false, false)');
  mounted.unmount();
  // The preference switched on while the globe turns: it stops at once.
  reducedMotion.matches = false;
  ({ mounted, scene } = await ready());
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(true, true)');
  reducedMotion.switch(true);
  mounted.flush();
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(false, false)');
  assert.equal(mounted.props.reducedMotion, true);
  mounted.unmount();
});

test('Globe motion switched off and on turns the globe again, after a drag or a key stopped it', async () => {
  const { mounted, scene } = await ready();
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(true, true)', 'it turns as it starts');
  // A drag takes the globe in hand.
  scene.events.interact();
  mounted.flush();
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(true, false)');
  (mounted.props.onTogglePause as () => void)();
  mounted.flush();
  assert.equal(mounted.props.paused, true);
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(false, false)', 'off: nothing moves');
  (mounted.props.onTogglePause as () => void)();
  mounted.flush();
  assert.equal(mounted.props.paused, false);
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(true, true)', 'on again: it turns');
  // A key stops it, and the switch off and on turns it again.
  press(mounted.props.onKeyDown, '+');
  mounted.flush();
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(true, false)');
  (mounted.props.onTogglePause as () => void)();
  mounted.flush();
  (mounted.props.onTogglePause as () => void)();
  mounted.flush();
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(true, true)');
  mounted.unmount();
});

test('a new place stops the turning, so the globe rests on it; a renamed place does not', async () => {
  const { mounted, scene } = await ready();
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(true, true)');
  mounted.update({ place: { ...chennai, name: 'Chennai, Tamil Nadu' } });
  assert.equal(lastCall(scene, 'setPlace'), 'setPlace(Chennai, Tamil Nadu)');
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(true, true)', 'still turning');
  mounted.update({ place: london });
  assert.equal(lastCall(scene, 'setPlace'), 'setPlace(London)');
  assert.equal(lastCall(scene, 'setMotion'), 'setMotion(true, false)');
  mounted.unmount();
});

test('the layer button hides the daily mosaic on the globe, and shows it again', async () => {
  const { mounted, scene } = await ready();
  assert.equal(mounted.props.showDaily, true);
  assert.equal(lastCall(scene, 'setDailyVisible'), 'setDailyVisible(true)');
  (mounted.props.onToggleDaily as () => void)();
  mounted.flush();
  assert.equal(mounted.props.showDaily, false, 'the button is no longer pressed');
  assert.equal(
    lastCall(scene, 'setDailyVisible'),
    'setDailyVisible(false)',
    'and the globe hides it',
  );
  (mounted.props.onToggleDaily as () => void)();
  mounted.flush();
  assert.equal(mounted.props.showDaily, true);
  assert.equal(lastCall(scene, 'setDailyVisible'), 'setDailyVisible(true)');
  mounted.unmount();
});

test('Enter keeps the selected place until the user turns the globe, then selects the centre', async () => {
  const chosen: Place[] = [];
  const { mounted, scene } = await ready({ onSelect: (place: Place) => void chosen.push(place) });
  const enter = () => {
    assert.equal(press(mounted.props.onKeyDown, 'Enter'), true);
    mounted.flush();
  };
  // Auto-rotation has drifted the view 15° east of Chennai; the user has not touched the globe.
  scene.view = { latitude: 13.0827, longitude: 95.2707 };
  enter();
  assert.equal(chosen.length, 0, 'Chennai stays selected');
  assert.match(String(mounted.props.announcement), /^Chennai is still selected\. Turn the globe/);
  // Turned 10° further with a key, then Escape: it hides the help and selects nothing.
  press(mounted.props.onKeyDown, 'ArrowRight');
  press(mounted.props.onKeyDown, 'Escape');
  mounted.flush();
  assert.equal(mounted.props.assist, 'none');
  assert.equal(chosen.length, 0);
  // Enter selects the point the user turned to.
  enter();
  assert.equal(chosen.length, 1);
  assert.deepEqual([chosen[0].latitude, chosen[0].longitude], [13.0827, 105.2707]);
  assert.equal(mounted.props.announcement, `Selected ${chosen[0].name}.`);
  // App selects it. Then a drag counts as turning too.
  mounted.update({ place: chosen[0] });
  scene.view = { latitude: 20, longitude: 120 };
  enter();
  assert.equal(chosen.length, 1, 'a view drifted from the new place keeps it');
  scene.events.interact();
  scene.events.turned();
  enter();
  assert.equal(chosen.length, 2, 'a drag counts as turning');
  assert.deepEqual([chosen[1].latitude, chosen[1].longitude], [20, 120]);
  mounted.unmount();
});

test('offline, the hourly look waits for the connection, reports no failure, and runs once it is back', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: MORNING });
  // The newest mosaic is partial, so a look is due on the hour.
  const fake = engine({ answers: { '2026-11-18': 0.45, '2026-11-17': 0.93 } });
  const { mounted } = globeView(fake.engine);
  fake.three[0].resolve({});
  await mounted.settle();
  const shown = mounted.props.daily;
  assert.equal((shown as { date: string }).date, '2026-11-17');
  const looks = () => fake.asked.filter((entry) => entry === 'dates (asked again)').length;
  // The connection drops before the look is due, for two hours.
  page.navigator.onLine = false;
  for (let minute = 1; minute <= 120; minute++) {
    t.mock.timers.tick(60_000);
    await mounted.settle();
  }
  assert.equal(looks(), 0);
  assert.equal(mounted.props.daily, shown, 'the mosaic stays dated, with no failed look to report');
  // Back online: the look that came due runs within a minute.
  page.navigator.onLine = true;
  t.mock.timers.tick(60_000);
  await mounted.settle();
  assert.equal(looks(), 1);
  mounted.unmount();
});

test('a wheel turn over the globe shows how to zoom, and the hint goes about two seconds after the last turn', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: MORNING });
  const { mounted, scene } = await ready();
  assert.equal(mounted.props.wheelHint, false);
  scene.events.wheel();
  mounted.flush();
  assert.equal(mounted.props.wheelHint, true);
  t.mock.timers.tick(1_500);
  scene.events.wheel();
  t.mock.timers.tick(1_500);
  mounted.flush();
  assert.equal(mounted.props.wheelHint, true, 'still shown 1.5 s after the last turn');
  t.mock.timers.tick(700);
  mounted.flush();
  assert.equal(mounted.props.wheelHint, false, 'then it hides, off the globe');
  mounted.unmount();
});

test('zoomed in, the title steps aside for the globe, and returns when the view is back', async () => {
  const { mounted, scene } = await ready();
  assert.equal(mounted.props.closer, false);
  scene.events.zoomed(true);
  mounted.flush();
  assert.equal(mounted.props.closer, true);
  scene.events.zoomed(false);
  mounted.flush();
  assert.equal(mounted.props.closer, false);
  mounted.unmount();
});
