import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// @ts-expect-error Shared native ESM resource-library module.
import { createReloadGuard } from '../resources/app-updates.mjs';
import type { Forecast, Hour, Place } from '../src/types';

// Compile the real panels with the application's JSX settings and render them on the server, as
// tests/forecast-explorer.test.ts does. Leaflet reads the DOM as it loads, so the map gets an empty
// stand-in: the map uses it only in effects, which server rendering does not run.
const require = createRequire(import.meta.url);
const PANELS = ['ForecastExplorer', 'WeatherMap', 'OfflineBriefing'];
const temporary = await mkdtemp(join(tmpdir(), 'stormsignal-panels-'));
let ForecastExplorer: typeof import('../src/components/ForecastExplorer').default;
let WeatherMap: typeof import('../src/components/WeatherMap').default;
let OfflineBriefing: typeof import('../src/components/OfflineBriefing').default;
try {
  await build({
    entryPoints: PANELS.map((name) =>
      fileURLToPath(new URL(`../src/components/${name}.tsx`, import.meta.url)),
    ),
    outdir: temporary,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    mainFields: ['module', 'main'],
    loader: { '.css': 'empty' },
    logLevel: 'error',
    plugins: [
      {
        name: 'rendered-panels',
        setup(builder) {
          builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, ({ path }) => ({
            path: require.resolve(path),
            external: true,
          }));
          builder.onResolve({ filter: /^leaflet$/ }, () => ({
            path: 'leaflet',
            namespace: 'stub',
          }));
          builder.onLoad({ filter: /^leaflet$/, namespace: 'stub' }, () => ({
            contents: 'export default {};',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const panel = async (name: string) =>
    (await import(pathToFileURL(join(temporary, `${name}.mjs`)).href)).default;
  [ForecastExplorer, WeatherMap, OfflineBriefing] = await Promise.all(PANELS.map(panel));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const NOW = Date.UTC(2026, 10, 16, 3);
const HOUR = 3_600_000;
const chennai: Place = {
  id: 'chennai',
  name: 'Chennai',
  country: 'India',
  countryCode: 'IN',
  latitude: 13.0827,
  longitude: 80.2707,
  timezone: 'Asia/Kolkata',
};
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
    code: 3,
    uv: 0,
    ...overrides,
  };
}
const forecast: Forecast = {
  fetchedAt: NOW,
  timezone: 'Asia/Kolkata',
  current: hour(NOW - 10 * 60_000),
  hours: [hour(NOW), hour(NOW + HOUR, { code: 75, temperature: -2, precipitation: 2.4 })],
  days: [],
  source: 'Open-Meteo · weather model estimates',
};

type Markup = ReactElement<{ children?: ReactNode; className?: string; onClick?: () => void }>;
function find(node: ReactNode, wanted: (element: Markup) => boolean): Markup | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, wanted);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Markup['props']>(node)) return undefined;
  return wanted(node) ? node : find(node.props.children, wanted);
}
/**
 * The offline briefing panel showing a briefing of `forecast`. Server rendering runs no effects, so
 * the panel never reads saved briefings from storage; saving one while it renders updates its
 * state, and React renders it again with that briefing selected.
 */
function savedBriefingPanel(t: TestContext): string {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const items = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  Object.defineProperty(globalThis, 'window', { value: { localStorage }, configurable: true });
  t.after(() => void delete (globalThis as { window?: unknown }).window);
  let saved = false;
  return renderToStaticMarkup(
    createElement(function Panel() {
      const panel = OfflineBriefing({
        place: chennai,
        forecast,
        alerts: null,
        now: NOW,
        offline: false,
        canSave: true,
      });
      if (!saved) {
        saved = true;
        find(panel, (element) => element.props.className === 'primary-button')?.props.onClick?.();
      }
      return panel;
    }),
  );
}

/** Enough of Element.closest() for attribute selectors, tested on the element itself. */
function matches(attributes: Map<string, string>, selector: string): boolean {
  const not = /^(.+):not\((.+)\)$/.exec(selector);
  if (not) return matches(attributes, not[1]) && !matches(attributes, not[2]);
  const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (!attribute) throw new Error(`Unsupported selector ${selector}`);
  const [, name, value] = attribute;
  return attributes.has(name) && (value === undefined || attributes.get(name) === value);
}
/**
 * Whether the app-update guard holds an update back after the user focuses the control that
 * `tag` opens, moves it and leaves it focused. The guard is the one the dashboard runs.
 */
function holdsUpdateBack(tag: string): boolean {
  const attributes = new Map(
    [...tag.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? '']),
  );
  const control = {
    tagName: /^<(\w+)/.exec(tag)![1].toUpperCase(),
    type: attributes.get('type'),
    value: attributes.get('value') ?? '0',
    isConnected: true,
    closest: (selector: string) => (matches(attributes, selector) ? control : null),
  };
  let clock = 0;
  const listeners = new Map<string, (event: { target: unknown }) => void>();
  const page = {
    activeElement: null as unknown,
    addEventListener: (name: string, listener: (event: { target: unknown }) => void) =>
      void listeners.set(name, listener),
    removeEventListener() {},
    querySelectorAll: () => [],
  };
  const guard = createReloadGuard({ documentObject: page, windowObject: {}, now: () => clock });
  listeners.get('focusin')!({ target: control });
  control.value += '1';
  listeners.get('change')!({ target: control });
  page.activeElement = control;
  clock += 60_000;
  try {
    return !guard.canReload();
  } finally {
    guard.dispose();
  }
}
const opening = (html: string, tag: RegExp) => html.match(tag)?.[0] ?? '';

test('moving a view-only control never holds back an app update', (t) => {
  // Each of these chooses only what is shown. An update reload resets it, and nothing is lost.
  const explorer = renderToStaticMarkup(
    createElement(ForecastExplorer, { hours: forecast.hours, models: [], timezone: 'UTC' }),
  );
  const map = renderToStaticMarkup(
    createElement(WeatherMap, {
      place: chennai,
      alerts: [],
      clockOffset: undefined,
      lowBandwidth: false,
      onSelect: () => {},
    }),
  );
  const briefing = savedBriefingPanel(t);
  const controls = {
    'forecast hour slider': opening(explorer, /<input[^>]*type="range"[^>]*>/),
    'satellite layer': opening(map, /<select[^>]*id="satellite-source"[^>]*>/),
    'satellite frame slider': opening(map, /<input[^>]*id="satellite-frame"[^>]*>/),
    'saved briefing choice': opening(briefing, /<select[^>]*id="saved-briefing"[^>]*>/),
  };
  for (const [name, tag] of Object.entries(controls)) {
    assert.ok(tag, `the ${name} is rendered`);
    assert.equal(holdsUpdateBack(tag), false, `the ${name} held back an update: ${tag}`);
  }
  // A control holding a choice the user has not finished with still holds an update back.
  assert.equal(holdsUpdateBack('<select id="answer">'), true);
  assert.equal(holdsUpdateBack('<input type="range" data-update-safe="false" value="1">'), true);
});

test('the saved hourly table calls each amount precipitation, since it includes snow', (t) => {
  // Open-Meteo's precipitation and its probability cover rain, showers and snow as liquid water.
  const html = savedBriefingPanel(t);
  const table = html.slice(html.indexOf('<details class="briefing-hours">'));
  assert.match(
    table,
    /Each precipitation value is for one hour, with snow counted as liquid water/,
  );
  assert.match(table, /<th scope="col">Precip\. mm<\/th>/);
  assert.match(table, /<td>-2<\/td><td>29<\/td><td>2\.4<\/td><td>10<\/td>/);
  assert.doesNotMatch(table.slice(0, table.indexOf('</details>')), /\brain/i);
});
