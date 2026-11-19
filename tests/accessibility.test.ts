import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { REVEAL_SELECTOR } from '../src/motion';
import type { Forecast, Hour } from '../src/types';

// Keyboard, focus and contrast fixes from the accessibility audit. The dashboard is compiled and
// server-rendered as in dashboard.test.ts: no effects run, the map and report panels are empty
// stand-ins, and the forecast is the one a test puts in `loaded`. App's own effects are recorded
// in `effects` instead (its useEffect is swapped for one that keeps them), so a test can run one
// against stand-ins for the browser.
const require = createRequire(import.meta.url);
const source = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
const loaded: { forecast: Forecast | null } = { forecast: null };
type Effect = () => void | (() => void);
const effects: Effect[] = [];
Object.assign(globalThis, { __a11yTestLoaded: loaded, __a11yTestEffects: effects });
const temporary = await mkdtemp(join(tmpdir(), 'stormsignal-a11y-'));
let App: () => ReactNode;
try {
  const outfile = join(temporary, 'app.mjs');
  await build({
    entryPoints: [source('App.tsx')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    mainFields: ['module', 'main'],
    loader: { '.css': 'empty' },
    define: { 'import.meta.env.PROD': 'false' },
    logLevel: 'error',
    plugins: [
      {
        name: 'a11y-test',
        setup(builder) {
          builder.onResolve({ filter: /^react$/ }, ({ importer }) =>
            importer === source('App.tsx')
              ? { path: 'recorded-effects', namespace: 'a11y-test' }
              : undefined,
          );
          builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, ({ path }) => ({
            path: require.resolve(path),
            external: true,
          }));
          // Server rendering ignores useEffect, so recording one instead changes nothing else.
          builder.onLoad({ filter: /^recorded-effects$/, namespace: 'a11y-test' }, () => ({
            contents: `
              export * from 'react';
              export function useEffect(effect) { globalThis.__a11yTestEffects.push(effect); }`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /^\.\/components\/(?:WeatherMap|DisasterWatch)$/ }, () => ({
            path: 'optional-tool',
            namespace: 'a11y-test',
          }));
          builder.onResolve({ filter: /^\.\/resource$/ }, ({ importer }) =>
            importer === source('App.tsx')
              ? { path: 'loaded-resource', namespace: 'a11y-test' }
              : undefined,
          );
          builder.onLoad({ filter: /^optional-tool$/, namespace: 'a11y-test' }, () => ({
            contents: 'export default function OptionalTool() { return null; }',
            loader: 'js',
          }));
          builder.onLoad({ filter: /^loaded-resource$/, namespace: 'a11y-test' }, () => ({
            contents: `
              import { currentResource as current, loadResource } from './resource';
              import { fetchCompactForecast, fetchForecast } from './data';
              export { loadResource };
              export function currentResource(state, key, loader, enabled) {
                const forecast = globalThis.__a11yTestLoaded.forecast;
                return enabled && forecast && (loader === fetchForecast || loader === fetchCompactForecast)
                  ? { data: forecast, loading: false, error: null }
                  : current(state, key, loader, enabled);
              }`,
            loader: 'js',
            resolveDir: source('.'),
          }));
        },
      },
    ],
  });
  App = (await import(pathToFileURL(outfile).href)).default;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
  };
}
const local = memoryStorage();
const browser = {
  window: { innerWidth: 1280 },
  navigator: { onLine: true },
  localStorage: local,
  sessionStorage: memoryStorage(),
};
const originals = Object.keys(browser).map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
for (const [key, value] of Object.entries(browser))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
after(() => {
  for (const [key, descriptor] of originals)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
});
beforeEach(() => {
  local.items.clear();
  loaded.forecast = null;
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
function forecast(now: number): Forecast {
  const hour = (time: number): Hour => ({
    time,
    temperature: 27,
    apparent: 29,
    precipitation: 0,
    probability: 10,
    wind: 9,
    gust: 16,
    humidity: 70,
    code: 0,
    uv: 0,
  });
  return {
    fetchedAt: now,
    timezone: 'Asia/Kolkata',
    current: hour(now - 10 * 60_000),
    hours: Array.from({ length: 27 }, (_, index) => hour(now + index * HOUR)),
    days: [],
    source: 'Open-Meteo · weather model estimates',
  };
}

/**
 * Render the dashboard and run `act` on its elements during the first render. State set there is
 * applied before the markup is returned (see dashboard.test.ts), by rendering again: each further
 * act runs on the next render, while `effects` holds that render's effects.
 */
function renderAfter(...acts: ((dashboard: ReactNode) => void)[]): string {
  let step = 0;
  return renderToStaticMarkup(
    createElement(function Dashboard() {
      effects.length = 0;
      const dashboard = App();
      acts[step++]?.(dashboard);
      return dashboard;
    }),
  );
}
/**
 * Run the current render's effects whose code mentions `marker`, with `browser` standing in for
 * those globals, and return their cleanups, which run the same way.
 */
function runEffects(marker: string, browser: Record<string, unknown>) {
  const matching = effects.filter((effect) => String(effect).includes(marker));
  assert.ok(matching.length, `App has an effect that uses ${marker}`);
  const inBrowser = <T>(run: () => T): T => {
    const saved = Object.keys(browser).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );
    for (const [key, value] of Object.entries(browser))
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    try {
      return run();
    } finally {
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return matching.map((effect) => {
    const cleanup = inBrowser(effect);
    return () => void (cleanup && inBrowser(cleanup));
  });
}
/** A document stand-in that keeps its listeners, so a test can send events to them. */
function listeningDocument() {
  const listeners = new Map<string, Set<(event: object) => void>>();
  return {
    addEventListener(type: string, listener: (event: object) => void) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener(type: string, listener: (event: object) => void) {
      listeners.get(type)?.delete(listener);
    },
    send(type: string, event: object) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    listening: (type: string) => listeners.get(type)?.size ?? 0,
  };
}
type Props = {
  children?: ReactNode;
  className?: string;
  role?: string;
  'aria-label'?: string;
  ref?: { current: unknown };
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
  onBlur?: (event: { currentTarget: unknown; relatedTarget: unknown }) => void;
};
function* elements(node: ReactNode): Generator<ReactElement<Props>> {
  if (Array.isArray(node)) for (const child of node) yield* elements(child);
  else if (isValidElement<Props>(node)) {
    yield node;
    yield* elements(node.props.children);
  }
}
const text = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(text).join('')
    : typeof node === 'string' || typeof node === 'number'
      ? String(node)
      : isValidElement<{ children?: ReactNode }>(node)
        ? text(node.props.children)
        : '';
function find(dashboard: ReactNode, match: (element: ReactElement<Props>) => boolean) {
  const element = [...elements(dashboard)].find(match);
  assert.ok(element, 'the dashboard has the element under test');
  return element;
}
const button = (name: string) => (element: ReactElement<Props>) =>
  element.type === 'button' &&
  (element.props['aria-label'] === name || text(element).startsWith(name));
const plain = (html: string) => html.replace(/<[^>]*>/g, '');

test('city search results close when focus lands outside the search area', async (t) => {
  // Typing two letters opens the results below the search box, over the page heading's controls.
  // `inside` stands for the search box or its results, `outside` for any other control, and null
  // for another window.
  const inside = {};
  const outside = {};
  type Move = { leave: object | null } | { back: object } | { press: object };
  /**
   * Type 'San', then move focus as the browser reports it: a focusout from the search box when
   * focus leaves it, and a focusin, which reaches the document, where it lands. Focus that comes
   * `back` from another window sends only the focusin; a `press` sends a pointerdown.
   */
  const search = (...moves: Move[]) => {
    let listening = 0;
    const html = renderAfter((dashboard) => {
      const input = find(dashboard, (element) => element.props.role === 'combobox');
      input.props.onChange?.({ target: { value: 'San' } });
      const area = find(dashboard, (element) => element.props.className === 'search-area');
      const node = { contains: (target: unknown) => target === inside };
      area.props.ref!.current = node;
      const page = listeningDocument();
      const cleanups = runEffects('pointerdown', { document: page });
      for (const move of moves) {
        if ('press' in move) page.send('pointerdown', { target: move.press });
        if ('leave' in move)
          area.props.onBlur?.({ currentTarget: node, relatedTarget: move.leave });
        const lands = 'leave' in move ? move.leave : 'back' in move ? move.back : null;
        if (lands) page.send('focusin', { target: lands });
      }
      for (const cleanup of cleanups) cleanup();
      listening = page.listening('pointerdown') + page.listening('focusin');
    });
    assert.equal(listening, 0, 'the listeners go when the dashboard does');
    return html;
  };
  const combobox = (html: string) => /<input[^>]*role="combobox"[^>]*>/.exec(html)?.[0] ?? '';
  const open = (html: string) =>
    /aria-expanded="true"/.test(combobox(html)) && /class="search-results"/.test(html);

  await t.test('typing opens results that are not a Tab stop of their own', () => {
    const html = search();
    assert.ok(open(html));
    // Chrome makes a scrolling box a Tab stop unless it says otherwise; options are reached
    // with the arrow keys from the search box.
    assert.match(/<div class="search-results"[^>]*>/.exec(html)?.[0] ?? '', /tabindex="-1"/);
  });
  await t.test('Tab to the next control closes them and clears the search', () => {
    const html = search({ leave: outside });
    assert.ok(!open(html), 'results no longer cover the focused control');
    assert.match(combobox(html), /aria-expanded="false"/);
    assert.match(combobox(html), /value=""/);
  });
  await t.test('focus within the search area, or a press there, keeps them', () => {
    assert.ok(open(search({ leave: inside })));
    assert.ok(open(search({ press: inside })));
  });
  await t.test('a switch to another window keeps them for focus coming back to the search', () => {
    assert.ok(open(search({ leave: null })));
    assert.ok(open(search({ leave: null }, { back: inside })));
  });
  await t.test('focus coming back anywhere else closes them, as a press outside does', () => {
    // Shift+Tab from the browser toolbar, for one, lands on the page's last control.
    assert.ok(!open(search({ leave: null }, { back: outside })), 'focus came back elsewhere');
    assert.ok(!open(search({ press: outside })), 'a press outside');
  });
});

test('Refresh data stays focusable while loading, and a press then starts nothing', (t) => {
  const start = Date.UTC(2026, 10, 16, 3);
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const day = (html: string) =>
    plain(/<div class="eyebrow location-eyebrow">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '');
  const pressLater = (name: string) =>
    renderAfter((dashboard) => {
      // The press comes two days on: a refresh that runs moves the page clock to that day.
      t.mock.timers.setTime(start + 2 * DAY);
      find(dashboard, button(name)).props.onClick?.();
    });
  const refresh = (html: string) => /<button class="primary-button"[^>]*>/.exec(html)?.[0] ?? '';

  // No forecast has arrived, so the first load is still running.
  const opened = renderAfter(() => {});
  const busy = pressLater('Updating');
  // A disabled button would drop keyboard focus to the page; this one stays focusable and busy.
  assert.doesNotMatch(refresh(busy), /\sdisabled=""/);
  assert.match(refresh(busy), /aria-disabled="true"/);
  assert.equal(day(busy), day(opened), 'a press while busy starts nothing');

  t.mock.timers.setTime(start);
  loaded.forecast = forecast(start);
  const idle = pressLater('Refresh data');
  assert.doesNotMatch(refresh(idle), /disabled/);
  assert.notEqual(day(idle), day(opened), 'a press when idle refreshes');
});

test('status messages stay until dismissed or replaced', () => {
  // WCAG 2.2.1: a message removed on a timer can vanish before it is read or reached.
  const timer = /setTimeout\([^;]*setToast\([^;]*/.exec(readFileSync(source('App.tsx'), 'utf8'));
  assert.equal(timer?.[0], undefined, 'no timer removes a status message');
  const html = renderAfter((dashboard) => find(dashboard, button('Save place')).props.onClick?.());
  const toast = /<div class="toast"[^>]*>[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
  assert.match(toast, /role="status"/);
  assert.match(toast, /aria-label="Dismiss message"/);
});

test('a status message goes once a later action replaces what it reports', async (t) => {
  // Messages no longer time out, so one that a later action makes untrue must be cleared by it.
  const toast = (html: string) => /<div class="toast"[^>]*>[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
  const shown = (dashboard: ReactNode) =>
    text(find(dashboard, (element) => element.props.className === 'toast'));

  await t.test('choosing another place removes "Place saved"', () => {
    const html = renderAfter(
      (dashboard) => find(dashboard, button('Save place')).props.onClick?.(),
      (dashboard) => {
        assert.match(shown(dashboard), /Place saved on this device/);
        find(dashboard, button('Tokyo')).props.onClick?.();
      },
    );
    assert.equal(toast(html), '');
  });

  await t.test('a new location request removes the earlier failure', () => {
    const requests: { fail: () => void }[] = [];
    const device = browser.navigator as { geolocation?: unknown };
    device.geolocation = {
      getCurrentPosition: (_found: unknown, fail: () => void) => void requests.push({ fail }),
    };
    try {
      const html = renderAfter(
        (dashboard) => {
          find(dashboard, button('Use my location')).props.onClick?.();
          requests[0].fail();
        },
        (dashboard) => {
          assert.match(shown(dashboard), /Location access failed/);
          find(dashboard, button('Use my location')).props.onClick?.();
        },
      );
      assert.equal(requests.length, 2, 'the second request is pending');
      assert.equal(toast(html), '');
    } finally {
      delete device.geolocation;
    }
  });

  await t.test('a mode change that is saved removes an earlier storage warning', () => {
    const setItem = local.setItem;
    let storageFails = true;
    local.setItem = (key: string, value: string) => {
      if (storageFails) throw new Error('QuotaExceededError');
      setItem(key, value);
    };
    try {
      const html = renderAfter(
        (dashboard) => find(dashboard, button('Full workspace')).props.onClick?.(),
        (dashboard) => {
          assert.match(shown(dashboard), /browser storage could not remember it/);
          storageFails = false;
          find(dashboard, button('Offline only')).props.onClick?.();
        },
      );
      assert.equal(toast(html), '');
    } finally {
      local.setItem = setItem;
    }
  });
});

test('a window whose update checks are off never agrees to an early activation', () => {
  // A new release's worker asks every open window before it takes over. A Data saver or Offline only
  // window has stopped its updater, so it would keep the old page code under the new worker.
  const answers: Record<string, boolean | undefined> = {};
  for (const mode of ['lite', 'offline', 'full']) {
    local.setItem('stormsignal:connection-mode', mode);
    renderAfter(() => {
      const page: { innerWidth: number; appUpdateCanReload?: () => boolean } = { innerWidth: 1280 };
      const cleanups = runEffects('appUpdateCanReload', { window: page });
      answers[mode] = page.appUpdateCanReload?.();
      for (const cleanup of cleanups) cleanup();
    });
  }
  assert.deepEqual(answers, { lite: false, offline: false, full: true });
});

test('a shown message is measured, so the page can keep the height it covers free', () => {
  // A longer message wraps onto more lines. The room the page keeps for it, and how far Tab
  // scrolls a control above it, follow --toast-height (see the layout test below).
  const box = { offsetHeight: 70 };
  const properties = new Map<string, string>();
  const root = {
    setProperty: (name: string, value: string) => void properties.set(name, value),
    removeProperty: (name: string) => void properties.delete(name),
  };
  let report = () => {};
  let observed: unknown = null;
  class Observer {
    constructor(callback: () => void) {
      report = callback;
    }
    observe(target: unknown) {
      observed = target;
    }
    disconnect() {
      observed = null;
    }
  }
  let cleanups: (() => void)[] = [];
  const html = renderAfter(
    (dashboard) => find(dashboard, button('Save place')).props.onClick?.(),
    (dashboard) => {
      const { ref } = find(dashboard, (element) => element.props.className === 'toast').props;
      assert.ok(ref, 'the message element can be measured');
      ref.current = box;
      cleanups = runEffects('ResizeObserver', {
        ResizeObserver: Observer,
        document: { documentElement: { style: root } },
      });
    },
  );
  assert.match(html, /class="toast"/);
  assert.equal(observed, box, 'the message is measured while it is shown');
  report(); // A browser reports the size once observing starts, then on every change.
  assert.equal(properties.get('--toast-height'), '70px');
  box.offsetHeight = 110;
  report();
  assert.equal(properties.get('--toast-height'), '110px');
  for (const cleanup of cleanups) cleanup();
  assert.equal(observed, null, 'a dismissed message is no longer measured');
  assert.equal(properties.has('--toast-height'), false);
});

test('the map marker label is permanent, so the marker is not an unnamed Tab stop', () => {
  // Leaflet gives a hover tooltip focus and blur listeners on the marker's SVG path. Chrome then
  // makes that unnamed path a Tab stop, and its blur listener hides the place label.
  const map = readFileSync(source('components/WeatherMap.tsx'), 'utf8');
  const options = /marker\.current[\s\S]*?\.bindTooltip\(name,\s*(\{[^}]*\})/.exec(map)?.[1];
  assert.ok(options, 'the marker binds its place label');
  assert.match(options, /\bpermanent: true\b/);
});

// Contrast and layout. Stylesheets are read in the order the built page applies them: the
// components App imports, then main.tsx's styles.css and frontend-design.css. Lazily loaded panels
// come later.
type Declarations = Record<string, string>;
/** Top-level rules (outside @media) as [selectors, declarations], comments removed. */
function rules(css: string): [string[], Declarations][] {
  const found: [string[], Declarations][] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let from = 0;
  let selector = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '{' && depth++ === 0) {
      selector = text.slice(from, index).trim();
      from = index + 1;
    } else if (text[index] === '}' && --depth === 0) {
      if (!selector.startsWith('@')) {
        const declarations: Declarations = {};
        for (const line of text.slice(from, index).split(';')) {
          const colon = line.indexOf(':');
          if (colon > 0) declarations[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        }
        const selectors = selector.split(',').map((part) => part.trim().replace(/\s+/g, ' '));
        found.push([selectors, declarations]);
      }
      from = index + 1;
    }
  }
  return found;
}
/**
 * `value` with var() references to variables set on :root filled in. A variable that names
 * another (the earlier names point at the palette's tokens) is followed, and a fallback is never
 * used in its place. A variable set elsewhere, at run time (--toast-height) or on a component, is
 * left as written: a test fills it in itself, and a colour check fails on it.
 */
function resolve(value: string, variables: Declarations, depth = 0): string {
  if (depth > 8) return value;
  return value.replace(
    /var\((--[\w-]+)(?:,\s*[^()]*(?:\([^()]*\)[^()]*)*)?\)/g,
    (variable, name: string) =>
      variables[name] === undefined ? variable : resolve(variables[name], variables, depth + 1),
  );
}
/**
 * The declarations of every rule naming one of `selectors`, later ones winning, with the
 * variables set on :root filled in.
 */
function style(sheets: string[], ...selectors: string[]): Declarations {
  const all = sheets.flatMap(rules);
  const variables: Declarations = {};
  for (const [names, declarations] of all)
    if (names.includes(':root')) Object.assign(variables, declarations);
  const resolved: Declarations = {};
  for (const [names, declarations] of all)
    if (names.some((name) => selectors.includes(name)))
      for (const [property, value] of Object.entries(declarations))
        resolved[property] = resolve(value, variables);
  return resolved;
}
const css = (path: string) => readFileSync(source(path), 'utf8');
// App imports the globe's stylesheet before its other components (its skeleton needs the card's
// size from the first paint), so it comes first in the main stylesheet, ahead of the rest.
const dashboard = [
  'components/GlobeView.css',
  'components/OfflineBriefing.css',
  'components/ForecastExplorer.css',
  'styles.css',
  'frontend-design.css',
].map(css);
const lazy = [
  ...dashboard,
  ...['components/WeatherMap.css', 'components/DisasterWatch.css'].map(css),
];
function luminance(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}
/** Assert that two hex colours reach `minimum` contrast (WCAG 2 relative luminance). */
function contrast(a: string, b: string, minimum: number, what: string) {
  for (const colour of [a, b]) assert.match(colour, /^#[0-9a-f]{6}$/i, `${what}: ${colour}`);
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  const ratio = (light + 0.05) / (dark + 0.05);
  assert.ok(ratio >= minimum, `${what}: ${a} on ${b} is ${ratio.toFixed(2)}:1`);
}

test('the footer tagline meets 4.5:1 on the page background', () => {
  const page = style(dashboard, ':root')['--bg'];
  contrast(style(dashboard, '.footer small').color, page, 4.5, 'tagline');
});

test('emergency-kit placeholders, which hold field instructions, meet 4.5:1', () => {
  const kit = /<style>([\s\S]*?)<\/style>/.exec(readFileSync('public/offline.html', 'utf8'))![1];
  const placeholder = style([kit], '::placeholder').color;
  assert.ok(placeholder, 'the kit sets a placeholder colour instead of the browser default');
  contrast(placeholder, style([kit], 'textarea').background, 4.5, 'placeholder');
});

test("the kit's one-line fields show their whole instruction, down to a 320px screen", () => {
  // At 360px "Record a verified local number or radio channel" was cut off. Measured in Chrome at
  // the kit's 16px field size, 26 characters is about 190px: the room a field has at 320px is 200px.
  const kit = readFileSync('public/offline.html', 'utf8');
  const fields = [...kit.matchAll(/<input [^>]*placeholder="([^"]*)"/g)].map(([, text]) => text);
  assert.ok(fields.length >= 4, 'the plan fields');
  for (const text of fields) assert.ok(text.length <= 26, `${text} (${text.length} characters)`);
});

test('a pressed toggle is marked by a ring of at least 3:1, not only by a darker fill', () => {
  for (const [group, pressed] of [
    ['.connection-options', ".connection-options button[aria-pressed='true']"],
    ['.fe-metrics', ".fe-metrics button[aria-pressed='true']"],
    ['.fe-ranges', ".fe-ranges button[aria-pressed='true']"],
    ['.segmented', '.segmented button.selected'],
  ]) {
    const { background: fill, 'box-shadow': shadow = '' } = style(dashboard, pressed);
    const ring = /^inset 0 0 0 [1-9]\d*px (#[0-9a-f]{6})$/i.exec(shadow)?.[1];
    assert.ok(ring, `${pressed} draws an inset ring`);
    contrast(ring, style(dashboard, group).background, 3, `${pressed} ring on ${group}`);
    contrast(ring, fill, 3, `${pressed} ring on its own fill`);
  }
});

test('map tool buttons draw their focus ring inside the clipped tools column', () => {
  // Both focus rules have the same specificity, so the later one in the file wins.
  const map = [css('components/WeatherMap.css')];
  assert.equal(style(map, '.storm-map-tools').overflow, 'hidden');
  const focus = style(
    map,
    '.storm-map-panel button:focus-visible',
    '.storm-map-tools button:focus-visible',
  );
  const { outline, 'outline-offset': offset } = focus;
  assert.ok(Number.parseFloat(offset) <= -Number.parseFloat(outline), `${outline} at ${offset}`);
});

test('the map and its credits draw their focus rings inside the panel that clips them', () => {
  // The map fills the satellite panel edge to edge and the panel clips it: its ring lost 5px at
  // each side. Drawn inside its edge, an outline lies under the tiles, so the ring is a layer over
  // the tiles and Leaflet's controls (z-index 1000), with a dark band that keeps it at 3:1 over
  // bright imagery. The credits sit on the map's bottom edge, where their ring lost 1.4px.
  assert.equal(style(lazy, '.storm-map-panel').overflow, 'hidden');
  assert.equal(
    style(lazy, '.storm-map-canvas:focus-visible').outline,
    'none',
    'no clipped outline',
  );
  const layer = style(lazy, '.storm-map-canvas:focus-visible::after');
  assert.equal(layer.position, 'absolute');
  assert.equal(layer.inset, '0');
  assert.equal(layer['pointer-events'], 'none');
  assert.ok(Number(layer['z-index']) > 1000, 'over the tiles and controls');
  const [ring, band] = layer['box-shadow'].split(/,\s*(?![^()]*\))/);
  assert.match(ring, /^inset 0 0 0 2px (#[0-9a-f]{6})$/i);
  assert.equal(firstColour(ring), firstColour(style(dashboard, 'button:focus-visible').outline));
  assert.match(band, /^inset 0 0 0 4px rgba\(/);
  for (const under of ['#000000', '#ffffff'])
    contrast(
      firstColour(ring),
      over(firstColour(band), under),
      3,
      `ring on its band over ${under}`,
    );
  // Forced colours drop the shadow: the layer draws a system outline instead.
  const forced = mediaRules(css('components/WeatherMap.css'), /forced-colors:\s*active/).find(
    ([names]) => names.includes('.storm-map-canvas:focus-visible::after'),
  );
  assert.match(forced?.[1].outline ?? '', /solid Highlight/);
  const credit = style(
    lazy,
    '.storm-map-panel a:focus-visible',
    '.storm-map-canvas .leaflet-control-attribution a:focus-visible',
  );
  const reach = Number.parseFloat(credit.outline) + Number.parseFloat(credit['outline-offset']);
  assert.ok(reach <= 4, `the credit's ring reaches ${reach}px past the link`);
  // A place focused at the sidebar's bottom edge is scrolled clear of it, ring and all.
  const buttonRing =
    Number.parseFloat(style(dashboard, 'button:focus-visible').outline) +
    Number.parseFloat(style(dashboard, 'button')['outline-offset']);
  const padding = Number.parseFloat(style(dashboard, '.sidebar')['scroll-padding-block']);
  assert.ok(padding >= buttonRing + 2, `${padding}px clears a ${buttonRing}px ring`);
});

test("an official warning's summary draws its focus ring inside the warning, which clips it", () => {
  // The summary fills the warning box, and the box clips its overflow to its rounded corners. A
  // ring drawn outside the summary, as elsewhere on the page, was clipped away entirely: keyboard
  // users could not see which warning they were on.
  assert.equal(style(dashboard, '.official-alert').overflow, 'hidden');
  const { outline = '', 'outline-offset': offset = '0' } = style(
    dashboard,
    'summary:focus-visible',
    '.official-alert > summary:focus-visible',
  );
  assert.ok(Number.parseFloat(outline) >= 2, `a ring is drawn: ${outline}`);
  assert.ok(Number.parseFloat(offset) <= -Number.parseFloat(outline), `${outline} at ${offset}`);
  // The ring is the page's lavender, at 3:1 or more on the warning's own fill.
  contrast(firstColour(outline), style(dashboard, '.official-alert').background, 3, 'ring');
});

/** A length in px when the message is `height` px tall: variables filled in, calc() sums added. */
function pixels(value: string, height: number, variables: Declarations): number {
  let resolved = value;
  for (let pass = 0; pass < 3; pass++)
    resolved = resolved.replace(
      /var\((--[\w-]+)(?:, ?([^()]*))?\)/g,
      (_, name: string, fallback?: string) =>
        name === '--toast-height' ? `${height}px` : (variables[name] ?? fallback ?? ''),
    );
  const sum = /^(?:calc\()?(\d+(?:\.\d+)?px(?: \+ \d+(?:\.\d+)?px)*)\)?$/.exec(resolved);
  assert.ok(sum, `${value} is a sum of lengths`);
  return sum[1].split(' + ').reduce((total, part) => total + Number.parseFloat(part), 0);
}

test('while a message is shown, Tab scrolls any control clear of it, the last ones too', () => {
  // The browser keeps a focused control scroll-padding-bottom above the foot of the window, so
  // that has to clear the message (its measured height and its offset from the foot) and the
  // focus ring. At the end of the page, it can only scroll that far into room below the footer.
  const shown = style(dashboard, 'html:has(.toast)');
  const room = style(dashboard, 'html:has(.toast) .workspace')['padding-bottom'];
  assert.ok(room, 'the page keeps room below the footer while a message is shown');
  const offset = Number.parseFloat(style(dashboard, '.toast').bottom);
  const ring =
    Number.parseFloat(style(dashboard, 'button:focus-visible').outline) +
    Number.parseFloat(style(dashboard, 'button')['outline-offset']);
  for (const height of [58, 70, 110, 160]) {
    const padding = pixels(shown['scroll-padding-bottom'] ?? '', height, shown);
    assert.ok(padding >= height + offset + ring, `${padding}px clears a ${height}px message`);
    assert.ok(pixels(room, height, shown) >= padding, `room below the footer for ${height}px`);
  }
});

test('the open drawer, a modal dialog, covers a message rather than the message covering it', () => {
  // The drawer keeps Tab inside it, so a message over it would cover drawer controls that cannot
  // be scrolled clear, and its Dismiss button could not be reached.
  const layer = (selector: string) => Number(style(dashboard, selector)['z-index']);
  const waiting = layer('.sidebar.open ~ .toast');
  assert.ok(waiting < layer('.sidebar'), 'under the open drawer');
  assert.ok(waiting > layer('.topbar'), 'over the rest of the page');
  // That rule applies because the message comes after the drawer, in the same parent.
  let order: string[] = [];
  renderAfter(
    (dashboard) => find(dashboard, button('Save place')).props.onClick?.(),
    (dashboard) => {
      order = [(dashboard as ReactElement<Props>).props.children]
        .flat()
        .flatMap((child) => (isValidElement<Props>(child) ? [String(child.props.className)] : []));
    },
  );
  const drawer = order.findIndex((name) => /^sidebar\b/.test(name));
  assert.ok(drawer >= 0 && order.indexOf('toast') > drawer, order.join(' | '));
});

// The Midnight Aurora design system (frontend-design.css): the shared tokens, the contrast they
// keep on the surfaces they are used on, and the rules that keep motion, glass and fonts light.
const design = css('frontend-design.css');
const token = (name: string) => style(dashboard, ':root')[name];
const pageStyle = (file: string) =>
  /<style>([\s\S]*?)<\/style>/.exec(readFileSync(file, 'utf8'))![1];
/** The rules inside each @media block whose condition matches `condition`. */
function mediaRules(sheet: string, condition: RegExp): [string[], Declarations][] {
  const text = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: [string[], Declarations][] = [];
  let depth = 0;
  let from = 0;
  let header = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '{' && depth++ === 0) {
      header = text.slice(from, index).trim();
      from = index + 1;
    } else if (text[index] === '}' && --depth === 0) {
      if (header.startsWith('@media') && condition.test(header))
        found.push(...rules(text.slice(from, index)));
      from = index + 1;
    }
  }
  return found;
}
function channels(colour: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 1];
  }
  const fn = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/i.exec(colour.trim());
  assert.ok(fn, `a colour: ${colour}`);
  return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])];
}
/** `colour` (which can be translucent) painted over the opaque `under`, as #rrggbb. */
function over(colour: string, under: string): string {
  const [r, g, b, alpha] = channels(colour);
  const base = channels(under);
  return `#${[r, g, b]
    .map((channel, index) => Math.round(channel * alpha + base[index] * (1 - alpha)))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}
function hue(colour: string): number {
  const [r, g, b] = channels(colour)
    .slice(0, 3)
    .map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const spread = max - Math.min(r, g, b);
  if (!spread) return 0;
  const sector =
    max === r ? (g - b) / spread : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4;
  return (sector * 60 + 360) % 360;
}
function hueApart(a: string, b: string) {
  const difference = Math.abs(hue(a) - hue(b));
  return Math.min(difference, 360 - difference);
}
const firstColour = (value = '') => /#[0-9a-f]{6}\b|rgba?\([^)]*\)/i.exec(value)?.[0] ?? value;
/** The palette's surfaces as opaque colours: translucent ones over the page they sit on. */
function surfaces(): Record<string, string> {
  const page = token('--aurora-bg');
  return {
    'the page': page,
    'a card': token('--aurora-surface'),
    'a raised card': token('--aurora-surface-raised'),
    'a sunken group': token('--aurora-surface-sunken'),
    'glass over the page': over(token('--aurora-glass'), page),
    'a panel over the page': over(token('--aurora-panel-fill'), page),
    'the hero card': style(dashboard, '.conditions-card')['--hero-base'],
  };
}

test('the shared Midnight Aurora tokens are defined on :root, and the earlier names follow them', () => {
  const shared: Declarations = {
    '--aurora-bg': '#060A14',
    '--aurora-surface': '#0E1626',
    '--aurora-surface-raised': '#131E33',
    '--aurora-glass': 'rgba(14,22,38,0.62)',
    '--aurora-line': 'rgba(160,178,255,0.16)',
    '--aurora-teal': '#3EE6C1',
    '--aurora-violet': '#8B7CFF',
    '--aurora-gradient': 'linear-gradient(120deg,#3EE6C1 0%,#8B7CFF 100%)',
    '--aurora-text': '#EEF3FF',
    '--aurora-muted': '#9AA7BF',
    '--aurora-glow': '0 0 0 1px rgba(62,230,193,.35), 0 12px 40px -12px rgba(139,124,255,.45)',
  };
  // Other stylesheets read these as var(--name, fallback), so they are set with the palette.
  const root = style([design], ':root');
  const same = (value = '') => value.toLowerCase().replace(/\s+/g, '').replace(/\b0\./g, '.');
  for (const [name, value] of Object.entries(shared))
    assert.equal(same(root[name]), same(value), name);
  for (const [earlier, current] of Object.entries({
    '--bg': '--aurora-bg',
    '--panel': '--aurora-surface',
    '--line': '--aurora-line',
    '--muted': '--aurora-muted',
    '--mint': '--aurora-teal',
  }))
    assert.equal(token(earlier), token(current), `${earlier} follows ${current}`);
  assert.equal(style(dashboard, ':root').background, token('--aurora-bg'), 'the page base');
  // The warm tone of the official-alert count and the amber status dot is a warning colour, not
  // the palette's: it keeps the value it had before the redesign.
  assert.equal(token('--amber'), '#edc18e');
});

test('palette text keeps 4.5:1 on every surface it is used on, glass and translucent panels too', () => {
  for (const name of [
    '--aurora-text',
    '--aurora-text-soft',
    '--aurora-muted',
    '--aurora-faint',
    '--aurora-teal',
    '--aurora-teal-soft',
    '--aurora-violet-soft',
  ])
    for (const [where, background] of Object.entries(surfaces()))
      contrast(token(name), background, 4.5, `${name} on ${where}`);
  contrast(token('--aurora-faint'), token('--aurora-surface-hover'), 4.5, 'faint text, hovered');
  // Text on fills of its own: the pressed toggles, and the primary button's dark ink.
  for (const selector of [
    ".connection-options button[aria-pressed='true']",
    ".fe-metrics button[aria-pressed='true']",
    ".fe-ranges button[aria-pressed='true']",
    '.segmented button.selected',
  ]) {
    const { color, background } = style(dashboard, selector);
    contrast(color, background, 4.5, `${selector} text`);
  }
  for (const stop of token('--aurora-gradient').match(/#[0-9a-f]{6}/gi)!)
    contrast(token('--aurora-ink'), stop, 4.5, `primary button ink on ${stop}`);
});

test('controls keep a 3:1 boundary on the surfaces they rest on', () => {
  const boundary = token('--aurora-line-strong');
  for (const [where, background] of Object.entries(surfaces()))
    contrast(boundary, background, 3, `control boundary on ${where}`);
  // The fields and buttons that this boundary identifies.
  for (const [sheets, selector] of [
    [dashboard, '.search-area form'],
    [dashboard, '#saved-briefing'],
    [dashboard, '.secondary-button'],
    [dashboard, '.quiet-button'],
    [lazy, '.storm-map-layer-control'],
    [lazy, '.storm-map-button'],
  ] as const)
    assert.equal(firstColour(style(sheets, selector).border), boundary, selector);
  // A slider's track, under its teal thumb.
  const track = style(dashboard, "input[type='range']::-webkit-slider-runnable-track");
  assert.equal(track.background, boundary);
  contrast(token('--aurora-teal'), boundary, 3, 'slider thumb on its track');
  // Scrollbar thumbs: every scroll container inherits the root's colours, over a clear track, so
  // a thumb is seen against whatever surface it scrolls over.
  const variables = style(dashboard, ':root');
  const thumbs = lazy
    .flatMap((sheet) => [...rules(sheet), ...mediaRules(sheet, /./)])
    .flatMap(([names, declarations]) =>
      declarations['scrollbar-color'] ? [[names, declarations['scrollbar-color']] as const] : [],
    );
  assert.ok(thumbs.length, 'the palette colours the scrollbars');
  for (const [names, value] of thumbs) {
    const [thumb, scrollTrack] = resolve(value, variables).split(/\s+/);
    assert.equal(scrollTrack, 'transparent', `${names}: the track shows the surface`);
    for (const [where, background] of Object.entries(surfaces()))
      contrast(thumb, background, 3, `${names} scrollbar thumb on ${where}`);
  }
});

test('the focus ring shows on dark glass and every surface, and is not the pressed-toggle teal', () => {
  const ring = firstColour(style(dashboard, 'button:focus-visible').outline);
  for (const [where, background] of Object.entries(surfaces()))
    contrast(ring, background, 3, `focus ring on ${where}`);
  // Every focus rule draws the same ring: fields, scroll regions and the satellite panel.
  for (const [sheets, selector] of [
    [dashboard, 'select:focus-visible'],
    [dashboard, "[tabindex='0']:focus-visible"],
    [dashboard, '.search-area form:focus-within'],
    [lazy, '.storm-map-panel button:focus-visible'],
  ] as const)
    assert.equal(firstColour(style(sheets, selector).outline), ring, selector);
  const pressed = /(#[0-9a-f]{6})$/i.exec(
    style(dashboard, ".connection-options button[aria-pressed='true']")['box-shadow'],
  )![1];
  assert.ok(hueApart(ring, pressed) >= 60, `focus ${ring} reads apart from pressed ${pressed}`);
});

test('aurora gradient text keeps 4.5:1 at both ends, where the hero glows peak together too', () => {
  const stops = token('--aurora-gradient').match(/#[0-9a-f]{6}/gi)!;
  assert.equal(stops.length, 2, 'a two-stop gradient');
  // The hero card's decorative glows, both at full strength over its base: the worst case for
  // the temperature, wherever the number sits on the card.
  const hero = style(dashboard, '.conditions-card');
  // The card sets its glows on itself, so its background still names them.
  for (const glow of ['--hero-glow-violet', '--hero-glow-teal'])
    assert.ok(hero.background.includes(`var(${glow})`), `the hero background draws ${glow}`);
  const peak = over(
    hero['--hero-glow-violet'],
    over(hero['--hero-glow-teal'], hero['--hero-base']),
  );
  const page = token('--aurora-bg');
  for (const stop of stops) {
    contrast(stop, peak, 4.5, 'temperature over both hero glows');
    contrast(stop, over(token('--aurora-glass'), page), 4.5, 'brand on the glass sidebar');
    contrast(stop, over(token('--aurora-panel-fill'), page), 4.5, 'section number on a panel');
    contrast(stop, page, 4.5, 'heading dot on the page');
  }
  // Gradient text paints no fill of its own; where backgrounds are not drawn it gets one back.
  const number = style(dashboard, '.temperature > span');
  assert.equal(number['background-clip'], 'text');
  assert.equal(number['-webkit-text-fill-color'], 'transparent');
  assert.equal(number.filter, undefined, 'no glow of its own under the number');
  for (const condition of [/forced-colors:\s*active/, /^@media print/]) {
    const [, fallback] = mediaRules(design, condition).find(([names]) =>
      names.includes('.temperature > span'),
    )!;
    assert.equal(fallback['-webkit-text-fill-color'], 'currentColor', String(condition));
    assert.equal(fallback.background, 'none', String(condition));
  }
  // A pointer glare would lighten the card behind the number, so the hero card has none.
  const glare = mediaRules(design, /no-preference/).filter(([names]) =>
    names.some((name) => name.endsWith('::after') && name.includes('[data-tilt]')),
  );
  assert.ok(glare.length, 'tilted cards have a glare');
  for (const [names] of glare)
    assert.ok(
      names.every((name) => name.includes(':not(.conditions-card)')),
      names.join(),
    );
});

test('forecast series colours keep 3:1 on the chart panels, stay apart, and the legend reads', () => {
  const explorer = readFileSync(source('components/ForecastExplorer.tsx'), 'utf8');
  const colours = /const COLORS = \[([^\]]*)\]/.exec(explorer)![1].match(/#[0-9a-f]{6}/gi)!;
  assert.ok(colours.length >= 2);
  const panel = over(token('--aurora-panel-fill'), token('--aurora-bg'));
  for (const colour of colours) {
    contrast(colour, panel, 3, `series ${colour} on a panel`);
    contrast(colour, token('--aurora-surface-raised'), 3, `series ${colour} on a raised card`);
  }
  for (const [index, colour] of colours.entries())
    for (const other of colours.slice(index + 1))
      assert.ok(hueApart(colour, other) >= 30, `${colour} and ${other} are apart in hue`);
  for (const selector of ['.fe-legend > div', '.fe-legend strong', '.fe-scale', '.fe-times small'])
    contrast(style(dashboard, selector).color, panel, 4.5, selector);
});

test('motion is opt-in: nothing is hidden or moved outside a no-preference media query', () => {
  const sheets = [...lazy, pageStyle('public/offline.html'), pageStyle('public/preparedness.html')];
  for (const sheet of sheets) {
    const still = [...rules(sheet), ...mediaRules(sheet, /^(?![\s\S]*no-preference)/)];
    for (const [names, declarations] of still) {
      if (names.some((name) => name.includes('[data-reveal')))
        assert.notEqual(declarations.opacity, '0', `${names} hides content`);
      if (names.some((name) => name.includes('[data-tilt]')))
        assert.ok(!declarations.transform || /none/.test(declarations.transform), `${names}`);
      assert.doesNotMatch(declarations.animation ?? '', /aurora-settle|toast-in/, `${names}`);
    }
  }
  const motion = mediaRules(design, /prefers-reduced-motion:\s*no-preference/);
  const pending = motion.find(([names]) => names.includes("[data-reveal='pending']"));
  assert.equal(pending?.[1].opacity, '0', 'held sections start hidden when motion is welcome');
  // The aurora moves only in Full workspace (field mode is Data saver or Offline only), and only
  // once: a layer moving under the two glass surfaces makes the compositor redraw and re-blur
  // them on every frame, so a loop would cost power for as long as the page is open.
  const settle = motion.filter(([, declarations]) =>
    /aurora-settle/.test(declarations.animation ?? ''),
  );
  assert.ok(settle.length, 'the aurora settles into place');
  for (const [names, declarations] of settle) {
    assert.ok(
      names.every((name) => name.includes(':not(.field-mode)')),
      names.join(),
    );
    const { animation, 'animation-iteration-count': count = '1' } = declarations;
    // In the shorthand an iteration count is a bare number or "infinite" (outside any function).
    const counts = [...animation.replace(/\([^)]*\)/g, '()').split(/\s+/), count].filter(
      (part) => part === 'infinite' || /^\d+(?:\.\d+)?$/.test(part),
    );
    assert.deepEqual(new Set(counts), new Set(['1']), `${animation}: it plays once, never loops`);
    const seconds = Number.parseFloat(/(\d+(?:\.\d+)?)s\b/.exec(animation)?.[1] ?? 'NaN');
    // WCAG 2.2.2: motion that starts by itself and lasts more than five seconds needs a pause.
    assert.ok(seconds > 0 && seconds <= 5, `${animation}: done within 5 s, then still`);
  }
  // Nothing else in the dashboard animates forever, except a spinner while data loads.
  for (const sheet of lazy)
    for (const [names, declarations] of [...rules(sheet), ...mediaRules(sheet, /./)])
      if (
        /\binfinite\b/.test(
          `${declarations.animation} ${declarations['animation-iteration-count']}`,
        )
      )
        assert.deepEqual(names, ['.spin'], `${names} animates forever`);
  // Reduced motion stops every animation and transition, and printing shows held sections.
  const calm = mediaRules(css('styles.css'), /prefers-reduced-motion:\s*reduce/);
  assert.ok(
    calm.some(
      ([names, declarations]) =>
        names.includes('*') &&
        declarations.animation === 'none !important' &&
        declarations.transition === 'none !important',
    ),
  );
  const print = mediaRules(design, /^@media print/);
  assert.ok(
    print.some(([names, declarations]) => {
      return names.includes('[data-reveal]') && declarations.opacity === '1 !important';
    }),
  );
});

test('printed pages turn the palette text dark, so headings and values reach 4.5:1 on paper', () => {
  // Headings, metrics and labels read the text tokens, so redefining them for print is enough.
  const [, paper] = mediaRules(design, /^@media print/).find(([names]) => names.includes(':root'))!;
  for (const name of [
    '--aurora-text',
    '--aurora-text-soft',
    '--aurora-muted',
    '--aurora-faint',
    '--aurora-teal',
    '--aurora-teal-soft',
    '--aurora-violet-soft',
  ])
    contrast(paper[name], '#ffffff', 4.5, `${name} in print`);
  // The light text that must print reads those tokens, not fixed colours.
  const written = (selector: string) => {
    const merged: Declarations = {};
    for (const [names, declarations] of dashboard.flatMap(rules))
      if (names.includes(selector)) Object.assign(merged, declarations);
    return merged;
  };
  for (const selector of ['h1', '.panel-heading h2', '.condition-metrics strong', '.card-kicker'])
    assert.match(written(selector).color, /^var\(--aurora-text(?:-soft)?\)$/, selector);
});

test('forced colours mark the chosen toggle, place and section with the system highlight', () => {
  // The teal ring is a box-shadow and the fill a background: forced colours drop both.
  const [names, chosen] = mediaRules(design, /forced-colors:\s*active/).find(
    ([, declarations]) => declarations.background === 'Highlight',
  )!;
  assert.equal(chosen.color, 'HighlightText');
  // Without this, the browser's text backplate would hide the label on the highlight.
  assert.equal(chosen['forced-color-adjust'], 'none');
  for (const selector of [
    ".connection-options button[aria-pressed='true']",
    ".fe-metrics button[aria-pressed='true']",
    ".fe-ranges button[aria-pressed='true']",
    '.segmented button.selected',
    '.saved-list button.current',
    'nav a.active',
    ".search-results button[aria-selected='true']",
  ])
    assert.ok(names.includes(selector), selector);
});

test('frosted glass stays on the two large frame surfaces, never on lists or cards', () => {
  const glassy = new Set<string>();
  for (const sheet of lazy)
    for (const [names, declarations] of [...rules(sheet), ...mediaRules(sheet, /./)])
      if (declarations['backdrop-filter'] || declarations['-webkit-backdrop-filter'])
        for (const name of names) glassy.add(name);
  assert.deepEqual([...glassy].sort(), ['.sidebar', '.topbar']);
});

test('the interface and its standalone pages use system fonts only', () => {
  const system = new Set(
    [
      'ui-sans-serif',
      'system-ui',
      '-apple-system',
      'BlinkMacSystemFont',
      'Segoe UI Variable Text',
      'Segoe UI Variable Display',
      'Segoe UI',
      'Roboto',
      'Helvetica Neue',
      'Arial',
      'sans-serif',
      'ui-monospace',
      'SF Mono',
      'SFMono-Regular',
      'Menlo',
      'Consolas',
      'Liberation Mono',
      'monospace',
    ].map((family) => family.toLowerCase()),
  );
  const variables = style(dashboard, ':root');
  const pages = ['public/offline.html', 'public/preparedness.html', 'public/404.html'];
  for (const sheet of [...lazy, ...pages.map(pageStyle)]) {
    assert.doesNotMatch(sheet, /@font-face|@import|url\s*\(/i, 'no font or other file is fetched');
    for (const [names, declarations] of [...rules(sheet), ...mediaRules(sheet, /./)])
      for (const [property, written] of Object.entries(declarations)) {
        if (!/^(font|font-family|--font-[a-z]+)$/.test(property)) continue;
        const value = resolve(written, variables).replace(/\s+/g, ' ').trim();
        if (/^(inherit|initial|unset)$/.test(value)) continue;
        // A font shorthand lists the families after its size.
        const families =
          property === 'font'
            ? /\d[\d.]*(?:px|rem|em|pt)(?:\/[\d.]+)?\s+(.+)$/.exec(value)?.[1]
            : value;
        assert.ok(families, `${names}: ${property}: ${value}`);
        for (const family of families.split(','))
          assert.ok(
            system.has(
              family
                .trim()
                .replace(/^['"]|['"]$/g, '')
                .toLowerCase(),
            ),
            `${names}: ${family.trim()} is not a system font`,
          );
      }
  }
});

test('the browser chrome, installed app and standalone pages share the midnight base', () => {
  const base = token('--aurora-bg');
  const theme = (file: string) =>
    /<meta name="theme-color" content="(#[0-9a-f]{6})"/i.exec(readFileSync(file, 'utf8'))?.[1];
  for (const file of [
    'index.html',
    'public/offline.html',
    'public/preparedness.html',
    'public/404.html',
  ])
    assert.equal(theme(file)?.toLowerCase(), base, file);
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.theme_color, base);
  assert.equal(manifest.background_color, base);
  // The kit and the guide carry the palette themselves, so a downloaded copy keeps it.
  for (const file of ['public/offline.html', 'public/preparedness.html']) {
    const sheet = pageStyle(file);
    const root = style([sheet], ':root');
    assert.equal(root['--bg'], base, file);
    for (const text of ['--text', '--muted'])
      for (const background of ['--bg', '--panel'])
        contrast(root[text], root[background], 4.5, `${file}: ${text} on ${background}`);
    const ring = firstColour(style([sheet], 'button:focus-visible').outline);
    for (const background of ['--bg', '--panel'])
      contrast(ring, root[background], 3, `${file}: focus ring on ${background}`);
  }
});

test('the app, the kit, the guide and the 404 page carry one wordmark, its gradient readable', () => {
  // The guide and the 404 page once had a capitals eyebrow, STORMSIGNAL, where the others have
  // the wordmark: "storm" with "signal" in the aurora gradient.
  const app = readFileSync(source('App.tsx'), 'utf8');
  assert.match(app, /storm<span className="brand-light">signal<\/span>/);
  for (const file of ['public/offline.html', 'public/preparedness.html', 'public/404.html']) {
    const page = readFileSync(file, 'utf8');
    assert.match(page, /class="brand"[^>]*>storm<span>signal<\/span><\/(?:a|div|p)\s*>/, file);
    assert.doesNotMatch(page, /STORMSIGNAL|<p>StormSignal<\/p>/, file);
    const sheet = pageStyle(file);
    const gradient = resolve(
      style([sheet], '.brand span').background ?? '',
      style([sheet], ':root'),
    ).match(/#[0-9a-f]{6}/gi);
    assert.ok(gradient && gradient.length === 2, `${file}: a two-stop gradient`);
    const page404 = file.endsWith('404.html');
    const base = page404 ? '#060a14' : style([sheet], ':root')['--bg'];
    for (const stop of gradient) contrast(stop, base, 4.5, `${file}: ${stop} on the page`);
  }
  // A link to the start page says where it goes, as the app's own brand link does.
  assert.match(
    readFileSync('public/preparedness.html', 'utf8'),
    /<a class="brand" href="\/" aria-label="StormSignal home">/,
  );
  // The 404 page offers the kit and the guide, as well as the way back.
  const missing = readFileSync('public/404.html', 'utf8');
  for (const href of ['/', '/offline.html', '/preparedness.html'])
    assert.ok(missing.includes(`<a href="${href}">`), href);
});

test("the guide's footer stacks its two lines on a narrow screen, never running them together", () => {
  const sheet = pageStyle('public/preparedness.html');
  assert.equal(style([sheet], '.footer').display, 'flex');
  const narrow = mediaRules(sheet, /max-width:\s*650px/).filter(([names]) =>
    names.includes('.footer'),
  );
  assert.ok(narrow.length, 'the narrow layout sets the footer');
  for (const [, declarations] of narrow) {
    assert.notEqual(declarations.display, 'block', 'block runs its two inline lines together');
    assert.equal(declarations['flex-direction'], 'column');
  }
  assert.match(
    readFileSync('public/preparedness.html', 'utf8'),
    /<div class="footer">\s*<span>[^<]+<\/span\s*><span>[^<]+<\/span>\s*<\/div>/,
  );
});

test('the kit and the guide give their controls a 3:1 boundary, as the app does', () => {
  for (const [file, controls] of [
    ['public/offline.html', ['button', '.jump a', '.file-control input::file-selector-button']],
    ['public/preparedness.html', ['.toolbar button']],
  ] as const) {
    const sheet = pageStyle(file);
    const root = style([sheet], ':root');
    // Controls rest on the page, on panels and on the cards' own gradient.
    const card = style([sheet], '.card').background?.match(/#[0-9a-f]{6}/gi) ?? [];
    assert.ok(card.length, `${file}: the cards' colours`);
    for (const selector of controls) {
      const border = firstColour(style([sheet], selector).border);
      for (const background of [root['--bg'], root['--panel'], ...card])
        contrast(border, background, 3, `${file}: ${selector} border on ${background}`);
    }
  }
});

/** Every rule in source order, with the @media condition it sits in (null at the top level). */
function ordered(sheet: string) {
  const text = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: { media: string | null; selectors: string[]; declarations: Declarations }[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}' && --depth === 0) {
      const block = text.slice(from, index + 1).trim();
      from = index + 1;
      const media = block.startsWith('@media') ? block.slice(0, block.indexOf('{')).trim() : null;
      if (!media && block.startsWith('@')) continue;
      const body = media ? block.slice(block.indexOf('{') + 1, -1) : block;
      for (const [selectors, declarations] of rules(body))
        found.push({ media, selectors, declarations });
    }
  }
  return found;
}
/** A width condition only (not print, forced colours, a preference or a pointer type). */
const byWidth = (media: string | null): media is string =>
  !!media &&
  /(?:min|max)-width/.test(media) &&
  !/print|forced-colors|prefers-|hover|pointer/.test(media);
