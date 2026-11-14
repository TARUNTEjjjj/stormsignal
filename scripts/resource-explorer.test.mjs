import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeCatalog, safeRepositoryUrl, filterItems, observedDate, statusSummary} from '../resources/explorer.mjs';
import {stageResourceExplorer, publicResourceFiles} from './stage-resource-explorer.mjs';

const entry = overrides => ({id:1,fullName:'example/library',url:'https://github.com/example/library',description:'Linear algebra learning',topics:['math'],category:'math',stars:150,score:10,...overrides});
const catalog = items => ({schemaVersion:1,categories:[{id:'math',title:'Mathematics'}],items});

test('untrusted catalog cannot create executable or off-site repository links', () => {
  for (const url of ['javascript:alert(1)','https://github.com.evil.test/example/library','http://github.com/example/library','https://user:pass@github.com/example/library','https://github.com/example/library?redirect=bad','https://github.com/example/library#bad','https://github.com/different/project']) {
    assert.equal(safeRepositoryUrl(entry({url})), null, url);
  }
  assert.equal(safeRepositoryUrl(entry()), 'https://github.com/example/library');
  assert.equal(normalizeCatalog(catalog([entry({url:'javascript:alert(1)'}),entry()])).items.length,1);
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
  assert.match(statusSummary({status:'live',fetchedAt:'2026-11-14T00:00:00Z'}),/Published snapshot/);
  const normalized=normalizeCatalog(catalog([entry({stars:-1,score:NaN,fetchedAt:'invalid',topics:[null,'valid']})]));
  assert.equal(normalized.items[0].stars,null);
  assert.equal(normalized.items[0].fetchedAt,null);
  assert.deepEqual(normalized.items[0].topics,['valid']);
});

test('published explorer includes only the explicit public files, never cache/config', async t => {
  const root=await mkdtemp(join(tmpdir(),'resource-explorer-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'resources'));
  for(const file of publicResourceFiles) await writeFile(join(root,'resources',file), file==='catalog.json'?JSON.stringify(catalog([])):'public asset');
  await writeFile(join(root,'resources','sources.json'),'private collection configuration');
  await writeFile(join(root,'resources','.cache.json'),'private response cache');
  const output=join(root,'public','resources');
  await stageResourceExplorer(root,output);
  assert.deepEqual((await readdir(output)).sort(),[...publicResourceFiles].sort());
  assert.equal(JSON.parse(await readFile(join(output,'catalog.json'),'utf8')).schemaVersion,1);
});
