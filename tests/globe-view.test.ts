import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Metafile } from 'esbuild';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  WARNING_LINE,
  daylight,
  solarElevation,
  type DailyImagery,
  type ImageryMask,
} from '../src/globe';
import type { Place, WeatherAlert } from '../src/types';

// The globe in the dashboard and on its own. App is compiled and server-rendered as in
// dashboard.test.ts: no effects run, and the optional panels are stand-ins. The globe's stand-in
// notes when its module is requested, which is when its code would be downloaded. GlobeView is
// compiled on its own, three.js left out: it is only ever imported on demand, and server
// rendering, like the browser's first paint, shows the card before WebGL starts. GlobeCard renders
// the card in any state the globe can be in.
const require = createRequire(import.meta.url);
const source = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
const requested = { globe: 0 };
Object.assign(globalThis, { __globeTestRequested: requested });
const temporary = await mkdtemp(join(tmpdir(), 'stormsignal-globe-'));
const react = {
  name: 'external-react',
  setup(builder: import('esbuild').PluginBuild) {
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, ({ path }) => ({
      path: require.resolve(path),
      external: true,
    }));
  },
};
const common = {
  bundle: true,
  platform: 'node' as const,
  format: 'esm' as const,
  mainFields: ['module', 'main'],
  loader: { '.css': 'empty' as const },
  define: { 'import.meta.env.PROD': 'false' },
  logLevel: 'error' as const,
};
let App: () => ReactNode;
let view: typeof import('../src/components/GlobeView');
try {
  await build({
    ...common,
    entryPoints: [source('App.tsx')],
    outfile: join(temporary, 'app.mjs'),
    plugins: [
      react,
      {
        name: 'globe-test',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/components\/(?:WeatherMap|DisasterWatch)$/ }, () => ({
            path: 'optional-tool',
            namespace: 'globe-test',
          }));
          builder.onResolve({ filter: /^\.\/components\/GlobeView$/ }, () => ({
            path: 'globe',
            namespace: 'globe-test',
          }));
          builder.onLoad({ filter: /^optional-tool$/, namespace: 'globe-test' }, () => ({
            contents: 'export default function OptionalTool() { return null; }',
            loader: 'js',
          }));
          builder.onLoad({ filter: /^globe$/, namespace: 'globe-test' }, () => ({
            contents: `globalThis.__globeTestRequested.globe++;
              export default function Globe() { return 'GLOBE READY'; }`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  await build({
    ...common,
    entryPoints: [source('components/GlobeView.tsx')],
    outfile: join(temporary, 'globe.mjs'),
    external: ['three', 'three/*'],
    plugins: [react],
  });
  App = (await import(pathToFileURL(join(temporary, 'app.mjs')).href)).default;
  view = await import(pathToFileURL(join(temporary, 'globe.mjs')).href);
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
  browser.navigator.onLine = true;
  requested.globe = 0;
});

/** The dashboard in a connection mode, and whether it asked for the globe's code. */
async function dashboard(mode: string) {
  local.setItem('stormsignal:connection-mode', mode);
  const html = renderToStaticMarkup(createElement(App));
  // React.lazy starts the import while rendering; the module itself evaluates a moment later.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { html, requested: requested.globe > 0 };
}
const SKELETON = 'Loading the 3D globe…';

test('Data saver and Offline only render no globe and never request its code', async () => {
  for (const mode of ['lite', 'offline']) {
    const { html, requested } = await dashboard(mode);
    assert.doesNotMatch(html, new RegExp(SKELETON), mode);
    assert.doesNotMatch(html, /globe-slot/, mode);
    assert.equal(requested, false, `${mode} requested the globe`);
  }
  // Full workspace without a connection is offline: no globe either.
  browser.navigator.onLine = false;
  const { html, requested: fetched } = await dashboard('full');
  assert.doesNotMatch(html, /globe-slot/);
  assert.equal(fetched, false);
});

const chennai: Place = {
  id: 'chennai',
  name: 'Chennai',
  country: 'India',
  countryCode: 'IN',
  latitude: 13.0827,
  longitude: 80.2707,
};
const warning = (overrides: Partial<WeatherAlert> = {}): WeatherAlert => ({
  id: 'urn:test:globe',
  title: 'Flood Warning',
  event: 'Flood Warning',
  severity: 'Severe',
  area: 'Coast',
  sent: Date.now() - 3_600_000,
  effective: Date.now() - 3_600_000,
  expires: Date.now() + 3_600_000,
  description: '',
  instruction: '',
  source: 'Test authority',
  url: 'https://example.invalid/',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [80, 13],
        [81, 13],
        [81, 14],
        [80, 13],
      ],
    ],
  },
  ...overrides,
});
/** GlobeView as the browser first paints it: before WebGL starts. */
const globe = (alerts: WeatherAlert[] = []) =>
  renderToStaticMarkup(
    createElement(view.default, {
      place: chennai,
      saved: [],
      alerts,
      clockOffset: undefined,
      onSelect: () => {},
    }),
  );
type CardProps = Parameters<typeof view.GlobeCard>[0];
/** Imagery everywhere west of 18° W, as on 17 Nov 2026; Chennai is in the gap. */
const westOnly: ImageryMask = (() => {
  const data = new Uint8Array(360 * 180);
  for (let row = 0; row < 180; row++) data.fill(1, row * 360, row * 360 + 162);
  return { width: 360, height: 180, data };
})();
const mosaic = {
  state: 'ready',
  date: '2026-11-17',
  coverage: 0.46,
  mask: westOnly,
  skipped: null,
  refreshError: null,
} satisfies DailyImagery;
/** The card in one state; a ready globe with both images unless the test says otherwise. */
const card = (overrides: Partial<CardProps> = {}) =>
  renderToStaticMarkup(
    createElement(view.GlobeCard, {
      id: 'g',
      place: chennai,
      status: 'ready',
      base: { state: 'ready' },
      daily: mosaic,
      showDaily: true,
      outlined: 1,
      alertCount: 1,
      reducedMotion: false,
      paused: false,
      closer: false,
      wheelHint: false,
      assist: 'full',
      announcement: '',
      now: Date.parse('2026-11-19T07:30:00Z'),
      ...overrides,
    }),
  );
const entities: Record<string, string> = { amp: '&', quot: '"', '#x27': "'", lt: '<', gt: '>' };
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|quot|#x27|lt|gt);/g, (_, name: string) => entities[name])
    .replace(/\s+/g, ' ');
const opening = (html: string, className: string) =>
  new RegExp(`<[a-z]+ [^>]*class="${className}(?: [^"]*)?"[^>]*>`).exec(html)?.[0] ?? '';

test('Full workspace reserves the globe card itself, after the settings and before the conditions', async () => {
  const { html, requested } = await dashboard('full');
  assert.equal(requested, true, 'the globe code is requested');
  const skeleton = html.indexOf('class="globe-slot"');
  assert.ok(skeleton > html.indexOf('aria-label="Workspace settings"'), 'after the settings');
  assert.ok(skeleton < html.indexOf('class="overview-grid"'), 'before the conditions');
  assert.match(html, /<p class="globe-loading" role="status">.*Loading the 3D globe…<\/p>/);
  // The skeleton and the loaded card are the same box: one slot, one card, one frame, sized by
  // GlobeView.css alone (next test).
  const shape = (markup: string) =>
    /^<div class="globe-slot"><section class="globe-view(?: [^"]*)?"[^>]*><div class="globe-frame">/.test(
      markup,
    );
  const placed = html.slice(skeleton - '<div '.length);
  assert.ok(shape(placed), placed.slice(0, 160));
  assert.ok(shape(globe()), globe().slice(0, 160));
  assert.ok(shape(card({ status: 'unsupported' })));
  // Inside, the skeleton is the starting card's frame, stage and notes, so its orb stays put. It
  // once sat in the middle of the whole card, and the starting card's in its stage above the
  // notes: the orb moved up 69px as the code arrived at 1440px, 121px on a phone, and across by
  // 145px on a medium card, whose stage is beside the readouts. (Only this first render of Full
  // workspace shows the skeleton: the lazy code has arrived for the tests after it.)
  const skeletonCard = /<div class="globe-slot">[\s\S]*?<\/section><\/div>/.exec(placed)?.[0] ?? '';
  const starting = card({
    status: 'starting',
    base: { state: 'loading' },
    daily: { state: 'loading' },
    outlined: 0,
    alertCount: 0,
  });
  for (const markup of [skeletonCard, starting])
    assert.match(
      element(element(markup, '<div class="globe-stage">'), '<div class="globe-viewport">'),
      /<p class="globe-loading" role="status"><span class="globe-orb" aria-hidden="true"><\/span>/,
    );
  // The same notes, so the stage above them has the same height. The card's links are plain text
  // in the skeleton: the card replaces it, and focus on a link there would drop to the page.
  const notes = (markup: string, end: string) =>
    markup.slice(markup.indexOf('<div class="globe-notes">'), markup.lastIndexOf(end));
  const linkless = notes(starting, '</div><p class="globe-visually-hidden"')
    .replace(/<a [^>]*>|<\/a>/g, '')
    .replace(/ ↗/g, '');
  assert.ok(linkless.length > 200, linkless);
  assert.equal(notes(skeletonCard, '</div></section>'), linkless);
  assert.doesNotMatch(skeletonCard, /<a\s/);
});