/** The value the cascade gives `selector`'s `property` at viewport `width` (that exact selector). */
function at(width: number, selector: string, property: string) {
  let value: string | undefined;
  for (const rule of lazy.flatMap(ordered)) {
    if (!rule.selectors.includes(selector) || rule.declarations[property] === undefined) continue;
    if (rule.media) {
      if (!byWidth(rule.media)) continue;
      const min = /min-width:\s*(\d+)px/.exec(rule.media);
      const max = /max-width:\s*(\d+)px/.exec(rule.media);
      if ((min && width < Number(min[1])) || (max && width > Number(max[1]))) continue;
    }
    value = rule.declarations[property];
  }
  return value;
}

test('no responsive rule is overridden at every width by a later rule for the same selector', () => {
  // The narrow sidebar's sizes once sat above the rules they adjust, which then won at every
  // width, and "Official alerts" wrapped at 1024px. The sheets are in cascade order: the lazily
  // loaded panels' sheets arrive after the dashboard's. A shorthand covers its longhands.
  const sides = (prefix: string) => ['top', 'right', 'bottom', 'left'].map((s) => `${prefix}-${s}`);
  const LONGHANDS: Record<string, string[]> = {
    margin: sides('margin'),
    'margin-inline': ['margin-left', 'margin-right'],
    'margin-block': ['margin-top', 'margin-bottom'],
    padding: sides('padding'),
    'padding-inline': ['padding-left', 'padding-right'],
    'padding-block': ['padding-top', 'padding-bottom'],
    inset: ['top', 'right', 'bottom', 'left'],
    gap: ['row-gap', 'column-gap'],
    overflow: ['overflow-x', 'overflow-y'],
    'place-items': ['align-items', 'justify-items'],
  };
  const longhands = (property: string) => LONGHANDS[property] ?? [property];
  const cascade = lazy.flatMap(ordered);
  assert.ok(cascade.filter((rule) => byWidth(rule.media)).length > 100, 'responsive rules found');
  const dead: string[] = [];
  cascade.forEach(({ media, selectors, declarations }, index) => {
    if (!byWidth(media)) return;
    for (const selector of selectors) {
      const later = new Set(
        cascade
          .slice(index + 1)
          .filter((rule) => !rule.media && rule.selectors.includes(selector))
          .flatMap((rule) => Object.keys(rule.declarations).flatMap(longhands)),
      );
      for (const [property, value] of Object.entries(declarations))
        if (!value.includes('!important') && longhands(property).every((p) => later.has(p)))
          dead.push(`${media} { ${selector} { ${property}: ${value} } }`);
    }
  });
  assert.deepEqual(dead, [], 'declarations that can never apply');
  // The sidebar narrows at 1250px and again at 1050px, and its labels with it.
  assert.equal(at(1440, 'nav a', 'font-size'), '13px');
  assert.equal(at(1200, 'nav a', 'font-size'), '12px');
  assert.equal(at(1200, 'nav a', 'padding-inline'), '10px');
  assert.equal(at(1024, 'nav a', 'font-size'), '11.5px');
  assert.equal(at(1024, 'nav a svg', 'width'), '16px');
  assert.equal(at(1024, '.nav-label', 'font-size'), '9px');
  assert.equal(at(390, 'nav a', 'font-size'), '13px', 'the phone drawer is not narrowed');
});

