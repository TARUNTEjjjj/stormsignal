import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import worker from '../pages-dist/_worker.js';

const entries = await readdir('pages-dist');
for (const forbidden of ['server', '.vite', '.openai', '.git', '.env'])
  assert.ok(!entries.includes(forbidden), `Private build material in Pages output: ${forbidden}`);
for (const asset of ['index.html', 'offline.html', 'preparedness.html', 'sw.js', '404.html'])
  assert.deepEqual(await readFile(`pages-dist/${asset}`), await readFile(`dist/${asset}`));
assert.deepEqual(JSON.parse(await readFile('pages-dist/_routes.json', 'utf8')), {
  version: 1,
  include: ['/api/*'],
  exclude: [],
});
const env = {
  ASSETS: {
    async fetch() {
      throw new Error('An API request must not fall back to a static HTML page');
    },
  },
};
const check = (path, options) =>
  worker.fetch(new Request(`https://stormsignal.invalid${path}`, options), env);
const invalid = await check('/api/alerts?lat=bad&lon=0');
assert.equal(invalid.status, 400);
assert.match(invalid.headers.get('Content-Type'), /application\/json/);
assert.equal(invalid.headers.get('Cache-Control'), 'no-store');
assert.equal((await invalid.json()).error, true);
assert.equal((await check('/api/alerts', { method: 'POST' })).status, 405);
assert.equal((await check('/api/unknown')).status, 404);
const headers = await readFile('pages-dist/_headers', 'utf8');
assert.match(headers, /X-Content-Type-Options: nosniff/);
assert.match(headers, /\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/);
console.log('Pages artifact: API validation, static parity, routing and output isolation passed.');
