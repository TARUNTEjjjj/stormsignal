import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
console.log(
  'Worker artifact: HTML/assets, offline aliases, conditional reads, 404 page and API boundary passed.',
);
