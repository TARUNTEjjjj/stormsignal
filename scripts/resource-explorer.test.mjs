import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveObjectURL} from 'node:buffer';
import {normalizeCatalog, safeRepositoryUrl, filterItems, observedDate, statusSummary, loadCatalog, startExplorer, PROJECT, LIVE_CATALOG_URL} from '../resources/explorer.mjs';
import {catalogJSON} from '../resources/catalog.mjs';
import {stageResourceExplorer, publicResourceFiles} from './stage-resource-explorer.mjs';

const entry = overrides => ({id:1,fullName:'example/library',url:'https://github.com/example/library',description:'Linear algebra learning',topics:['math'],category:'math',stars:150,score:10,...overrides});
const catalog = items => ({schemaVersion:1,project:PROJECT,status:'live',categories:[{id:'math',title:'Mathematics'}],items});

test('untrusted catalog cannot create executable or off-site repository links', () => {
  for (const url of ['javascript:alert(1)','https://github.com.evil.test/example/library','http://github.com/example/library','https://user:pass@github.com/example/library','https://github.com/example/library?redirect=bad','https://github.com/example/library#bad','https://github.com/different/project']) {
    assert.equal(safeRepositoryUrl(entry({url})), null, url);
  }
  assert.equal(safeRepositoryUrl(entry()), 'https://github.com/example/library');
  assert.throws(()=>normalizeCatalog(catalog([entry({url:'javascript:alert(1)'}),entry()])), /Invalid repository/);
  assert.throws(()=>normalizeCatalog({...catalog([]),project:'foreign-project'}), /project/);
  assert.throws(()=>normalizeCatalog({schemaVersion:999,items:[],categories:[]}), /Unsupported/);
});

test('search combines terms and category; ranking handles absent metadata deterministically', () => {
  const items = normalizeCatalog(catalog([
    entry({fullName:'b/second',url:'https://github.com/b/second',stars:null,score:20,pushedAt:null}),
    entry({fullName:'a/first',url:'https://github.com/a/first',stars:1000,score:20,pushedAt:'2025-01-01T00:00:00Z'}),
    entry({fullName:'c/third',url:'https://github.com/c/third',description:'Graphs',topics:['network'],stars:2,score:1,pushedAt:'2026-01-01T00:00:00Z'}),
  ])).items;
  assert.deepEqual(filterItems(items,{query:'linear math'}).map(x=>x.fullName),['a/first','b/second']);
  assert.equal(filterItems(items,{category:'unknown'}).length,0);
  assert.equal(filterItems(items,{sort:'stars'})[0].fullName,'a/first');
  assert.equal(filterItems(items,{sort:'stars'}).at(-1).fullName,'b/second');
  assert.equal(filterItems(items,{sort:'recent'})[0].fullName,'c/third');
  assert.equal(items[0].fullName,'b/second','filtering must not mutate the source snapshot');
});

test('unknown or partial observations never appear as verified live data', () => {
  assert.equal(observedDate('broken date'),'not yet verified');
  assert.equal(observedDate(null),'not yet verified');
  assert.equal(observedDate('2026-11-14T23:50:00-05:00'),'2026-11-15');
  assert.match(statusSummary({status:'seed'}),/not been verified/);
  assert.match(statusSummary({status:'partial',fetchedAt:'2026-11-14T00:00:00Z'}),/observations may be older/);
  assert.match(statusSummary({status:'live',fetchedAt:'2026-11-14T00:00:00Z'},'github'),/GitHub snapshot/);
  assert.match(statusSummary({status:'live',fetchedAt:'2026-11-14T00:00:00Z'},'bundled'),/Bundled snapshot/);
  const normalized=normalizeCatalog(catalog([entry({stars:-1,score:NaN,fetchedAt:'invalid',topics:[null,'valid']})]));
  assert.equal(normalized.items[0].stars,null);
  assert.equal(normalized.items[0].fetchedAt,null);
  assert.deepEqual(normalized.items[0].topics,['valid']);
});

test('published explorer includes only the explicit public files, never cache/config', async t => {
  const root=await mkdtemp(join(tmpdir(),'resource-explorer-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'resources'));
  for(const file of publicResourceFiles) await writeFile(join(root,'resources',file), file==='catalog.json'?JSON.stringify(catalog([])):file==='offline-worker.js'?await readFile(new URL('../resources/offline-worker.js',import.meta.url),'utf8'):'public asset');
  await writeFile(join(root,'resources','sources.json'),'private collection configuration');
  await writeFile(join(root,'resources','.cache.json'),'private response cache');
  const output=join(root,'public','resources');
  await stageResourceExplorer(root,output);
  assert.deepEqual((await readdir(output)).sort(),[...publicResourceFiles].sort());
  assert.equal(JSON.parse(await readFile(join(output,'catalog.json'),'utf8')).schemaVersion,1);
});


test('live snapshots use one fixed repository URL without credentials and strip unrelated fields', async () => {
  const calls=[];
  const snapshot={...catalog([entry()]),token:'not public metadata',_cache:{ignored:true}};
  const loaded=await loadCatalog({fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(snapshot));}});
  assert.equal(loaded.source,'github');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,`https://raw.githubusercontent.com/TARUNTEjjjj/${PROJECT}/main/resources/catalog.json`);
  assert.equal(calls[0].options.credentials,'omit');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.cache,'no-cache');
  assert.equal(Object.hasOwn(loaded.catalog,'token'),false);
  assert.equal(Object.hasOwn(loaded.catalog,'_cache'),false);
});