test('the footer, which ends the page, only fades in, so showing it never changes the height', () => {
  // A held section waits 26px below its place. At the end of the page that would make the page
  // taller until shown; reaching the end would then shrink it under the reader, and the browser
  // would pull the scroll position back, moving the page after it had landed.
  const html = renderAfter(() => {});
  assert.match(html, /<footer class="footer">[\s\S]*?<\/footer><\/main>/, 'the footer ends it');
  assert.ok(REVEAL_SELECTOR.split(',').some((part) => part.trim() === '.footer'));
  const motion = mediaRules(design, /prefers-reduced-motion:\s*no-preference/);
  const translate = (selector: string) =>
    motion.filter(([names, d]) => names.includes(selector) && d.translate).at(-1)?.[1].translate;
  assert.match(translate("[data-reveal='pending']") ?? '', /^0 [1-9]\d*px$/, 'others rise');
  assert.equal(translate(".footer[data-reveal='pending']"), 'none');
});

test('selected gradient text turns white, readable on the selection colour', () => {
  // Gradient text paints no fill of its own. Selected, the violet end would sit on the violet
  // selection at about 2.7:1.
  const gradient = rules(design)
    .filter(([, declarations]) => declarations['-webkit-text-fill-color'] === 'transparent')
    .flatMap(([names]) => names);
  assert.ok(gradient.includes('.temperature > span'), gradient.join());
  const highlight = style(dashboard, '::selection').background;
  for (const selector of [...gradient, '.temperature > span *']) {
    const fill = style(dashboard, `${selector}::selection`)['-webkit-text-fill-color'];
    assert.ok(fill, `${selector} has a fill of its own when selected`);
    for (const [where, surface] of Object.entries(surfaces()))
      contrast(fill, over(highlight, surface), 4.5, `selected ${selector} on ${where}`);
  }
});

