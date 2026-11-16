import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  createElement,
  Fragment,
  isValidElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Hour, ModelForecast } from '../src/types';
import { forecastWindow } from '../src/forecast-chart';

// Compile the real component with the application's JSX settings. CSS has no
// server-rendered behavior; resolve React to the same instance as the renderer.
const require = createRequire(import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), 'stormsignal-render-'));
let ForecastExplorer: ComponentType<{ hours: Hour[]; models: ModelForecast[]; timezone: string }>;
try {
  const outfile = join(temporary, 'forecast-explorer.mjs');
  await build({
    entryPoints: [
      fileURLToPath(new URL('../src/components/ForecastExplorer.tsx', import.meta.url)),
    ],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    mainFields: ['module', 'main'],
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'shared-react',
        setup(builder) {
          builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({
            path: require.resolve(path),
            external: true,
          }));
        },
      },
    ],
  });
  ForecastExplorer = (await import(pathToFileURL(outfile).href)).default;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 1, 5);
function hour(time: number, overrides: Partial<Hour> = {}): Hour {
  return {
    time,
    temperature: 21,
    apparent: 20,
    precipitation: 0,
    probability: 10,
    wind: 5,
    gust: 12,
    humidity: 60,
    code: 3,
    uv: 0,
    ...overrides,
  };
}
function render(hours: Hour[], models: ModelForecast[] = [], timezone = 'UTC') {
  return renderToStaticMarkup(createElement(ForecastExplorer, { hours, models, timezone }));
}
type Props = { hours: Hour[]; models: ModelForecast[]; timezone: string };
type Markup = ReactElement<{ title?: string; children?: ReactNode; onClick?: () => void }>;
/** Static markup carries no event handlers, so read them from the element tree of one render. */
function elementTree(props: Props) {
  let tree: ReactNode;
  renderToStaticMarkup(
    createElement(function Probe() {
      return (tree = (ForecastExplorer as (props: Props) => ReactNode)(props));
    }),
  );
  return tree;
}
function findElement(node: ReactNode, wanted: (element: Markup) => boolean): Markup | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, wanted);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Markup['props']>(node)) return undefined;
  return wanted(node) ? node : findElement(node.props.children, wanted);
}
type SliderProps = {
  type?: string;
  value?: number;
  'aria-valuetext'?: string;
  onChange?: (event: { target: { value: string } }) => void;
};
function hourSlider(tree: ReactNode) {
  return findElement(
    tree,
    (element) => element.type === 'input' && (element.props as SliderProps).type === 'range',
  )?.props as SliderProps | undefined;
}
function durationButton(tree: ReactNode, label: string) {
  return findElement(
    tree,
    (element) => element.type === 'button' && [element.props.children].flat().join('') === label,
  )?.props;
}
/**
 * Renders one explorer once per step, with that step's hours, and applies the step's interaction
 * to that render. An update during render makes React render the component again at once with
 * its state kept, so every step reaches the same explorer, as App's re-renders do. Returns the
 * element tree of the last step.
 */
function explore(steps: { hours: Hour[]; act?: (tree: ReactNode) => void }[]) {
  let pass = 0;
  let tree: ReactNode;
  renderToStaticMarkup(
    createElement(function Probe() {
      const step = steps[Math.min(pass++, steps.length - 1)];
      tree = (ForecastExplorer as (props: Props) => ReactNode)({
        hours: step.hours,
        models: [],
        timezone: 'UTC',
      });
      step.act?.(tree);
      return tree;
    }),
  );
  assert.equal(pass, steps.length, 'every interaction updated the explorer');
  return tree;
}
const selectHour = (position: number) => (tree: ReactNode) =>
  hourSlider(tree)?.onChange?.({ target: { value: String(position) } });
const pressDuration = (label: string) => (tree: ReactNode) =>
  durationButton(tree, label)?.onClick?.();

test('empty forecast renders a recovery message without an unusable hour slider', () => {
  const html = render([]);
  assert.match(html, /No forecast hours available\. Refresh data to try again\./);
  assert.doesNotMatch(html, /type="range"|(?:NaN|Infinity)/);
  assert.match(html, /disabled=""[^>]*>72h<\/button>/);
});