test('wrong project, malformed JSON, unsafe links, and HTTP failures use the bundled snapshot', async () => {
  for(const bad of [()=>new Response(JSON.stringify({...catalog([]),project:'another-project'})),()=>new Response('<html>Error page</html>'),()=>new Response(JSON.stringify(catalog([entry({url:'https://attacker.test/project'})]))),()=>new Response('Unavailable',{status:503})]) {
    const calls=[];
    const loaded=await loadCatalog({fetchImpl:async url=>{calls.push(String(url));return calls.length===1?bad():new Response(JSON.stringify(catalog([entry()])));}});
    assert.equal(loaded.source,'bundled');assert.equal(loaded.catalog.items.length,1);
    assert.equal(calls[0],LIVE_CATALOG_URL);
    assert.match(calls[1],/\/resources\/catalog\.json$/);
    assert.notEqual(calls[1],LIVE_CATALOG_URL);
  }
});

test('whole-transfer deadline bounds a stalled fetch and a stalled response body', async () => {
  for(const stall of [()=>new Promise(()=>{}),()=>new Response(new ReadableStream({start(){},cancel(){return new Promise(()=>{});}}))]) {
    let calls=0;const started=Date.now();
    const loaded=await loadCatalog({remoteTimeoutMs:15,localTimeoutMs:100,fetchImpl:async()=>++calls===1?stall():new Response(JSON.stringify(catalog([])))});
    assert.equal(loaded.source,'bundled');assert.equal(calls,2);
    assert.ok(Date.now()-started<1500,'An uncooperative transport/body must not block fallback');
  }
});

test('declared and streamed oversized snapshots fall back without waiting on cancellation', async () => {
  for(const declared of [true,false]) {
    let calls=0,cancelled=false;
    const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2048));},cancel(){cancelled=true;return new Promise(()=>{});}});
    const loaded=await loadCatalog({maxBytes:1024,fetchImpl:async()=>++calls===1?new Response(body,{headers:declared?{'Content-Length':'2048'}:{}}):new Response(JSON.stringify(catalog([])))});
    assert.equal(loaded.source,'bundled');assert.equal(cancelled,true);
  }
});

test('invalid bundled snapshots remain errors, and unbounded request options are rejected', async () => {
  await assert.rejects(loadCatalog({fetchImpl:async()=>new Response('no',{status:503})}),/unavailable/);
  await assert.rejects(loadCatalog({remoteTimeoutMs:Infinity}),/Invalid collection request limits/);
  await assert.rejects(loadCatalog({maxBytes:1024*1024+1}),/Invalid collection request limits/);
});

// GitHub lists topics alphabetically, so the terms that describe a repository best are often past the sixth.
const lateTopics = ['atmospheric-science','hacktoberfest','hodograph','meteorology','plotting','python','scientific-computations','skew-t','weather','weather-data'];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
async function until(condition) { for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 2)); }
class PageNode {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.textContent = ''; this.className = ''; this.value = ''; this.hidden = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  get childElementCount() { return this.children.length; }
  get options() { return this.children; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  querySelectorAll() { return []; }
  focus() {}
}
// The real startExplorer() on a minimal page with the ids from index.html. Browser storage is
// blocked the way Chromium denies site data, and the network is the given fetch stub.
function openLibrary(t, fetchImpl) {
  const nodes = new Map(), download = new PageNode('a');
  const byId = id => nodes.get(id) ?? nodes.set(id, new PageNode()).get(id);
  byId('load-error').hidden = true; byId('empty-state').hidden = true; byId('sort').value = 'recommended';
  byId('freshness').textContent = 'Loading the published collection…';
  const saved = Object.fromEntries(['document','window','fetch','BroadcastChannel','indexedDB'].map(name => [name, globalThis[name]]));
  let started;
  t.after(async () => {
    (await started?.catch(() => null))?.stop();
    if (download.href) URL.revokeObjectURL(download.href);
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; }
  });
  globalThis.BroadcastChannel = undefined; // an open channel would keep the test process alive
  globalThis.indexedDB = {open() { const request = {}; setTimeout(() => request.onerror?.()); return request; }};
  globalThis.window = {scrollX: 0, scrollY: 0, scrollTo() {}, addEventListener() {}, removeEventListener() {}, location: {origin: 'https://library.test', href: 'https://library.test/resources/'}};
  globalThis.document = {title: '', activeElement: null, visibilityState: 'visible', getElementById: byId, createElement: tag => new PageNode(tag),
    querySelector: selector => selector === '.download-link' ? download : null, addEventListener() {}, removeEventListener() {}};
  globalThis.fetch = fetchImpl;
  return {byId, download, start: () => (started = startExplorer()),
    type(text) { byId('search').value = text; for (const listener of byId('search').listeners.input) listener({}); }};
}
const pageCatalog = JSON.stringify({...catalog([entry({topics: lateTopics}), entry({id: 2, fullName: 'example/other', url: 'https://github.com/example/other', topics: ['graphs']})]), fetchedAt: '2026-11-15T00:00:00Z'});

