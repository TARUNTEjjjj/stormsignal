import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../dist/server/index.js';
const check = (path, options) =>
  worker.fetch(new Request(`https://stormsignal.invalid${path}`, options));
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
  assert.ok((await response.text()).length, path);
}
assert.equal((await check('/resources')).status, 308);
assert.match((await check('/resources/explorer.mjs')).headers.get('Content-Type'), /javascript/);
assert.equal((await (await check('/resources/catalog.json')).json()).schemaVersion, 1);
const html = await (await check('/')).text();
const versionResponse=await check('/app-version.json');
assert.equal(versionResponse.headers.get('Cache-Control'),'no-store');
const release=await versionResponse.json();
assert.equal(release.project,'stormsignal');
assert.match(release.version,/^[a-f0-9]{64}$/);
for(const path of ['/','/offline.html','/preparedness','/resources/'])
  assert.ok((await (await check(path)).text()).includes(`name="app-version" content="${release.version}"`),path);
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
assert.equal((await check('/missing')).status, 404);
assert.equal((await check('/server/index.js')).status, 404);
console.log(
  'Worker artifact: HTML/assets, offline aliases, conditional reads and API boundary passed.',
);