test('printed, the page is ink on white even with background graphics, warnings included', () => {
  const print = mediaRules(design, /^@media print/);
  // Every fill inside the page goes, so text printed dark never lands on a dark box. Only the
  // legend swatches, which name the forecast series, keep theirs.
  const clear = print.find(([names]) => names.some((name) => name.startsWith('main *')));
  assert.ok(clear, 'fills inside the page are cleared');
  assert.deepEqual(clear[0], ['main *:not(.fe-legend i)']);
  assert.equal(clear[1].background, 'none !important');
  assert.equal(clear[1]['box-shadow'], 'none !important');
  // The paper below the content: the screen's base colour is set on :root, so print resets it there.
  assert.ok(print.some(([names, d]) => names.includes(':root') && d.background === 'white'));
  // Warning boxes set light text colours of their own for the dark screen: on paper, dark ink.
  const dark = print.filter(([, d]) => /!important$/.test(d.color ?? ''));
  const inked = dark.flatMap(([names]) => names);
  for (const box of [
    '.signal-strip',
    '.coverage-banner',
    '.official-alert',
    '.hazard-item',
    '.wide-notice',
    '.disaster-warning',
    '.briefing-warning',
  ])
    for (const selector of [box, `${box} *`]) assert.ok(inked.includes(selector), selector);
  for (const selector of ['.disaster-impact', '.source-missing', '.day-rain', '.briefing-remove'])
    assert.ok(inked.includes(selector), selector);
  for (const [names, d] of dark)
    contrast(d.color.replace(/\s*!important$/, ''), '#ffffff', 4.5, `${names[0]} on paper`);
});