test('search and the saved collection keep topics listed after the sixth, within the published bound of 30', () => {
  const normalized = normalizeCatalog(catalog([entry({topics: lateTopics})]));
  assert.deepEqual(normalized.items[0].topics, lateTopics);
  assert.deepEqual(filterItems(normalized.items, {query: 'skew-t'}).map(item => item.fullName), ['example/library']);
  assert.deepEqual(filterItems(normalized.items, {query: 'Weather-Data python'}).map(item => item.fullName), ['example/library']);
  assert.deepEqual(filterItems(normalized.items, {query: 'radar'}), []);
  assert.deepEqual(JSON.parse(catalogJSON(normalized)).items[0].topics, lateTopics, 'saved offline copy');
  const many = Array.from({length: 40}, (_, n) => `topic-${n}`);
  assert.equal(normalizeCatalog(catalog([entry({topics: many})])).items[0].topics.length, 30, 'untrusted topic lists stay bounded');
});

test('every topic in the committed catalog finds its repository', async () => {
  const committed = JSON.parse(await readFile(new URL('../resources/catalog.json', import.meta.url), 'utf8'));
  const items = normalizeCatalog(committed).items;
  const missed = committed.items.flatMap(item => item.topics
    .filter(topic => !filterItems(items, {query: topic}).some(found => found.fullName === item.fullName && found.category === item.category))
    .map(topic => `${item.fullName}: ${topic}`));
  assert.deepEqual(missed, []);
});

test('the library finds a late topic, still shows at most six topic chips per card, and downloads every topic', async t => {
  const page = openLibrary(t, async () => new Response(pageCatalog));
  await page.start();
  assert.equal(page.byId('result-count').textContent, '2 of 2 resources');
  page.type('skew-t');
  assert.equal(page.byId('result-count').textContent, '1 of 2 resources');
  assert.equal(page.byId('empty-state').hidden, true);
  const chips = page.byId('resource-grid').children[0].children.find(child => child.className === 'topics').children.map(chip => chip.textContent);
  assert.deepEqual(chips, lateTopics.slice(0, 6), 'cards keep the compact six-topic list');
  page.type('no-such-topic');
  assert.equal(page.byId('empty-state').hidden, false);
  const exported = JSON.parse(await resolveObjectURL(page.download.href).text());
  assert.deepEqual(exported.items.find(item => item.fullName === 'example/library').topics, lateTopics, 'Download collection');
});

test('blocked browser storage does not announce a failure while the collection is still loading', async t => {
  const bundled = deferred();
  const page = openLibrary(t, url => String(url) === LIVE_CATALOG_URL ? Promise.resolve(new Response(pageCatalog)) : bundled.promise);
  const started = page.start();
  await until(() => /Offline saving unavailable/.test(page.byId('offline-status').textContent));
  assert.match(page.byId('offline-status').textContent, /Offline saving unavailable/, 'the storage failure is reported in its own line');
  assert.equal(page.byId('load-error').hidden, true, 'nothing has failed yet: the bundled copy is still loading');
  assert.equal(page.byId('freshness').textContent, 'Loading the published collection…');
  bundled.resolve(new Response(pageCatalog));
  await started;
  assert.equal(page.byId('resource-grid').children.length, 2);
  assert.equal(page.byId('load-error').hidden, true);
  assert.match(page.byId('freshness').textContent, /GitHub snapshot/);
});

test('the area and order controls are view state for app updates; a typed search stays protected', async () => {
  const html = await readFile(new URL('../resources/index.html', import.meta.url), 'utf8');
  for (const id of ['category', 'sort']) assert.match(html, new RegExp(`<select id="${id}" data-update-safe>`), id);
  assert.doesNotMatch(html.match(/<input id="search"[^>]*>/)[0], /data-update-safe/);
});

test('the failure panel appears once the bundled and the published copies are both unavailable', async t => {
  const page = openLibrary(t, async () => { throw new TypeError('offline'); });
  await page.start();
  assert.equal(page.byId('load-error').hidden, false);
  assert.equal(page.byId('freshness').textContent, 'Collection unavailable. Reconnect and use Refresh now.');
  assert.equal(page.byId('resource-grid').children.length, 0);
});
