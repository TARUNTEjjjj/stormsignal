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
]) {
  const response = await check(path);
  assert.equal(response.status, 200, path);
  assert.ok((await response.text()).length, path);
}
const html = await (await check('/')).text();
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
assert.equal((await check('/api/alerts?lat=bad&lon=0')).status, 400);
assert.equal((await check('/api/alerts', { method: 'POST' })).status, 405);
assert.equal((await check('/missing')).status, 404);
assert.equal((await check('/server/index.js')).status, 404);
console.log(
  'Worker artifact: HTML/assets, offline aliases, conditional reads and API boundary passed.',
);