test('printed, gradient text takes its text colour back, so no word prints blank', () => {
  // Gradient text paints its letters with its background. The print rule that clears every fill
  // inside the page cleared those too and left the letters transparent: the globe's title printed
  // "Your place on the" without "planet.". Every gradient, in any stylesheet and at any depth
  // (inside @supports too), is either inside the page, where that rule restores the fill, or in
  // the frame around it, which does not print.
  const [, clear] = mediaRules(design, /^@media print/).find(([names]) =>
    names.some((name) => name.startsWith('main *')),
  )!;
  assert.equal(clear['-webkit-text-fill-color'], 'currentColor !important');
  const gradients = lazy.flatMap((sheet) =>
    [...sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /-webkit-text-fill-color:\s*transparent/.test(body))
      .flatMap(([, selectors]) => selectors.split(',').map((part) => part.trim())),
  );
  assert.ok(gradients.includes('.globe-accent'), gradients.join());
  // Full workspace, where the most is on the page, the globe included.
  local.setItem('stormsignal:connection-mode', 'full');
  const html = renderAfter(() => {});
  const main = /<main[\s\S]*<\/main>/.exec(html)![0];
  const [sidebar, topbar] = [/<aside[\s\S]*?<\/aside>/, /<header[\s\S]*?<\/header>/].map(
    (part) => part.exec(html)![0],
  );
  const frame = sidebar + topbar;
  const unprinted = mediaRules(css('styles.css'), /^@media print/)
    .filter(([, declarations]) => /^none\b/.test(declarations.display ?? ''))
    .flatMap(([names]) => names);
  for (const part of ['.sidebar', '.topbar']) assert.ok(unprinted.includes(part), part);
  // The globe's card is rendered inside the page: its skeleton is there before its code arrives.
  assert.match(main, /class="globe-slot"/);
  const elsewhere = html.replace(main, '').replace(sidebar, '').replace(topbar, '');
  for (const selector of gradients) {
    const name = /\.([\w-]+)/.exec(selector)![1];
    if (name.startsWith('globe-')) continue;
    const used = new RegExp(`class="(?:[^"]* )?${name}(?: [^"]*)?"`);
    assert.ok(used.test(main) || used.test(frame), `${selector} is on the page`);
    assert.ok(!used.test(elsewhere), `${selector} is not outside the page and its frame`);
  }
});

