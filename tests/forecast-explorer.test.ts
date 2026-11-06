import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement, Fragment, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Hour, ModelForecast } from '../src/types';

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

test('empty forecast renders a recovery message without an unusable hour slider', () => {
  const html = render([]);
  assert.match(html, /No forecast hours available\. Refresh data to try again\./);
  assert.doesNotMatch(html, /type="range"|(?:NaN|Infinity)/);
  assert.match(html, /disabled=""[^>]*>72h<\/button>/);
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
