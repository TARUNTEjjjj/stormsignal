import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Place } from '../src/types';

// Keyboard focus and accessible names in the lazily loaded panels and the resource library.
const require = createRequire(import.meta.url);
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const temporary = await mkdtemp(join(tmpdir(), 'stormsignal-focus-'));
let DisasterWatch: ComponentType<{ place: Place }>;
try {
  const outfile = join(temporary, 'disaster-watch.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/components/DisasterWatch.tsx', import.meta.url))],
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
          builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, ({ path }) => ({
            path: require.resolve(path),
            external: true,
          }));
        },
      },
    ],
  });
  DisasterWatch = (await import(pathToFileURL(outfile).href)).default;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const place: Place = {
  id: 'chennai',
  name: 'Chennai',
  country: 'India',
  countryCode: 'IN',
  latitude: 13.08,
  longitude: 80.27,
};

test('"Refresh reports" stays focusable while reports load, marked busy instead', () => {
  // The panel starts loading at once. A disabled button would drop keyboard focus to the page.
  const html = renderToStaticMarkup(createElement(DisasterWatch, { place }));
  const button = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Loading reports<\/button>/.exec(html)?.[0];
  assert.ok(button, 'the refresh button shows that reports are loading');
  assert.doesNotMatch(button, /\sdisabled=""/);
  assert.match(button, /aria-disabled="true"/);
});

test('the satellite refresh button is busy, not disabled, while frames or tiles load', () => {
  // WeatherMap needs a browser for Leaflet, so its markup is checked in the source.
  const map = source('src/components/WeatherMap.tsx');
  const label = map.indexOf('aria-label="Refresh satellite availability"');
  assert.ok(label > 0, 'the map has a satellite refresh button');
  // The button's attributes: from its opening tag to its icon.
  const button = map.slice(map.lastIndexOf('<button', label), map.indexOf('<RefreshCw', label));
  assert.doesNotMatch(/disabled=\{([^}]*)\}/.exec(button)?.[1] ?? '', /loading/);
  assert.match(button, /aria-disabled=\{loading \|\| undefined\}/);
  assert.match(button, /if \(!loading\)/, 'a press while busy starts nothing');
});

test('every warning outline that opens a tooltip on focus has a name', () => {
  // Leaflet gives each outline focus listeners for its tooltip, and Chrome then makes the outline
  // a Tab stop. Unnamed, a screen reader announces only "graphic".
  const map = source('src/components/WeatherMap.tsx');
  const binding = /shape\.bindTooltip\(text\)[\s\S]*?shape\.eachLayer\(([\s\S]*?)\);\n/.exec(
    map,
  )?.[1];
  assert.ok(binding, 'each outline layer is visited after its tooltip is bound');
  assert.match(
    binding,
    /setAttribute\('aria-label', `Official warning area: \$\{text\.textContent\}`\)/,
  );
});

test('removing the last saved briefing moves focus to the result, not to the page', () => {
  const briefing = source('src/components/OfflineBriefing.tsx');
  assert.match(
    briefing,
    /<p role="status" className="briefing-message" ref=\{messageBox\} tabIndex=\{-1\}>/,
  );
  assert.match(briefing, /!result\.briefings\.length\) messageBox\.current\?\.focus\(\)/);
});

function luminance(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

test('the resource library search placeholder meets 4.5:1 on its field', () => {
  const css = source('resources/explorer.css');
  const placeholder = /\.toolbar input::placeholder\{color:(#[0-9a-f]{6})\}/i.exec(css)?.[1];
  const field = /\.toolbar input,\.toolbar select\{[^}]*background:var\(--card\)/.test(css);
  const card = /--card:(#[0-9a-f]{6})/i.exec(css)?.[1];
  assert.ok(placeholder && field && card, 'the search field draws its placeholder on --card');
  const [light, dark] = [luminance(placeholder), luminance(card)].sort((a, b) => b - a);
  const ratio = (light + 0.05) / (dark + 0.05);
  assert.ok(ratio >= 4.5, `${placeholder} on ${card} is ${ratio.toFixed(2)}:1`);
});