/** The element that `opening` starts in `markup`, up to its own closing tag. */
function element(markup: string, opening: string) {
  const start = markup.indexOf(opening);
  const tag = /^<([a-z]+)/.exec(opening)?.[1];
  if (start < 0 || !tag) return '';
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  tags.lastIndex = start;
  let depth = 0;
  for (let found = tags.exec(markup); found; found = tags.exec(markup)) {
    depth += found[1] ? -1 : 1;
    if (!depth) return markup.slice(start, found.index + found[0].length);
  }
  return '';
}

const css = readFileSync(source('components/GlobeView.css'), 'utf8');
/** The stylesheet's rules, comments removed, those inside @container and @media included. */
const cssRules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selector, body]) => ({ selector: selector.trim(), body }),
);
test("the card's size depends on its width and the window, never on what it shows", () => {
  // Every rule that sizes the card names the card alone, at the top level or in a container
  // query on the slot: no state, no content. The skeleton has those classes too. The one
  // exception is a browser without WebGL 2 (next test): the globe cannot come back there.
  const sizing = cssRules.filter(({ body }) => /(?:^|;)\s*(?:min-|max-)?height:/.test(body));
  const card = sizing.filter(
    ({ selector }) => /\.globe-view\b/.test(selector) && !/\s/.test(selector),
  );
  assert.ok(card.length >= 4, 'wide, medium and narrow sizes, and the compact notice');
  for (const { selector } of card)
    assert.ok(['.globe-view', '.globe-view.is-unsupported'].includes(selector), selector);
  for (const { selector } of sizing)
    assert.doesNotMatch(
      selector.replace('.globe-view.is-unsupported', ''),
      /\.globe-view\.(?:is-|has-)/,
      `${selector} sizes the card by state`,
    );
  assert.match(css, /\.globe-slot \{\s*container: globe \/ inline-size;/);
  // The frame takes what the notes leave, so the notes never push the page down.
  assert.match(css, /\.globe-frame \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/);
  assert.match(css, /\.globe-notes \{\s*flex: none;/);
  for (const query of ['(max-width: 999px)', '(max-width: 599px)'])
    assert.ok(css.includes(`@container globe ${query}`), query);
  // That this stylesheet ships with the dashboard, so the skeleton is sized before the globe's
  // code arrives, is checked on the build itself (scripts/verify-build.mjs).
});

test('three.js reaches the dashboard only on demand, after the globe has found WebGL 2', async () => {
  const output = await mkdtemp(join(tmpdir(), 'stormsignal-globe-split-'));
  let metafile: Metafile;
  try {
    ({ metafile } = await build({
      ...common,
      platform: 'browser',
      entryPoints: [source('App.tsx')],
      outdir: output,
      splitting: true,
      metafile: true,
      write: false,
      plugins: [react],
    }));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
  const outputs = Object.entries(metafile.outputs).filter(([path]) => path.endsWith('.js'));
  // React stays external here; every other import is one of the build's own chunks.
  const reach = (start: string, kinds: string[]) => {
    const found = new Set<string>();
    const visit = (path: string) => {
      if (found.has(path) || !metafile.outputs[path]) return;
      found.add(path);
      for (const { path: next, kind } of metafile.outputs[path].imports)
        if (kinds.includes(kind)) visit(next);
    };
    visit(start);
    return found;
  };
  const holds = (path: string, input: RegExp) =>
    Object.keys(metafile.outputs[path]?.inputs ?? {}).some((name) => input.test(name));
  const three = /node_modules\/three\//;
  const [entry] = outputs.find(([, out]) => out.entryPoint?.endsWith('src/App.tsx')) ?? [];
  assert.ok(entry, 'the dashboard chunk');
  for (const path of reach(entry, ['import-statement']))
    assert.equal(holds(path, three), false, `${path} carries three.js with the dashboard`);
  const [globeChunk] =
    outputs.find(([path]) => holds(path, /src\/components\/GlobeView\.tsx$/)) ?? [];
  assert.ok(globeChunk, "the globe's chunk");
  for (const path of reach(globeChunk, ['import-statement']))
    assert.equal(holds(path, three), false, `${path} carries three.js with the globe's own code`);
  const later = [...reach(globeChunk, ['import-statement', 'dynamic-import'])];
  assert.ok(
    later.some((path) => holds(path, three)),
    'three.js loads with the globe, on demand',
  );
  // The map shares the globe's plain helpers (globe.ts), never its 3D code.
  const [mapChunk] =
    outputs.find(([path]) => holds(path, /src\/components\/WeatherMap\.tsx$/)) ?? [];
  assert.ok(mapChunk, "the map's chunk");
  const map = [...reach(mapChunk, ['import-statement', 'dynamic-import'])];
  assert.ok(
    map.some((path) => holds(path, /src\/globe\.ts$/)),
    'the map uses globe.ts',
  );
  assert.ok(!map.some((path) => holds(path, three)), 'the map never loads three.js');
});

test('the globe names itself, explains its keys and controls, and has a polite live region', () => {
  const html = card();
  const heading = /<section[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
  assert.ok(heading && html.includes(`<h2 id="${heading}">`), 'the section is named by its h2');
  assert.match(html, /aria-live="polite"/);
  // The canvas and the floating label repeat what the text says, so they are hidden from readers.
  assert.match(html, /class="globe-canvas" aria-hidden="true"/);
  assert.match(html, /class="globe-pin" aria-hidden="true"/);
  const help = /<p id="([^"]+)" class="globe-visually-hidden">([^<]*)<\/p>/.exec(html);
  assert.ok(help, 'the key help is in the page');
  for (const key of [
    /Arrow keys rotate/,
    /Plus and minus zoom/,
    /Enter\s+selects the point/,
    /Home/,
    /Escape\s+hides the key help/,
  ])
    assert.match(help[2], key);
  // The running globe is one focusable, named surface that refers to that help.
  const surface = opening(html, 'globe-surface');
  assert.match(surface, /tabindex="0"/);
  assert.match(surface, /role="application"/);
  assert.match(surface, /aria-label="3D globe\. Selected place: Chennai\."/);
  assert.ok(surface.includes(`aria-describedby="${help[1]}"`), surface);
  // Every control is a named button, and turning the globe needs no drag.
  const tools = opening(html, 'globe-tools');
  assert.doesNotMatch(tools, /hidden/);
  // The tools are one named group, and the rotate buttons a named group inside it.
  assert.match(tools, /role="group"/);
  assert.match(tools, /aria-label="Globe controls"/);
  assert.match(opening(html, 'globe-pad'), /role="group" aria-label="Rotate globe"/);
  for (const direction of ['west', 'north', 'south', 'east'])
    assert.match(
      html,
      new RegExp(
        `<button type="button" class="is-${direction}" aria-label="Rotate globe ${direction}">`,
      ),
    );
  for (const name of ['Zoom in globe', 'Zoom out globe', 'Return globe to selected place'])
    assert.ok(html.includes(`<button type="button" aria-label="${name}">`), name);
  assert.match(
    html,
    /<button type="button" aria-label="Daily satellite mosaic" aria-pressed="true">/,
  );
  // A title repeating the name would be read again, as the description: the name is said once.
  assert.doesNotMatch(html, /\stitle="/);
  // Before WebGL starts nothing is operable or in the tab order, and the card says it is
  // starting. The surface can still hold focus that a restart parks on it (next tests).
  const starting = card({ status: 'starting' });
  const parked = opening(starting, 'globe-surface');
  assert.match(parked, /tabindex="-1"/);
  assert.match(parked, /role="img"/);
  assert.match(parked, /aria-label="3D globe, starting\."/);
  assert.doesNotMatch(parked, /aria-describedby|role="application"/);
  assert.match(opening(starting, 'globe-tools'), /hidden=""/);
  assert.match(text(starting), /Starting the 3D globe…/);
  assert.match(opening(globe(), 'globe-tools'), /hidden=""/, 'GlobeView before its first effect');
});

test('Escape dismisses what focus shows over the globe, and a key press hides the help', () => {
  // WCAG 1.4.13: the help and crosshair that focus shows can be dismissed without moving focus.
  assert.match(opening(card(), 'globe-surface'), /data-assist="full"/);
  assert.match(opening(card({ assist: 'crosshair' }), 'globe-surface'), /data-assist="crosshair"/);
  assert.match(opening(card({ assist: 'none' }), 'globe-surface'), /data-assist="none"/);
  assert.match(text(card()), /Esc hide help/);
  const hidden = (selector: string) =>
    cssRules.some(
      ({ selector: names, body }) =>
        names.split(',').some((name) => name.trim() === selector) &&
        /visibility: hidden/.test(body),
    );
  // Shown only on keyboard focus; anything but 'full' hides the help, 'none' the crosshair too.
  assert.match(css, /\.globe-surface:focus-visible ~ \.globe-help \{\s*opacity: 1;/);
  assert.ok(hidden(".globe-surface:not([data-assist='full']) ~ .globe-help"));
  assert.ok(hidden(".globe-surface[data-assist='none'] ~ .globe-crosshair"));
});

test('a stopped globe hides its floating label, offers Restart, and says why it stopped', () => {
  // The label, crosshair and help belong to a drawing globe only: never over a fallback.
  assert.ok(
    cssRules.some(
      ({ selector, body }) =>
        selector === '.globe-view:not(.is-ready) :is(.globe-pin, .globe-crosshair, .globe-help)' &&
        /visibility: hidden/.test(body),
    ),
  );
  for (const status of ['lost', 'failed'] as const) {
    const html = card({ status });
    assert.match(html, new RegExp(`class="globe-view is-${status}"`));
    assert.match(html, /class="globe-pin" aria-hidden="true" data-hidden="true"/);
    assert.match(html, /<button type="button" class="globe-text-button">Restart globe<\/button>/);
    // Focus waits on the surface (tabindex -1) while Restart brings the globe back.
    assert.match(opening(html, 'globe-surface'), /tabindex="-1"/);
    assert.match(opening(html, 'globe-surface'), /aria-label="3D globe, stopped\."/);
    assert.match(opening(html, 'globe-tools'), /hidden=""/);
  }
  assert.match(text(card({ status: 'lost' })), /The browser reset its graphics/);
  assert.match(text(card({ status: 'failed' })), /could not draw a frame, so it stopped/);
  assert.doesNotMatch(text(card({ status: 'failed' })), /reset its graphics/);
  assert.match(
    css,
    /\.globe-view:is\(\.is-lost, \.is-failed\) \.globe-canvas \{\s*visibility: hidden;/,
  );
});

test('without WebGL 2 the card is a short notice with the place, not an empty stage', () => {
  const html = card({ status: 'unsupported' });
  assert.match(html, /class="globe-compact"/);
  assert.doesNotMatch(html, /globe-stage|globe-canvas|globe-surface|globe-tools/);
  const heading = /<section[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
  assert.ok(html.includes(`<h2 id="${heading}">3D view unavailable</h2>`), 'still named');
  assert.match(html, /<p role="status">This browser could not start WebGL 2/);
  // The selected place and its daylight, which need no WebGL, stay.
  assert.match(text(html), /SELECTED PLACE Chennai 13\.08°N, 80\.27°E/);
  assert.match(text(html), /(Daylight|Twilight|Night) · sun /);
  // Its height is its content's: the reserved stage is released for this state alone.
  const compact = cssRules.find(({ selector }) => selector === '.globe-view.is-unsupported');
  assert.match(compact?.body ?? '', /min-height: 0;/);
  assert.ok(
    cssRules.some(
      ({ selector, body }) =>
        selector === '.globe-view.is-unsupported .globe-frame' && /display: block;/.test(body),
    ),
  );
});

/** The text of a fragment as a name is computed from it: inline tags add no space. */
const inline = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|quot|#x27|lt|gt);/g, (_, name: string) => entities[name])
    .replace(/\s+/g, ' ')
    .trim();
/** The warnings link: its accessible name (aria-label) and what it shows. */
const chip = (overrides: Partial<CardProps> = {}) => {
  const found = /<a class="globe-alerts" href="#alerts" aria-label="([^"]*)">([\s\S]*?)<\/a>/.exec(
    card(overrides),
  );
  return found && { name: inline(found[1]), html: found[2] };
};
/** The narrow card's rules, inside its container query. */
const narrowRules = css.slice(css.indexOf('@container globe (max-width: 599px)'));

test('active warnings are one step away from the globe, and only when there are some', () => {
  assert.equal(chip({ alertCount: 0 }), null);
  for (const [count, words] of [
    [1, '1 warning, active and official'],
    [3, '3 warnings, active and official'],
  ] as const) {
    const link = chip({ alertCount: count });
    assert.equal(inline(link?.html ?? ''), words, 'what a wider card shows');
    assert.equal(link?.name, words, 'its name is the same words');
  }
  // It sits with the readouts, before them, and stays when the 3D view cannot draw.
  const html = card({ alertCount: 2 });
  assert.ok(html.indexOf('globe-alerts') < html.indexOf('globe-facts'));
  assert.match(card({ status: 'lost', alertCount: 2 }), /class="globe-alerts"/);
  assert.match(card({ status: 'unsupported', alertCount: 2 }), /class="globe-alerts"/);
});

test('on a phone the warnings link shows the start of its name, so the words seen reach it', () => {
  // WCAG 2.5.3, label in name: a narrow card hides the link's last words from sight, and what is
  // left, "2 warnings", begins its name. A speech-input user who says what they see reaches the
  // official warnings; a screen reader still hears every word. The name is set whole: one taken
  // from the text would gain a stray space where the hidden words begin ("2 warnings , active").
  for (const status of ['ready', 'unsupported'] as const) {
    const link = chip({ status, alertCount: 2 });
    assert.ok(link, status);
    const seen = inline(link.html.replace(/<span class="globe-more-label">[^<]*<\/span>/g, ''));
    assert.equal(link.name, '2 warnings, active and official', status);
    assert.equal(seen, '2 warnings', status);
    assert.ok(link.name.startsWith(`${seen},`), `${seen} begins ${link.name}`);
  }
  // Hidden from sight on a narrow card only, by clipping, never removed: and shown on wider ones.
  assert.match(narrowRules, /\.globe-alerts \.globe-more-label \{[^}]*clip: rect\(0 0 0 0\)/);
  const wider = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('@container globe (max-width: 599px)')[0];
  assert.doesNotMatch(wider, /globe-more-label/);
});

test('on a phone the words a narrow card leaves out are hidden from sight, not from readers', () => {
  // The key and the place card show the rest. Removed with display: none, the sentences on night
  // and on hatched areas, and the imagery's full credit, were lost to screen readers too.
  const notes = /<div class="globe-notes">[\s\S]*$/.exec(card())?.[0] ?? '';
  assert.match(notes, /<span class="globe-more"> Night is drawn from the sun’s position now\./);
  assert.match(notes, /Hatched areas had no imagery that day/);
  assert.match(
    narrowRules,
    /\.globe-more,\s*\.globe-alerts \.globe-more-label \{[^}]*position: absolute;[^}]*clip: rect\(0 0 0 0\);/,
  );
  assert.ok(
    !cssRules.some(
      ({ selector, body }) => /\.globe-more\b/.test(selector) && /display: none/.test(body),
    ),
    'no rule removes them',
  );
});

test("each fact's label is one run of words beside its icon, so no gap splits two words", () => {
  // The label is an inline flex row whose gap parts the icon from the words. Words in separate
  // flex items took that gap as their space: "DAILY  MOSAIC", 6px where a word space is 3.7px.
  const html = card();
  const labels = [...html.matchAll(/<dt>([\s\S]*?)<\/dt>/g)].map(([, inner]) => inner);
  assert.deepEqual(labels.map(inline), ['Daily mosaic', 'Imaged that day', 'Sun overhead']);
  for (const inner of labels) {
    // The icon aside, one element holds the words, and no word stands outside it.
    const nodes = topLevel(inner).filter((node) => node !== '<svg>' && node.trim() !== '');
    assert.deepEqual(nodes, ['<span>'], inner);
  }
  assert.match(css, /\.globe-facts dt \{[^}]*display: inline-flex;[^}]*gap: 6px;/);
});
/** The top-level nodes of an HTML fragment: each element as `<tag>`, and text as it is. */
function topLevel(fragment: string) {
  const nodes: string[] = [];
  let depth = 0;
  for (const [token, closing, tag, selfClosing] of fragment.matchAll(
    /<(\/)?([a-z][\w-]*)[^>]*?(\/)?>|[^<]+/gi,
  )) {
    if (!tag) {
      if (!depth) nodes.push(token);
    } else if (closing) depth--;
    else {
      if (!depth) nodes.push(`<${tag}>`);
      if (!selfClosing) depth++;
    }
  }
  return nodes;
}

test('Tab reaches the active warnings before the globe and its controls', () => {
  // The order of focus is the order of the markup: the title and the warnings link come first,
  // then the globe, its rotate pad and buttons. The readouts are positioned over the scene, so
  // the order moves nothing on screen.
  const html = card({ alertCount: 2 });
  const order = ['globe-alerts', 'globe-surface', 'globe-tools', 'globe-place'].map((name) =>
    html.indexOf(`class="${name}`),
  );
  assert.ok(
    order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])),
    order.join(),
  );
  const hud = cssRules.find(({ selector }) => selector === '.globe-hud');
  assert.match(hud?.body ?? '', /position: absolute;/);
  assert.match(hud?.body ?? '', /z-index: 3;/);
  for (const query of ['(max-width: 999px)', '(max-width: 599px)']) {
    const block = css.slice(css.indexOf(`@container globe ${query}`));
    assert.match(block, /\.globe-hud-top \{[^}]*grid-row: 1;/, `${query}: placed by the grid`);
  }
});