test('the Data saver chart is cut to 24 hours, so the extra screening steps never unlock 72h', () => {
  // Data saver requests a few steps past 24 hours so hazard screening covers the whole next day.
  // App passes the chart forecastWindow(hours, 24); given every step, the chart would offer "72h".
  const steps = Array.from({ length: 27 }, (_, index) => hour(START + index * HOUR));
  const clipped = render(forecastWindow(steps, 24));
  assert.match(clipped, /disabled=""[^>]*>72h<\/button>/);
  assert.equal([...clipped.matchAll(/<th scope="row">/g)].length, 24);
  assert.doesNotMatch(render(steps), /disabled=""[^>]*>72h<\/button>/);
});

test('sparse forecasts keep the 24h view bounded while offering the longer range and export', () => {
  const html = render([hour(START), hour(START + 2 * HOUR), hour(START + 30 * HOUR)]);
  const rows = [...html.matchAll(/<th scope="row">(.*?)<\/th>/g)];
  assert.equal(rows.length, 2);
  assert.doesNotMatch(html, /disabled=""[^>]*>72h<\/button>/);
  assert.match(html, /CSV<\/button>/);
});

test('exact values retain gusts and identify unmatched model hours as unavailable', () => {
  const hours = [
    hour(START, { gust: 17.4 }),
    hour(START + HOUR, { temperature: null, gust: null }),
  ];
  const models: ModelForecast[] = [
    {
      id: 'gfs',
      name: 'GFS',
      fetchedAt: START,
      hours: [{ time: START + HOUR, temperature: 24.6, precipitation: 1, wind: 7 }],
    },
  ];
  const html = render(hours, models);
  const table = html.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? '';
  const rows = [...table.matchAll(/<tr>(.*?)<\/tr>/g)].map((match) => match[1]);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /<td>21\.0<\/td><td>Unavailable<\/td><td>10%<\/td><td>17\.4<\/td>/);
  assert.match(rows[1], /<td>Unavailable<\/td><td>24\.6<\/td><td>10%<\/td><td>Unavailable<\/td>/);
  assert.match(html, /<th scope="col">Gust \(km\/h\)<\/th>/);
  assert.match(html, /aria-valuetext="[^"]*Local forecast: 21\.0 °C\. GFS: unavailable"/);
});

test('hour slider and exact table distinguish repeated local daylight-saving hours', () => {
  const html = render([hour(START), hour(START + HOUR)], [], 'America/New_York');
  const rows = [...html.matchAll(/<th scope="row">(.*?)<\/th>/g)].map((match) => match[1]);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /01:00/);
  assert.match(rows[1], /01:00/);
  assert.notEqual(rows[0], rows[1]);
  assert.ok(html.includes(`aria-valuetext="${rows[0]}. Local forecast:`));
  const instructionsId = html.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(instructionsId && html.includes(`id="${instructionsId}"`));
  assert.match(html, /role="region" aria-label="Hourly forecast values"/);
});

test('multiple charts keep their gradients, labels, and keyboard instructions distinct', () => {
  const props = { hours: [hour(START)], models: [], timezone: 'UTC' };
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(ForecastExplorer, props),
      createElement(ForecastExplorer, props),
    ),
  );
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((html.match(/type="range"[^>]*disabled=""/g) ?? []).length, 2);
  for (const reference of html.matchAll(/(?:for|aria-describedby)="([^"]+)"|url\(#([^)]+)\)/g))
    assert.ok(ids.includes(reference[1] || reference[2]));
});

