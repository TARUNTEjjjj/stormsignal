import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import worker from '../dist/server/index.js';
const check = (path, options) =>
  worker.fetch(new Request(`https://stormsignal.invalid${path}`, options));
// Every page gets the headers that Pages adds to all pages: the "/*" rule of public/_headers, read
// as Pages reads it. scripts/verify-pages.mjs checks its values and rejects a repeated rule.
let pageHeaders = [];
let rule;
for (const text of (await readFile('dist/_headers', 'utf8')).split('\n')) {
  const line = text.trim();
  if (!line || line.startsWith('#')) continue;
  // A line starting with "/" or "scheme://" opens a rule, however it is indented, and a later
  // rule for the same path replaces the earlier one. "! Name" means no page sends Name.
  if (/^([^\s]+:\/\/|\/)/.test(line)) {
    rule = line;
    if (rule === '/*') pageHeaders = [];
  } else if (rule === '/*')
    pageHeaders.push(
      line.startsWith('!') ? [line.slice(1).trim(), null] : line.split(/\s*:\s*(.*)/s),
    );
}
assert.ok(pageHeaders.length, 'dist/_headers must have a "/*" rule');
const sendsPageHeaders = (response, path) => {
  for (const [name, value] of pageHeaders)
    assert.equal(response.headers.get(name), value, `${path} ${name}`);
};
for (const path of [
  '/',
  '/offline.html',
  '/offline',
  '/preparedness',
  '/sw.js',
  '/icon.svg',
  '/manifest.webmanifest',
  '/third-party-licenses.md',
  '/resources/',
  '/resources/catalog.json',
  '/resources/explorer.mjs',
  '/resources/app-updates.mjs',
  '/app-version.json',
]) {
  const response = await check(path);
  assert.equal(response.status, 200, path);
  sendsPageHeaders(response, path);
  assert.ok((await response.text()).length, path);
}
assert.equal((await check('/resources')).status, 308);
assert.match((await check('/resources/explorer.mjs')).headers.get('Content-Type'), /javascript/);
assert.equal((await (await check('/resources/catalog.json')).json()).schemaVersion, 1);
const html = await (await check('/')).text();
const versionResponse = await check('/app-version.json');
assert.equal(versionResponse.headers.get('Cache-Control'), 'no-store');
const release = await versionResponse.json();
assert.equal(release.project, 'stormsignal');
assert.match(release.version, /^[a-f0-9]{64}$/);
for (const path of ['/', '/offline.html', '/preparedness', '/resources/'])
  assert.ok(
    (await (await check(path)).text()).includes(`name="app-version" content="${release.version}"`),
    path,
  );
for (const path of [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((m) => m[1])) {
  const response = await check(path);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('Cache-Control'), /immutable/);
}
const kit = await check('/offline.html');
assert.equal(await kit.text(), await readFile('dist/offline.html', 'utf8'));
const conditional = await check('/offline.html', {
  headers: { 'If-None-Match': kit.headers.get('ETag') },
});
assert.equal(conditional.status, 304);
assert.equal((await check('/api/alerts?lat=bad&lon=0&country=US')).status, 400);
assert.equal((await check('/api/alerts', { method: 'POST' })).status, 405);
// As on Pages, a warning check is kept alive past a client disconnect with waitUntil.
const kept = [];
await worker.fetch(
  new Request('https://stormsignal.invalid/api/alerts?lat=bad&lon=0&country=US'),
  undefined,
  { waitUntil: (promise) => kept.push(promise) },
);
assert.equal(kept.length, 1, 'A warning check must be handed to waitUntil');
await Promise.all(kept);
// As on Pages: an unknown path gets the shipped 404 page; an unknown API path never gets a page.
const missing = await check('/missing');
assert.equal(missing.status, 404);
assert.match(missing.headers.get('Content-Type'), /^text\/html/);
assert.equal(missing.headers.get('Cache-Control'), 'no-store');
sendsPageHeaders(missing, '/missing');
assert.equal(await missing.text(), await readFile('dist/404.html', 'utf8'));
const missingHead = await check('/missing', { method: 'HEAD' });
assert.equal(missingHead.status, 404);
assert.equal(await missingHead.text(), '');
const unknownApi = await check('/api/unknown');
assert.equal(unknownApi.status, 404);
assert.equal(await unknownApi.text(), 'Not found');
assert.equal((await check('/server/index.js')).status, 404);
// three.js belongs to the optional globe, which loads only in Full workspace with a connection,
// and only after the globe's own code has found WebGL 2. So it must stay out of the entry chunk
// and everything the entry imports (and so out of the files the offline shell installs), and the
// globe's code may reach it only through dynamic imports. three.js must be among those, or the
// checks prove nothing: 'THREE.WebGLRenderer:' is in its renderer's own messages, where the
// globe's code only names the class.
const manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8'));
const reached = (keys, ways = ['imports']) => {
  const found = new Set();
  const visit = (key) => {
    if (found.has(key)) return;
    found.add(key);
    for (const way of ways) for (const dependency of manifest[key]?.[way] ?? []) visit(dependency);
  };
  for (const key of keys) visit(key);
  return found;
};
const code = (key) => readFile(`dist/${manifest[key].file}`, 'utf8');
const isThree = async (key) => (await code(key)).includes('THREE.WebGLRenderer:');
const essential = reached(Object.keys(manifest).filter((key) => manifest[key].isEntry));
assert.ok(essential.size, 'The build manifest lists an entry chunk');
for (const key of essential)
  assert.equal(
    (await code(key)).includes('WebGLRenderer'),
    false,
    `three.js must not load with ${manifest[key].file}`,
  );