test('the sidebar scrolls only up and down, so its brand never adds a sideways scrollbar', () => {
  // With an always-shown scrollbar (Windows, Linux, macOS with a mouse), the tagline ended 2px
  // past the sidebar's inner edge from 1251px up, and a horizontal scrollbar appeared under it.
  const sidebar = style(dashboard, '.sidebar');
  assert.equal(sidebar['overflow-y'], 'auto');
  assert.match(sidebar['overflow-x'] ?? '', /^(?:hidden|clip)$/);
  // The tagline keeps the spacing that fits beside that scrollbar at every width.
  for (const width of [1440, 1300, 1251, 1250, 1100, 1024, 801])
    assert.ok(Number.parseFloat(at(width, '.brand small', 'letter-spacing')!) <= 0.12, `${width}`);
});

test('the brand and the search key keep the sizes they had before the palette', () => {
  // The redesign had made them a pixel smaller. Measured beside an always-shown scrollbar, the
  // brand at these sizes still ends 7px or more inside the sidebar's padding.
  for (const [width, size] of [
    [1440, '24px'],
    [1251, '24px'],
    [1200, '22px'],
    [1024, '20px'],
  ] as const)
    assert.equal(at(width, '.brand', 'font-size'), size, `${width}px`);
  assert.equal(style(dashboard, 'kbd')['font-size'], '12px');
});