test('a comparison reading at an hour the local forecast omits stays plotted and tabled', () => {
  const models: ModelForecast[] = [
    {
      id: 'gfs',
      name: 'GFS',
      fetchedAt: START,
      hours: [0, 1, 2, 3].map((offset) => ({
        time: START + offset * HOUR,
        temperature: 20 + offset,
        precipitation: 0,
        wind: 5,
      })),
    },
  ];
  const html = render([hour(START), hour(START + HOUR), hour(START + 3 * HOUR)], models);
  const table = html.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? '';
  const rows = [...table.matchAll(/<tr>(.*?)<\/tr>/g)].map((match) => match[1]);
  assert.equal(rows.length, 4);
  assert.match(
    rows[2],
    /07:00 UTC<\/th><td>Unavailable<\/td><td>22\.0<\/td><td>Unavailable<\/td><td>Unavailable<\/td>/,
  );
  // GFS reports every hour, so only the local line has a gap.
  const lines = [...html.matchAll(/<path d="([^"]*)" fill="none"/g)].map((match) => match[1]);
  assert.deepEqual(
    lines.map((line) => (line.match(/M/g) ?? []).length),
    [2, 1],
  );
  assert.match(html, /Temperature forecast, 4 available hours\./);
});

test('time-axis labels stay apart when the provider omits hours', () => {
  const labels = (offsets: number[]) =>
    [
      ...render(offsets.map((offset) => hour(START + offset * HOUR))).matchAll(
        /<span style="left:([\d.]+)%;transform:[^"]*">(\d\d:\d\d)</g,
      ),
    ].map((match) => ({ left: Number(match[1]), time: match[2] }));
  for (const offsets of [
    [0, 1, 2, 3, 4, 5, 22, 23, 30],
    [0, 1, 2, 3, 23],
    [0, 1, 2, 3, 4, 5],
  ]) {
    const lefts = labels(offsets).map((label) => label.left);
    assert.ok(lefts.length >= 2, String(offsets));
    // A quarter of the plotted width keeps a centred label clear of an edge-aligned one.
    for (let index = 1; index < lefts.length; index++)
      assert.ok(lefts[index] - lefts[index - 1] >= 24, `${offsets}: ${lefts}`);
  }
  // An hourly forecast keeps its four evenly spread ticks.
  assert.deepEqual(
    labels(Array.from({ length: 30 }, (_, offset) => offset)).map((label) => label.time),
    ['05:00', '12:00', '20:00', '04:00'],
  );
});

test('duration group holds only the duration toggles; CSV export sits outside it', () => {
  const html = render(Array.from({ length: 72 }, (_, offset) => hour(START + offset * HOUR)));
  const group = html.match(
    /<div[^>]*role="group" aria-label="Forecast duration"[^>]*>(.*?)<\/div>/,
  )?.[1];
  assert.ok(group);
  assert.deepEqual(
    [...group.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1]),
    ['24h', '72h'],
  );
  assert.match(html, /<button[^>]*title="Export the displayed metric[^"]*"[^>]*>.*?CSV<\/button>/);
});

test('aria-labels sit only on elements whose role allows a name', () => {
  const models: ModelForecast[] = [{ id: 'gfs', name: 'GFS', fetchedAt: START, hours: [] }];
  // ARIA 1.2 prohibits naming these roles; a div, span or p without a role is one of them.
  const unnameable =
    /^(?:caption|code|deletion|emphasis|generic|insertion|none|paragraph|presentation|strong|subscript|superscript)$/;
  for (const html of [render([hour(START), hour(START + HOUR)], models), render([])]) {
    const labelled = html.match(/<(?:div|span|p)\b[^>]*\baria-label="[^"]*"[^>]*>/g) ?? [];
    for (const tag of labelled) {
      const role = tag.match(/\brole="([^"]*)"/)?.[1];
      assert.ok(role && !unnameable.test(role), tag);
    }
    assert.match(html, /<div class="fe-legend" role="group" aria-label="Values at selected hour">/);
  }
});

test('precipitation and its chance are not labelled rain, since they include snow', () => {
  // Open-Meteo's precipitation and precipitation probability cover rain, showers and snow.
  const snow = hour(START, { code: 75, temperature: -8, precipitation: 6, probability: 95 });
  const html = render([snow]).replace(/ class="[^"]*"/g, '');
  assert.doesNotMatch(html, /\brain/i);
  // The toolbar button shows a short form; its accessible name is the full word.
  assert.match(html, /<button[^>]*aria-label="Precipitation"[^>]*>.*?<span>Precip\.<\/span>/);
  assert.match(html, /95% precipitation chance/);
  assert.match(html, /<th scope="col">Precipitation chance<\/th>/);
  assert.match(render([{ ...snow, probability: null }]), /Precipitation chance unavailable/);
});