const globe = 'src/components/GlobeView.tsx';
assert.ok(manifest[globe]?.isDynamicEntry, 'The globe must be loaded on demand');
// The globe's skeleton is drawn before its code arrives, so the dashboard's own stylesheet must
// size it: the slot and the card's height rules ship with the entry.
const entryCss = (
  await Promise.all(
    [...essential].flatMap((key) =>
      (manifest[key].css ?? []).map((file) => readFile(`dist/${file}`, 'utf8')),
    ),
  )
).join('\n');
for (const rule of [
  '.globe-slot{',
  'container:globe/inline-size',
  '.globe-view{',
  '.globe-loading',
])
  assert.ok(entryCss.includes(rule), `The dashboard's stylesheet must carry ${rule}`);
// Every visit downloads the dashboard's stylesheet, Data saver's included, so it keeps to a budget
// (as JavaScript chunks do below): growing it is a decision, not an accident. 84 kB (17.2 kB
// compressed) on 19 November 2026, with the 3D globe's card styles.
const CSS_BUDGET = { bytes: 90_000, compressed: 18_500 };
const cssBytes = Buffer.byteLength(entryCss);
const cssCompressed = gzipSync(entryCss, { level: 9 }).length;
assert.ok(
  cssBytes <= CSS_BUDGET.bytes,
  `The dashboard's stylesheet is ${cssBytes} bytes, over ${CSS_BUDGET.bytes}`,
);
assert.ok(
  cssCompressed <= CSS_BUDGET.compressed,
  `The dashboard's stylesheet is ${cssCompressed} bytes compressed, over ${CSS_BUDGET.compressed}`,
);
const globeCode = [...reached([globe])].filter((key) => !essential.has(key));
for (const key of globeCode)
  assert.equal(await isThree(key), false, `${manifest[key].file} loads three.js before WebGL 2`);
const onDemand = [...reached(manifest[globe].dynamicImports ?? [])].filter(
  (key) => !essential.has(key) && !globeCode.includes(key),
);
const threeChunks = [];
for (const key of onDemand) if (await isThree(key)) threeChunks.push(key);
assert.ok(threeChunks.length, 'three.js must load with the globe, on demand');
const installed = JSON.parse(
  /const BUILD_ASSETS=(\[[^\]]*\]);/.exec(await readFile('dist/sw.js', 'utf8'))?.[1] ?? 'null',
);
assert.ok(Array.isArray(installed), 'sw.js lists the files it installs');
for (const key of [...globeCode, ...onDemand])
  assert.ok(!installed.includes(`/${manifest[key].file}`), `sw.js installs ${manifest[key].file}`);
// vite.config.ts raises the chunk-size warning for three.js's chunk; every other chunk keeps
// Vite's default limit of 500 kB.
for (const [key, chunk] of Object.entries(manifest)) {
  if (!chunk.file.endsWith('.js')) continue;
  const limit = threeChunks.includes(key) ? 600_000 : 500_000;
  const { size } = await stat(`dist/${chunk.file}`);
  assert.ok(size <= limit, `${chunk.file} is ${size} bytes, over ${limit}`);
}
console.log(
  `Worker artifact: HTML/assets, offline aliases, conditional reads, 404 page, API boundary, on-demand globe and stylesheet budget (${cssBytes} bytes, ${cssCompressed} compressed) passed.`,
);