test('the satellite status pill is never capped narrower than its one-line label', () => {
  // WeatherMap.css keeps the label on one line. A 72px cap from 801 to 1250px cut it off at the
  // card's edge: "OBSERVED IMAG" at 1024px.
  for (const width of [1440, 1251, 1250, 1100, 1024, 900, 801, 800, 600, 390]) {
    const nowrap = at(width, '.storm-map-state', 'white-space') === 'nowrap';
    const max = at(width, '.storm-map-state', 'max-width');
    assert.ok(!nowrap || max === undefined || max === 'none', `${width}px: max-width ${max}`);
  }
  assert.equal(at(1024, '.storm-map-state', 'white-space'), 'nowrap');
});

test('separators in the breadcrumb and the place line keep 3:1, as control boundaries do', () => {
  // The boundary token keeps 3:1 on every surface (checked above); the separators use it.
  const boundary = token('--aurora-line-strong');
  for (const selector of ['.breadcrumb span', '.location-eyebrow span'])
    assert.equal(style(dashboard, selector).color, boundary, selector);
  // They are decoration, so screen readers skip them: "Workspace, Weather overview".
  const html = renderAfter(() => {});
  assert.match(
    html,
    /<div class="breadcrumb">Workspace <span aria-hidden="true">\/<\/span> <strong>/,
  );
  assert.match(
    /<div class="eyebrow location-eyebrow">[\s\S]*?<\/div>/.exec(html)?.[0] ?? '',
    /<span aria-hidden="true"> \/ <\/span>/,
  );
});