test('the inspected hour keeps its time when the oldest hour leaves the window', () => {
  // App passes the hours from 30 minutes ago onwards, so at half past each hour the oldest one
  // leaves and every later hour moves one place left. The explorer is not remounted.
  const hours = Array.from({ length: 30 }, (_, offset) =>
    hour(START + offset * HOUR, { temperature: offset + 0.5 }),
  );
  const chosen = hourSlider(explore([{ hours, act: selectHour(6) }, { hours }]));
  assert.equal(chosen?.['aria-valuetext'], '01 Nov, 11:00 UTC. Local forecast: 6.5 °C');
  assert.equal(chosen?.value, 6);
  const later = hourSlider(explore([{ hours, act: selectHour(6) }, { hours: hours.slice(1) }]));
  assert.equal(later?.['aria-valuetext'], chosen?.['aria-valuetext']);
  assert.equal(later?.value, 5);
  // Once the inspected hour itself has left, the first remaining hour is shown.
  const gone = hourSlider(explore([{ hours, act: selectHour(0) }, { hours: hours.slice(1) }]));
  assert.match(gone?.['aria-valuetext'] ?? '', /^01 Nov, 06:00 UTC\./);
});

test('a shorter range shows its last hour in place of a later inspected hour, and keeps it', () => {
  const hours = Array.from({ length: 72 }, (_, offset) =>
    hour(START + offset * HOUR, { temperature: offset + 0.5 }),
  );
  const last24 = '02 Nov, 04:00 UTC. Local forecast: 23.5 °C';
  const steps = [
    { hours, act: pressDuration('72h') },
    { hours, act: selectHour(50) },
    { hours, act: pressDuration('24h') },
  ];
  assert.equal(hourSlider(explore([...steps, { hours }]))?.['aria-valuetext'], last24);
  const back = hourSlider(explore([...steps, { hours, act: pressDuration('72h') }, { hours }]));
  assert.equal(back?.['aria-valuetext'], last24);
  assert.equal(back?.value, 23);
});

test('CSV download starts with a UTF-8 byte-order mark so spreadsheets keep the degree sign', async (t) => {
  const models: ModelForecast[] = [
    {
      id: 'ecmwf_ifs025',
      name: 'ECMWF IFS 0.25°',
      fetchedAt: START,
      hours: [{ time: START, temperature: 9.3, precipitation: 0, wind: 4 }],
    },
  ];
  const csv = findElement(
    elementTree({ hours: [hour(START)], models, timezone: 'UTC' }),
    (element) => element.props.title?.startsWith('Export the displayed metric') ?? false,
  );
  assert.ok(csv?.props.onClick);
  let file: Blob | undefined;
  const link = { href: '', download: '', clicks: 0, click: () => void link.clicks++ };
  t.mock.method(URL, 'createObjectURL', (object: Blob) => {
    file = object;
    return 'blob:stormsignal-test';
  });
  // The handler revokes the object URL a second later; that timer is not part of this check.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = globalThis as { document?: unknown };
  page.document = { createElement: () => link };
  try {
    csv.props.onClick();
  } finally {
    delete page.document;
    t.mock.timers.reset();
  }
  assert.ok(file);
  assert.equal(link.href, 'blob:stormsignal-test');
  assert.equal(link.download, 'stormsignal-temperature-24h.csv');
  assert.equal(link.clicks, 1);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Without the mark, Excel reads the file in a legacy code page and shows "0.25Â°".
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(
    new TextDecoder().decode(bytes),
    '"time_utc","Local forecast: temperature (C)","ECMWF IFS 0.25°: temperature (C)"\r\n"2026-11-01T05:00:00.000Z",21,9.3\r\n',
  );
});