test('motion: no motion switch and nothing that moves by itself under reduced motion', () => {
  // A switch for the globe's own motion, named the same whether it is on or off: a globe that has
  // come to rest is never offered a "Pause" that would change nothing to be seen.
  assert.match(card(), /<button type="button" aria-label="Globe motion" aria-pressed="true">/);
  assert.match(
    card({ paused: true }),
    /<button type="button" aria-label="Globe motion" aria-pressed="false">/,
  );
  assert.doesNotMatch(card({ reducedMotion: true }), /Globe motion/);
  assert.doesNotMatch(card(), /Pause|Play globe/);
  // The eyebrow names what is live, the sunlight, with a still marker: no beacon, no "LIVE".
  const html = card();
  assert.match(text(html), /3D EARTH · SUNLIGHT NOW/);
  assert.doesNotMatch(text(html), /\bLIVE\b/);
  assert.doesNotMatch(css, /@keyframes|animation:/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /transition: none;/);
});

test('the globe credits NASA GIBS, dates only what it has loaded and never claims safety', () => {
  const html = card();
  assert.match(html, /href="https:\/\/nasa-gibs\.github\.io\/gibs-api-docs\/access-basics\/"/);
  assert.match(text(html), /Blue Marble shaded relief and bathymetry \(static\)/);
  assert.match(text(html), /not radar or a live camera, and never a sign that a place is safe/);
  // The year is dropped on a phone, where the coverage joins the date in one small tile.
  assert.match(
    html,
    /<time dateTime="2026-11-17">17 Nov<span class="globe-more"> 2026<\/span><\/time>/,
  );
  assert.match(html, /<span class="globe-narrow"> · 46% imaged<\/span>/);
  assert.match(text(html), /Imaged that day 46% of Earth/);
  assert.match(html, /<div class="globe-coverage">/);
  // Before NASA answers there is no mosaic date on screen, and nothing but GIBS is credited.
  const first = globe();
  assert.doesNotMatch(first, /<time dateTime="\d{4}-\d{2}-\d{2}">/);
  assert.match(text(first), /Imagery: NASA EOSDIS GIBS ↗ · loading/);
  assert.doesNotMatch(text(first), /Blue Marble shaded|NOAA-20 VIIRS corrected/);
  assert.match(text(first), /SELECTED PLACE Chennai 13\.08°N, 80\.27°E/);
  assert.match(text(first), /(Daylight|Twilight|Night) · sun /);
  // A point chosen on the map or the globe is named by its coordinates: they are not repeated.
  const point = text(
    card({
      place: {
        ...chennai,
        id: 'map:8.86:44.93',
        name: '8.86°N, 44.93°E',
        latitude: 8.86,
        longitude: 44.93,
      },
    }),
  );
  assert.match(point, /SELECTED PLACE 8\.86°N, 44\.93°E (Daylight|Twilight|Night)/);
});

