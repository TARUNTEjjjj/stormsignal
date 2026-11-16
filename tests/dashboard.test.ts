import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Day, Forecast, Hour, Place } from '../src/types';

// Compile the real dashboard. Server rendering runs no effects, so App's loaders never fetch:
// its resource hook returns the forecast a test puts in `loaded`. The optional map and report
// panels load Leaflet and are not under test, so they are replaced by empty components.
const require = createRequire(import.meta.url);
const source = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
const loaded: { forecast: Forecast | null } = { forecast: null };
Object.assign(globalThis, { __dashboardTestLoaded: loaded });
const temporary = await mkdtemp(join(tmpdir(), 'stormsignal-dashboard-'));
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
        name: 'dashboard-test',
        setup(builder) {
          builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, ({ path }) => ({
            path: require.resolve(path),
            external: true,
          }));
          builder.onResolve({ filter: /^\.\/components\/(?:WeatherMap|DisasterWatch)$/ }, () => ({
            path: 'optional-tool',
            namespace: 'dashboard-test',
          }));
          builder.onResolve({ filter: /^\.\/resource$/ }, ({ importer }) =>
            importer === source('App.tsx')
              ? { path: 'loaded-resource', namespace: 'dashboard-test' }
              : undefined,
          );
          builder.onLoad({ filter: /^optional-tool$/, namespace: 'dashboard-test' }, () => ({
            contents: 'export default function OptionalTool() { return null; }',
            loader: 'js',
          }));
          builder.onLoad({ filter: /^loaded-resource$/, namespace: 'dashboard-test' }, () => ({
            contents: `
              import { currentResource as current, loadResource } from './resource';
              import { fetchCompactForecast, fetchForecast } from './data';
              export { loadResource };
              export function currentResource(state, key, loader, enabled) {
                const forecast = globalThis.__dashboardTestLoaded.forecast;
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

// The browser APIs App reads while rendering: a wide window, a connection, both storage areas and
// a geolocation service whose answer each test delivers when it chooses.
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
const session = memoryStorage();
const located: { success: PositionCallback; failure?: PositionErrorCallback | null }[] = [];
const browser = {
  window: { innerWidth: 1280 },
  navigator: {
    onLine: true,
    geolocation: {
      getCurrentPosition(success: PositionCallback, failure?: PositionErrorCallback | null) {
        located.push({ success, failure });
      },
    },
  },
  localStorage: local,
  sessionStorage: session,
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
  session.items.clear();
  located.length = 0;
  loaded.forecast = null;
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
function hour(time: number, overrides: Partial<Hour> = {}): Hour {
  return {
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
    ...overrides,
  };
}
/** A fresh forecast whose hourly steps start at `now`; `hours` overrides steps by index. */
function forecast(
  now: number,
  hours: Record<number, Partial<Hour>> = {},
  current: Partial<Hour> = {},
): Forecast {
  return {
    fetchedAt: now,
    timezone: 'Asia/Kolkata',
    current: hour(now - 10 * 60_000, current),
    hours: Array.from({ length: 27 }, (_, index) => hour(now + index * HOUR, hours[index])),
    days: [],
    source: 'Open-Meteo · weather model estimates',
  };
}
function day(time: number): Day {
  return {
    time,
    high: 18,
    low: 9,
    rain: 0,
    probability: 10,
    gust: 30,
    code: 1,
    sunrise: null,
    sunset: null,
  };
}
const render = () => renderToStaticMarkup(createElement(App));
function between(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  assert.ok(from >= 0, `the page has no ${start}`);
  const to = html.indexOf(end, from + start.length);
  return html.slice(from, to < 0 ? undefined : to);
}
const plain = (html: string) => html.replace(/<[^>]*>/g, '');

/**
 * Render the dashboard and act on it while it renders. Server rendering applies state updates
 * made during a render and then renders the component again, so the clicks and location answers
 * below run App's own handlers and the returned markup shows the state they leave behind.
 */
function renderAfter(act: (dashboard: ReactNode) => void): string {
  let acted = false;
  return renderToStaticMarkup(
    createElement(function Dashboard() {
      const dashboard = App();
      if (!acted) {
        acted = true;
        act(dashboard);
      }
      return dashboard;
    }),
  );
}
type Markup = ReactElement<{ children?: ReactNode; onClick?: () => void; 'aria-label'?: string }>;
function* elements(node: ReactNode): Generator<Markup> {
  if (Array.isArray(node)) for (const child of node) yield* elements(child);
  else if (isValidElement<Markup['props']>(node)) {
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
/** Click the first button named `name`, by its label or by the text it starts with. */
function click(dashboard: ReactNode, name: string) {
  const button = [...elements(dashboard)].find(
    (element) =>
      element.type === 'button' &&
      (element.props['aria-label'] === name || text(element).startsWith(name)),
  );
  assert.ok(button?.props.onClick, `the dashboard has no "${name}" button`);
  button.props.onClick();
}
const heading = (html: string) => /<h1>(.*?)<span class="heading-dot">/.exec(html)?.[1];
const toast = (html: string) => plain(/<div class="toast"[^>]*>(.*?)<\/div>/.exec(html)?.[1] ?? '');
const locateButton = (html: string) =>
  /<button[^>]*aria-label="Use my location"[^>]*>/.exec(html)?.[0];
const position = (latitude: number, longitude: number) =>
  ({ coords: { latitude, longitude } }) as GeolocationPosition;

test('the signals panel lists every forecast signal the summary counts', (t) => {
  // A hot, stormy day in Chennai crosses five screening thresholds; the thunderstorm comes last.
  const now = Date.UTC(2026, 10, 16, 3);
  t.mock.timers.enable({ apis: ['Date'], now });
  loaded.forecast = forecast(now, {
    4: { uv: 9.2 },
    5: { apparent: 41, uv: 10 },
    8: { precipitation: 8, gust: 62 },
    9: { code: 95 },
  });
  const html = render();
  assert.match(html, /5 weather signals in the next 24 hours/);
  const panel = between(html, 'class="panel hazards-panel"', '</section>');
  const titles = [...panel.matchAll(/class="hazard-item \w+">[\s\S]*?<strong>(.*?)<\/strong>/g)];
  assert.deepEqual(
    titles.map((match) => match[1]),
    [
      'High UV signal',
      'Heat exposure signal',
      'Heavy rain signal',
      'Strong gust signal',
      'Thunderstorm signal',
    ],
  );
});

test('the 7-day outlook names the provider day after a clock change', (t) => {
  // Saturday 31 October 2026, noon in New York. Open-Meteo starts every day at midnight by the
  // offset in force when asked (UTC−4), so the days after Sunday's change start at 23:00.
  const now = Date.UTC(2026, 9, 31, 16);
  t.mock.timers.enable({ apis: ['Date'], now });
  local.setItem('stormsignal:connection-mode', 'full');
  loaded.forecast = {
    ...forecast(now),
    timezone: 'America/New_York',
    days: Array.from({ length: 7 }, (_, index) => day(Date.UTC(2026, 9, 31, 4) + index * DAY)),
  };
  const outlook = between(render(), 'class="daily-list"', 'class="sun-times"');
  assert.deepEqual(
    [...outlook.matchAll(/<div class="day-row"><span>(.*?)<\/span>/g)].map((match) => match[1]),
    ['Today', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  );
});

test('the current precipitation tile says its amount is for 15 minutes, not an hour', (t) => {
  // Open-Meteo's current block sums precipitation over its 15-minute interval; every other rain
  // figure on the dashboard is an hourly total.
  const now = Date.UTC(2026, 10, 16, 3);
  t.mock.timers.enable({ apis: ['Date'], now });
  loaded.forecast = forecast(now, { 0: { precipitation: 1.6 } }, { precipitation: 0.4 });
  const tile = plain(between(render(), 'Precipitation', '</strong>'));
  assert.match(tile, /^Precipitation0\.4 mm\b.*\b15 min\b/);
});

test('heavy rain and heavy snow in the next 24 hours each show a card with its own icon', (t) => {
  const now = Date.UTC(2026, 10, 16, 3);
  t.mock.timers.enable({ apis: ['Date'], now });
  loaded.forecast = forecast(now, {
    3: { code: 63, precipitation: 7 },
    10: { code: 75, temperature: -2, apparent: -6, precipitation: 16 },
  });
  const html = render();
  assert.match(html, /2 weather signals in the next 24 hours/);
  const panel = between(html, 'class="panel hazards-panel"', '</section>');
  const cards = [
    ...panel.matchAll(
      /class="hazard-item \w+"><span class="hazard-symbol">(.*?)<\/span>[\s\S]*?<strong>(.*?)<\/strong>/g,
    ),
  ].map((match) => [match[2], /\blucide-([a-z-]+)/.exec(match[1])?.[1]]);
  assert.deepEqual(cards, [
    ['Heavy snow signal', 'cloud-snow'],
    ['Heavy rain signal', 'cloud-rain'],
  ]);
});

test('hourly chances and the screening thresholds say precipitation, since they include snow', (t) => {
  // Open-Meteo's precipitation and its probability cover rain, showers and snow.
  const now = Date.UTC(2026, 10, 16, 3);
  t.mock.timers.enable({ apis: ['Date'], now });
  loaded.forecast = forecast(now, {
    1: { code: 73, temperature: -2, probability: 80 },
    2: { probability: null },
  });
  const html = render();
  const tiles = plain(between(html, 'class="horizon-hours"', 'class="condition-footer"'));
  assert.doesNotMatch(tiles, /rain/i);
  assert.deepEqual(tiles.match(/\d+% precip\.|Precip\. chance —/g), [
    '10% precip.',
    '80% precip.',
    'Precip. chance —',
  ]);
  const thresholds = plain(between(html, 'Elevated / high screening thresholds', '</p>'));
  assert.match(thresholds, /: hourly precipitation 5 \/ 15 mm \(rain, showers and snow as liquid/);
  assert.doesNotMatch(thresholds, /hourly rain/);
});

test('clear hours on the horizon show the moon at night and the sun by day', async (t) => {
  const horizon = (now: number) => {
    loaded.forecast = forecast(now);
    return between(render(), 'class="horizon-hours"', 'class="condition-footer"');
  };
  await t.test('night', (t) => {
    // 23:30 in Chennai: the next three steps are all before sunrise.
    const now = Date.UTC(2026, 10, 16, 18);
    t.mock.timers.enable({ apis: ['Date'], now });
    const tiles = horizon(now);
    assert.equal(tiles.match(/lucide-moon/g)?.length, 3);
    assert.doesNotMatch(tiles, /lucide-sun/);
    // The icon is the only statement of the condition in these tiles, so it is named.
    assert.equal(tiles.match(/aria-label="Clear sky"/g)?.length, 3);
    assert.doesNotMatch(tiles, /aria-hidden/);
  });
  await t.test('day', (t) => {
    // 11:30 in Chennai.
    const now = Date.UTC(2026, 10, 16, 6);
    t.mock.timers.enable({ apis: ['Date'], now });
    const tiles = horizon(now);
    assert.equal(tiles.match(/lucide-sun/g)?.length, 3);
    assert.doesNotMatch(tiles, /lucide-moon/);
  });
});

test('a place chosen while device location is pending is kept when the location arrives', () => {
  const html = renderAfter((dashboard) => {
    click(dashboard, 'Use my location');
    click(dashboard, 'Tokyo');
    located[0].success(position(13, 80.2));
  });
  assert.equal(heading(html), 'Tokyo');
  // The superseded request no longer blocks the button.
  assert.doesNotMatch(locateButton(html) ?? '', /disabled/);
});

test('device location still opens when nothing else was chosen meanwhile', () => {
  const html = renderAfter((dashboard) => {
    click(dashboard, 'Use my location');
    located[0].success(position(13, 80.2));
  });
  assert.equal(heading(html), 'My location');
  assert.doesNotMatch(locateButton(html) ?? '', /disabled/);
});

test('a location failure after another place was chosen raises no error message', () => {
  const html = renderAfter((dashboard) => {
    click(dashboard, 'Use my location');
    click(dashboard, 'Tokyo');
    located[0].failure?.({ code: 1, message: 'denied' } as GeolocationPositionError);
  });
  assert.equal(heading(html), 'Tokyo');
  assert.equal(toast(html), '');
});

const at = (name: string, latitude: number, longitude: number): Place => ({
  id: name.toLowerCase().replaceAll(' ', '-'),
  name,
  country: 'Testland',
  countryCode: 'TL',
  latitude,
  longitude,
});
const tokyo = at('Tokyo', 35.6762, 139.6503);
const london = at('London', 51.5085, -0.1257);
const stored = () =>
  (JSON.parse(local.getItem('stormsignal:places') ?? 'null') as Place[] | null)?.map(
    (place) => place.name,
  );

test('saving a place keeps the places another window saved after this one opened', () => {
  local.setItem('stormsignal:places', JSON.stringify([tokyo]));
  const html = renderAfter((dashboard) => {
    // Another dashboard saves London; this one still lists only Tokyo. Save Chennai here.
    local.setItem('stormsignal:places', JSON.stringify([london, tokyo]));
    click(dashboard, 'Save place');
  });
  assert.deepEqual(stored(), ['Chennai', 'London', 'Tokyo']);
  assert.equal(toast(html), 'Place saved on this device.');
  const list = between(html, 'aria-label="Saved places"', '</section>');
  assert.deepEqual(
    [...list.matchAll(/<span>([^<]+)<small>/g)].map((match) => match[1]),
    ['Chennai', 'London', 'Tokyo'],
  );
});

test('removing a place does not bring back places another window cleared', () => {
  local.setItem('stormsignal:places', JSON.stringify([at('Chennai', 13.0827, 80.2707), tokyo]));
  renderAfter((dashboard) => {
    // Another dashboard clears the saved places; this one still shows Chennai as saved.
    local.removeItem('stormsignal:places');
    click(dashboard, 'Saved');
  });
  assert.deepEqual(stored(), []);
});

test('a ninth saved place names the place the eight-place limit removed', () => {
  const eight = Array.from({ length: 8 }, (_, index) => at(`Saved ${index + 1}`, 10 + index, 10));
  local.setItem('stormsignal:places', JSON.stringify(eight));
  const html = renderAfter((dashboard) => click(dashboard, 'Save place'));
  assert.deepEqual(stored(), ['Chennai', ...eight.slice(0, 7).map((place) => place.name)]);
  assert.match(toast(html), /^Place saved on this device\. .*\b8 places\b.*\bSaved 8\b/);
});
