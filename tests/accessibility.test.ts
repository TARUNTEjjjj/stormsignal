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
        resolved[property] = value.replace(
          /var\((--[\w-]+)\)/g,
          (variable, name: string) => variables[name] ?? variable,
        );
  return resolved;
}
const css = (path: string) => readFileSync(source(path), 'utf8');
const dashboard = ['components/ForecastExplorer.css', 'styles.css', 'frontend-design.css'].map(css);
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