test('a failed look for a newer mosaic leaves the shown one dated, with a way to try again', () => {
  const html = card({
    daily: { ...mosaic, refreshError: 'NASA imagery metadata unavailable (503).' },
  });
  const words = text(html);
  // What is drawn is what is dated: the 17 Nov clouds stay, and the card still says 17 Nov.
  assert.match(words, /over NASA's 17 Nov 2026 satellite mosaic/);
  assert.match(html, /<time dateTime="2026-11-17">/);
  assert.match(words, /No imagery here on 17 Nov/);
  assert.match(words, /Not imaged that day/);
  assert.match(words, /NOAA-20 VIIRS corrected reflectance \(daily\)/);
  assert.doesNotMatch(words, /Unavailable|no clouds and no date|No daily imagery/);
  assert.match(html, /class="globe-warning" role="status"/);
  assert.match(
    words,
    /NASA could not be checked for a newer daily mosaic: NASA imagery metadata unavailable \(503\)\. The globe still shows the 17 Nov 2026 mosaic\./,
  );
  assert.match(html, />Try again<\/button>/);
});

test('where the mosaic has no imagery, the card and the key say so, and the globe hatches it', () => {
  const html = card();
  // Chennai lies in the 17 Nov gap: its card says the clouds are missing, not that it is clear.
  assert.match(text(html), /No imagery here on 17 Nov: map shown without clouds/);
  assert.match(html, /class="globe-place-line is-gap"/);
  assert.match(text(html), /Not imaged that day/);
  assert.match(
    text(html),
    /Hatched areas had no imagery that day: they show the cloud-free base map\./,
  );
  // New York is imaged that day.
  const newYork = card({
    place: { ...chennai, id: 'nyc', name: 'New York', latitude: 40.71, longitude: -74.01 },
  });
  assert.match(text(newYork), /Imaged by NOAA-20 on 17 Nov/);
  // A partial newest mosaic is passed over, and the notes say why.
  const older = card({
    daily: {
      ...mosaic,
      date: '2026-11-16',
      coverage: 0.94,
      skipped: { date: '2026-11-17', coverage: 0.46 },
    },
  });
  assert.match(
    text(older),
    /NASA's 17 Nov 2026 mosaic covers only 46% of Earth, so the globe shows 16 Nov 2026\./,
  );
  // The daily layer switched off: the static base has no clouds, and the card says so.
  const hidden = card({ showDaily: false });
  assert.match(text(hidden), /Daily mosaic Hidden/);
  assert.match(text(hidden), /Daily mosaic hidden; the base map has no clouds/);
  assert.doesNotMatch(text(hidden), /Not imaged that day/);
  assert.match(text(hidden), /static composite with no clouds/);
});

test('without a 3D view the card claims no outline, key or imagery it cannot show', () => {
  for (const status of ['unsupported', 'lost', 'failed'] as const) {
    const html = card({ status });
    const words = text(html);
    assert.match(
      words,
      /cannot draw warning outlines here\. The warning list and the satellite map show official warnings\./,
    );
    assert.match(html, /href="#alerts"/);
    assert.doesNotMatch(words, /outlined in red/);
    assert.doesNotMatch(html, /globe-legend|globe-credit|globe-facts/);
    assert.doesNotMatch(words, /NOAA-20|Not imaged|Imaged by|not radar/);
    assert.match(html, status === 'unsupported' ? /<p role="status">/ : /class="globe-fallback"/);
    const tools = opening(html, 'globe-tools');
    assert.ok(tools === '' || /hidden=""/.test(tools), `${status}: no controls to operate`);
  }
  assert.match(text(card({ status: 'unsupported' })), /could not start WebGL 2/);
  assert.match(card({ status: 'lost' }), />Restart globe<\/button>/);
  assert.doesNotMatch(card({ status: 'unsupported' }), /Restart globe/);
  // Both images failed: the subtitle says so, the notice offers another try, and no imagery is
  // credited or described, since none is drawn.
  const failed = card({
    base: { state: 'failed', message: 'NASA imagery is unavailable (503).' },
    daily: { state: 'failed', message: 'NASA imagery timed out.' },
  });
  assert.match(text(failed), /Day and night as they fall right now\. NASA imagery did not load\./);
  assert.doesNotMatch(text(failed), /over a recent NASA satellite mosaic/);
  assert.match(failed, /class="globe-warning" role="status"/);
  assert.match(text(failed), /plain sphere; that is missing imagery, not a view of the weather/);
  assert.match(failed, />Try again<\/button>/);
  assert.doesNotMatch(failed, /globe-credit/);
  assert.doesNotMatch(text(failed), /Satellite imagery, not radar|Blue Marble shaded|VIIRS/);
  // Only the base failed: the mosaic is credited, the base is not.
  const baseFailed = text(
    card({ base: { state: 'failed', message: 'NASA imagery is unavailable (503).' } }),
  );
  assert.match(baseFailed, /Imagery: NASA EOSDIS GIBS ↗ · NOAA-20 VIIRS corrected reflectance/);
  assert.doesNotMatch(baseFailed, /Blue Marble shaded relief/);
});

test('the warning note counts drawn outlines and never reads an empty map as no warning', () => {
  assert.match(text(globe([warning()])), /1 active official warning area is outlined in red\./);
  assert.match(
    text(globe([warning(), warning({ id: 'no-outline', geometry: null })])),
    /1 active official warning area is outlined in red\. 1 more has no outline to draw\./,
  );
  assert.match(
    text(globe([warning({ geometry: null })])),
    /Active warnings for this place have no outline to draw\./,
  );
  const none = text(globe());
  assert.match(none, /No outline here does not mean there is no warning\./);
  assert.match(globe(), /href="#alerts"/);
});

// Contrast: WCAG 2 relative luminance, as in tests/accessibility.test.ts.
function luminance([r, g, b]: number[]) {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
const hex = (value: string) => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
const ratio = (a: number[], b: number[]) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
const token = (name: string) =>
  new RegExp(`${name}: var\\([^,]+, (#[0-9a-f]{6})\\)`, 'i').exec(css)?.[1] ?? '';
const over = (rgb: number[], alpha: number, backdrop: number) =>
  rgb.map((channel) => channel * alpha + backdrop * (1 - alpha));

test('text over the globe stays at 4.5:1 even where its panel lies over white cloud', () => {
  const panel = /--globe-panel: rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(css);
  assert.ok(panel, 'the globe panels have one colour');
  const [r, g, b, alpha] = panel.slice(1).map(Number);
  for (const colour of [token('--globe-text'), token('--globe-muted'), token('--globe-teal')]) {
    assert.match(colour, /^#[0-9a-f]{6}$/i);
    assert.ok(ratio(hex(colour), over([r, g, b], alpha, 255)) >= 4.5, `${colour} over white`);
    assert.ok(ratio(hex(colour), over([r, g, b], alpha, 0)) >= 4.5, `${colour} over black`);
  }
  // A pressed toggle is marked by a teal ring of at least 3:1 against its panel.
  const pressed = /\.globe-tools button\[aria-pressed='true'\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(pressed, /box-shadow: inset 0 0 0 1px var\(--globe-teal\)/);
  assert.ok(ratio(hex(token('--globe-teal')), over([r, g, b], alpha, 255)) >= 3);
});

test('controls, the warnings link and focus keep 3:1 or more over space and over cloud', () => {
  // The scene behind the controls: the frame's darkest and lightest space, or white cloud.
  const space = [hex('#060a14'), hex('#0a1124')];
  const cloud = [255, 255, 255];
  const panel = /--globe-panel: rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/
    .exec(css)!
    .slice(1)
    .map(Number);
  // Boundaries of the tool buttons, the rotate pad and the key help: the palette's control line.
  assert.match(css, /--globe-control-line: var\(--aurora-line-strong, #5d6b92\);/);
  const line = hex(token('--globe-control-line'));
  for (const backdrop of [...space, cloud]) assert.ok(ratio(line, backdrop) >= 3, `${backdrop}`);
  // The warnings link: its text and icon on its own fill, over space and over cloud.
  const chip = /\.globe-alerts \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const fill = /background: rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(chip)!.slice(1).map(Number);
  const ink = /color: (#[0-9a-f]{6})/.exec(chip)![1];
  for (const backdrop of [0, 255]) {
    const under = over(fill.slice(0, 3), fill[3], backdrop);
    assert.ok(ratio(hex(ink), under) >= 4.5, `warnings text over ${backdrop}`);
    assert.ok(ratio(hex('#ff6b75'), under) >= 3, `warnings icon over ${backdrop}`);
  }
  // The focus ring is the palette's lavender, with a dark band beside it: 3:1 against that band
  // whatever lies behind, and against space where the band thins out.
  assert.match(css, /--globe-focus: var\(--aurora-focus, #c3bbff\);/);
  const focus = hex(token('--globe-focus'));
  const band = /--globe-focus-band: rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/
    .exec(css)!
    .slice(1)
    .map(Number);
  for (const backdrop of [0, 255])
    assert.ok(
      ratio(focus, over(band.slice(0, 3), band[3], backdrop)) >= 3,
      `band over ${backdrop}`,
    );
  for (const backdrop of space) assert.ok(ratio(focus, backdrop) >= 3);
  assert.ok(ratio(focus, over(panel.slice(0, 3), panel[3], 0)) >= 3, 'ring on a panel');
  assert.match(
    css,
    /\.globe-tools button:focus-visible,\s*\.globe-hud a:focus-visible \{\s*box-shadow: 0 0 0 5px var\(--globe-focus-band\);/,
  );
});

test('the globe follows the design system: no frosted chips, the shared card and no print', () => {
  // Frosted glass belongs to the page frame (the sidebar and top bar), never to the globe's chips.
  assert.doesNotMatch(css, /backdrop-filter/);
  // The card is the palette's panel fill inside its gradient hairline, as the other cards.
  const view = /\.globe-view \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(view, /--globe-card: var\(--aurora-panel-fill, rgba\(14, 22, 38, 0\.86\)\);/);
  assert.match(view, /border: 1px solid transparent;/);
  assert.match(
    view,
    /linear-gradient\(var\(--globe-card\), var\(--globe-card\)\) padding-box,\s*var\(\s*--aurora-hairline,/,
  );
  // System fonts only: nothing is fetched, and no family is named.
  assert.doesNotMatch(css, /@font-face|@import|url\s*\(|font-family/i);
  // Nothing animates on its own: transitions only, switched off under reduced motion.
  assert.doesNotMatch(css, /@keyframes|animation/);
  // On paper the globe is left out, as the map is: a WebGL canvas prints unreliably.
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /\.globe-slot \{\s*display: none;/);
});

test("when the globe's code cannot load, App's notice takes its place, its actions apart", async () => {
  const { default: OptionalPanel, reportCaughtError } =
    await import('../src/components/OptionalPanel');
  const panel = new OptionalPanel({
    label: '3D globe',
    className: 'globe-unavailable',
    onUseEssentials: () => {},
    children: null,
  });
  panel.state = { failed: true };
  const html = renderToStaticMarkup(panel.render());
  assert.match(
    html,
    /^<section class="panel globe-unavailable" role="alert"><h3>3D globe unavailable/,
  );
  // The buttons and the kit link are one wrapping row with gaps, never touching.
  assert.match(
    html,
    /<div class="optional-actions"><button class="secondary-button">Reload dashboard<\/button><button class="secondary-button">Use data saver<\/button><a href="\/offline\.html">Open emergency kit<\/a><\/div><\/section>$/,
  );
  const design = readFileSync(source('frontend-design.css'), 'utf8');
  const actions = /\n\.optional-actions \{([^}]*)\}/.exec(design)?.[1] ?? '';
  for (const rule of [/display: flex;/, /flex-wrap: wrap;/, /gap: 10px 16px;/])
    assert.match(actions, rule);
  assert.match(
    /\n\.optional-actions a \{([^}]*)\}/.exec(design)?.[1] ?? '',
    /text-decoration: underline;/,
  );
  // The notice keeps the gap below the card it replaces (24px, 18px on phones).
  assert.match(css, /\n\.globe-unavailable \{\s*margin-bottom: 24px;/);
  assert.match(css, /\.globe-slot,\s*\.globe-unavailable \{\s*margin-bottom: 18px;/);
  assert.match(
    readFileSync(source('App.tsx'), 'utf8'),
    /label="3D globe"\s+className="globe-unavailable"/,
  );
  // The failed download is explained on the page: the console gets a warning, not an error.
  // Any other error a boundary catches is still an error.
  const said: string[] = [];
  const log = {
    warn: (message: string) => void said.push(`warn: ${message}`),
    error: (error: unknown) => void said.push(`error: ${error}`),
  };
  const missing = new Error('Failed to fetch dynamically imported module');
  reportCaughtError(missing, { errorBoundary: panel }, log);
  reportCaughtError(new Error('A render failed.'), { errorBoundary: {} }, log);
  assert.deepEqual(said, [
    'warn: StormSignal: an optional tool could not load: Failed to fetch dynamically imported module',
    'error: Error: A render failed.',
  ]);
  assert.match(
    readFileSync(source('main.tsx'), 'utf8'),
    /createRoot\([^)]*\)!?, \{ onCaughtError: reportCaughtError \}\)/,
  );
});

test('warning outlines keep 3:1 over cloud and ocean on their dark casing', () => {
  const { colour, width, casing, casingOpacity, casingWidth } = WARNING_LINE;
  assert.equal(colour, '#ff6b75', "the map's red");
  assert.ok(casingWidth >= width + 2, 'the casing shows on both sides of the line');
  const white = [255, 255, 255];
  for (const backdrop of [255, 0])
    assert.ok(
      ratio(hex(colour), over(hex(casing), casingOpacity, backdrop)) >= 3,
      `red on its casing over ${backdrop}`,
    );
  assert.ok(ratio(over(hex(casing), casingOpacity, 255), white) >= 3, 'the casing against cloud');
  assert.ok(ratio(hex(colour), white) < 3, 'without the casing, white cloud would fail');
  // The key shows the same line.
  assert.match(css, /\.globe-key\.is-warning \{[^}]*#070b16 0 2px,\s*var\(--globe-red\) 2px 4px/);
  assert.match(css, /--globe-red: #ff6b75;/);
});

test('focus stays visible, in forced colours too', () => {
  assert.match(
    css,
    /\.globe-surface:focus-visible::after \{[^}]*inset 0 0 0 2px var\(--globe-focus\),\s*inset 0 0 0 4px var\(--globe-focus-band\)/,
  );
  // That inset ring is the surface's only one: the page's outline for [tabindex='0'] is turned
  // off by a rule specific enough to win over it (tests/accessibility.test.ts checks the cascade).
  assert.match(css, /\.globe-view \.globe-surface:focus-visible \{\s*outline: none;\s*\}/);
  assert.match(css, /\.globe-surface:focus-visible ~ \.globe-crosshair/);
  assert.match(
    css,
    /\.globe-view button:focus-visible,\s*\.globe-view a:focus-visible \{\s*outline: 2px solid var\(--globe-focus\);/,
  );
  const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
  assert.match(forced, /\.globe-surface:focus-visible::after \{[^}]*outline: 3px solid Highlight;/);
  assert.match(forced, /\.globe-key,[^{]*\{\s*forced-color-adjust: none;/);
  // Forced colours drop a pressed toggle's teal ring (a box-shadow) and turn its icon to the text
  // colour: on and off looked the same. It takes the system's selection colours instead, as the
  // page's other toggles do, and keeps the dark band beside its focus ring.
  const pressed = /\.globe-tools button\[aria-pressed='true'\] \{([^}]*)\}/.exec(forced)?.[1] ?? '';
  for (const rule of [
    /forced-color-adjust: none;/,
    /border-color: Highlight;/,
    /background: Highlight;/,
    /(?:^|\s)color: HighlightText;/,
  ])
    assert.match(pressed, rule);
  assert.match(
    forced,
    /\.globe-tools button\[aria-pressed='true'\]:focus-visible \{\s*box-shadow: 0 0 0 5px var\(--globe-focus-band\);/,
  );
  // Both toggles are pressed buttons: the daily mosaic and the globe's motion.
  assert.equal(card().match(/<button [^>]*aria-pressed="true"/g)?.length, 2);
});

test('every icon on the card is decoration, hidden from screen readers: the words beside it speak', () => {
  // An icon left to a screen reader is read as an unnamed image, between the words that say what
  // it means. Chennai by day, at twilight and by night, as the place line shows it; the controls
  // with the motion switch on and off; a notice; and the card without WebGL 2.
  const phase = (wanted: string) => {
    for (let minute = 0; minute < 24 * 60; minute++) {
      const now = Date.parse('2026-11-19T00:00:00Z') + minute * 60_000;
      if (daylight(solarElevation(chennai.latitude, chennai.longitude, now)).phase === wanted)
        return now;
    }
    throw new Error(`no ${wanted} at Chennai on 19 November`);
  };
  const cards = {
    day: card(),
    twilight: card({ now: phase('twilight') }),
    night: card({ now: phase('night') }),
    paused: card({ paused: true, showDaily: false }),
    notice: card({ base: { state: 'failed', message: 'NASA imagery is unavailable (503).' } }),
    unsupported: card({ status: 'unsupported', alertCount: 2 }),
    'first paint': globe([warning()]),
  };
  for (const [state, html] of Object.entries(cards)) {
    const icons = html.match(/<svg\b[^>]*>/g) ?? [];
    assert.ok(icons.length >= 3, `${state}: ${icons.length} icons`);
    for (const icon of icons) assert.match(icon, /\saria-hidden="true"/, `${state}: ${icon}`);
  }
  // Among them, those that change with the state: the sun, dusk or moon on the place line, and
  // the icon of the Globe motion switch.
  for (const [state, line] of [
    ['day', 'is-day'],
    ['twilight', 'is-twilight'],
    ['night', 'is-night'],
  ] as const)
    assert.match(
      cards[state],
      new RegExp(`<span class="globe-place-line ${line}"><svg [^>]*aria-hidden="true"`),
      state,
    );
  for (const html of [cards.day, cards.paused])
    assert.match(
      html,
      /aria-label="Globe motion" aria-pressed="(?:true|false)"><svg [^>]*aria-hidden="true"/,
    );
});

test("the place card's imagery line shows a satellite for imagery, a struck-out image for none", () => {
  // The icon says at a glance what the words beside it say: NOAA-20 imaged the place, or NASA is
  // still being asked; or there is no imagery there, or none is shown.
  const newYork = { ...chennai, id: 'nyc', name: 'New York', latitude: 40.71, longitude: -74.01 };
  for (const [state, html, kind, words, icon] of [
    ['Chennai, in the 17 Nov gap', card(), 'gap', /No imagery here on 17 Nov/, 'image-off'],
    ['New York', card({ place: newYork }), 'imaged', /Imaged by NOAA-20 on 17 Nov/, 'satellite'],
    ['NASA asked', card({ daily: { state: 'loading' } }), 'pending', /Checking NASA/, 'satellite'],
    ['mosaic hidden', card({ showDaily: false }), 'none', /Daily mosaic hidden;/, 'image-off'],
  ] as const) {
    const line = new RegExp(
      `<span class="globe-place-line is-${kind}"><svg [^>]*class="lucide lucide-([\\w-]+)"[^>]*>.*?</svg>([^<]*)</span>`,
    ).exec(html);
    assert.ok(line, `${state}: the imagery line`);
    assert.match(line[2], words, state);
    assert.equal(line[1], icon, state);
  }
});

test('the zoom hint is drawn only just after a wheel turn has scrolled past the globe', () => {
  assert.doesNotMatch(card(), /globe-wheel-hint/, 'a ready globe nobody has scrolled over');
  assert.doesNotMatch(globe(), /globe-wheel-hint/, 'GlobeView as the browser first paints it');
  assert.match(
    card({ wheelHint: true }),
    /<p class="globe-wheel-hint" aria-hidden="true">Hold Ctrl and scroll, or pinch, to zoom the globe<\/p>/,
  );
});