test('a missing temperature is plain muted text: the gradient made its dash a decorative bar', () => {
  const missing = renderAfter(() => {});
  assert.match(missing, /<div class="temperature is-missing"><span>—<sup>°<\/sup><\/span><\/div>/);
  loaded.forecast = forecast(Date.now());
  assert.match(
    renderAfter(() => {}),
    /<div class="temperature"><span>27<sup>°<\/sup><\/span><\/div>/,
  );
  const dash = style(dashboard, '.temperature.is-missing > span');
  assert.equal(dash.background, 'none');
  assert.equal(dash['-webkit-text-fill-color'], 'currentColor');
  assert.equal(dash.color, token('--aurora-muted'));
  contrast(dash.color, style(dashboard, '.conditions-card')['--hero-base'], 4.5, 'the dash');
});

test('printed at any page width, the frame and the page actions stay off the paper', () => {
  // Print rules come before the narrow layouts, and on a page 600px wide or less the actions'
  // display: grid won: Saved and Refresh printed.
  const hidden = mediaRules(css('styles.css'), /^@media print/).filter(([, declarations]) =>
    /^none\b/.test(declarations.display ?? ''),
  );
  const names = hidden.flatMap(([selectors]) => selectors);
  for (const selector of ['.sidebar', '.topbar', '.heading-actions', '.map-card', '.footer'])
    assert.ok(names.includes(selector), selector);
  for (const [selectors, declarations] of hidden)
    if (selectors.includes('.heading-actions'))
      assert.equal(declarations.display, 'none !important', selectors.join());
  assert.equal(at(390, '.heading-actions', 'display'), 'grid', 'the narrow layout it must beat');
});

test('forecast indicators keep 4.5:1 for every line of text, with some margin for the smallest', () => {
  // The 9px detail line measured exactly 4.50:1 on the elevated fill.
  for (const [fill, texts] of [
    ['.hazard-item', ['.hazard-item strong', '.hazard-item p', '.hazard-level']],
    [
      '.hazard-item.high',
      ['.hazard-item.high strong', '.hazard-item p', '.hazard-item.high .hazard-level'],
    ],
  ] as const) {
    const background = style(dashboard, fill).background;
    for (const text of texts)
      contrast(style(dashboard, text).color, background, 4.5, `${text} on ${fill}`);
    contrast(style(dashboard, '.hazard-item small').color, background, 4.8, `detail on ${fill}`);
  }
});

test('the data saver switch is named "Data saver", with its state in aria-pressed alone', () => {
  // Its name once carried its state as well: "Data saver on, pressed".
  const sources = (html: string) =>
    /<section class="panel sources-panel"[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
  const lite = sources(renderAfter(() => {}));
  assert.match(lite, /<button class="quiet-button enabled" aria-pressed="true">/);
  assert.equal(plain(lite.slice(lite.lastIndexOf('<button'))), 'Data saver');
  local.setItem('stormsignal:connection-mode', 'full');
  const full = sources(renderAfter(() => {}));
  assert.match(full, /<button class="quiet-button " aria-pressed="false">/);
  assert.equal(plain(full.slice(full.lastIndexOf('<button'))), 'Data saver');
});

test('section headings carry an icon, never a lone number with no others to count', () => {
  local.setItem('stormsignal:connection-mode', 'full');
  const html = renderAfter(() => {});
  assert.match(html, /<h2>One forecast\. Multiple perspectives\.<\/h2><\/div><svg/);
  assert.doesNotMatch(html, /panel-number/);
  for (const sheet of dashboard) assert.doesNotMatch(sheet, /\.panel-number/);
});

test("a message's dismiss button keeps to its trailing edge, and the open drawer dims the page", () => {
  assert.equal(style(dashboard, '.toast').display, 'flex');
  assert.equal(style(dashboard, '.toast > .icon-button')['margin-left'], 'auto');
  // The drawer is a modal dialog: the page behind it dims, under the drawer and over the rest,
  // a waiting message included. It takes no pointer: the page behind is inert anyway.
  const found = mediaRules(design, /^@media \(max-width: 800px\)$/).find(([names]) =>
    names.includes('.app-shell:has(> .sidebar.open)::after'),
  );
  assert.ok(found, 'the open drawer has a scrim on phones and tablets');
  const [, scrim] = found;
  assert.equal(scrim['pointer-events'], 'none');
  assert.equal(scrim.position, 'fixed');
  const layer = (selector: string) => Number(style(dashboard, selector)['z-index']);
  const z = Number(scrim['z-index']);
  assert.ok(z < layer('.sidebar'), 'under the drawer');
  assert.ok(z > layer('.sidebar.open ~ .toast') && z > layer('.topbar'), 'over the page');
  assert.ok(channels(scrim.background)[3] >= 0.5, 'dim enough to read as behind');
});

test('the precipitation period wraps as a whole, never before its last word', () => {
  const html = renderAfter(() => {});
  assert.match(html, /mm · <span>last 15 min<\/span>/);
  assert.equal(style(dashboard, '.condition-metrics strong small span')['white-space'], 'nowrap');
});

test('the globe card keeps the page rhythm: the corners of the hero cards, the gap between blocks', () => {
  for (const width of [1440, 1024, 390]) {
    const corners = at(width, '.globe-view', 'border-radius');
    assert.equal(corners, at(width, '.conditions-card', 'border-radius'), `${width}px corners`);
    assert.equal(corners, at(width, '.map-card', 'border-radius'), `${width}px corners`);
    assert.equal(
      at(width, '.globe-slot', 'margin-bottom'),
      at(width, '.field-controls', 'margin-bottom'),
      `${width}px: the gap below the globe is the gap below the settings above it`,
    );
    // App's notice when the globe's code cannot load takes the card's place, gap and corners
    // included: its two classes outrank the .panel corners that load after it.
    assert.equal(
      at(width, '.globe-unavailable', 'margin-bottom'),
      at(width, '.globe-slot', 'margin-bottom'),
      `${width}px: the gap below the notice`,
    );
    assert.equal(at(width, '.panel.globe-unavailable', 'border-radius'), corners, `${width}px`);
    assert.notEqual(at(width, '.panel', 'border-radius'), corners, `${width}px: not a panel's`);
  }
  assert.equal(at(390, '.globe-slot', 'margin-bottom'), '18px');
});

test("the globe's surface shows one focus ring, its own, not the page's outline as well", () => {
  // frontend-design.css outlines any [tabindex='0'] on focus, and loads after GlobeView.css with
  // a more specific selector than .globe-surface: the surface drew a second ring, clipped by the
  // card, beside its own inset ring in the palette's focus colour.
  const specificity = (selector: string) =>
    selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g)?.length ?? 0;
  const page = "[tabindex='0']:focus-visible";
  const own = '.globe-view .globe-surface:focus-visible';
  assert.equal(style(dashboard, own).outline, 'none');
  assert.ok(specificity(own) > specificity(page), `${own} wins over ${page}`);
  const ring = firstColour(style(dashboard, page).outline);
  assert.equal(style(dashboard, '.globe-view')['--globe-focus'], ring, 'the same lavender');
});
