import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, readFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppRelease, readAppRelease, stampAppVersion, writeAppVersion} from './app-release.mjs';
const source = (path, bytes) => ({path,bytes});
const html = '<!doctype html><html><head><title>App</title></head><body>Saved library</body></html>';
test('release identity changes with application code, not catalog refreshes or source order', () => {
  const sources = [source('index.html', html),source('resources/catalog.json','{"items":[]}'),source('app.js','const version = 1;')];
  const first = createAppRelease({project:'test-app',sources});
  assert.deepEqual(first,createAppRelease({project:'test-app',sources:[sources[2],source('resources/catalog.json','{"items":[1]}'),sources[0]]}));
  assert.notEqual(first.version,createAppRelease({project:'test-app',sources:[sources[0],source('app.js','const version = 2;')]}).version);
});
test('stamping and rebuilding tracked HTML is idempotent without removing other release tags', () => {
  const original = html.replace('</head>','<meta name="existing-release" content="a"></head>');
  const release = createAppRelease({project:'test-app',sources:[source('index.html',original)]});
  const stamped = stampAppVersion(original,release);
  assert.equal(stampAppVersion(stamped,release),stamped);
  assert.deepEqual(createAppRelease({project:'test-app',sources:[source('index.html',stamped)]}),release);
  assert.equal((stamped.match(/name="app-version"/g)||[]).length,1);
  assert.match(stamped,/existing-release/);
});
test('real source trees have identical versions in different directories and reject symlink escapes',async t=>{
  const temp = await mkdtemp(join(tmpdir(),'app-release-')); t.after(()=>rm(temp,{recursive:true,force:true}));
  for(const name of ['a','b']) { await mkdir(join(temp,name,'resources'),{recursive:true});await writeFile(join(temp,name,'index.html'),html);await writeFile(join(temp,name,'resources/catalog.json'),JSON.stringify({time:name})); }
  const options={project:'test-app',sourcePaths:['index.html','resources']};
  assert.deepEqual(await readAppRelease(join(temp,'a'),options),await readAppRelease(join(temp,'b'),options));
  await symlink(join(temp,'b/index.html'),join(temp,'a/escape.html'));
  await assert.rejects(readAppRelease(join(temp,'a'),{...options,sourcePaths:['escape.html']}),/symbolic/);
  await assert.rejects(readAppRelease(join(temp,'a'),{...options,sourcePaths:['../b/index.html']}),/relative/);
});
test('published version describes only same-origin supported workers',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'app-version-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const release=createAppRelease({project:'test-app',sources:[source('index.html',html)]});
 const workers=[{scope:'/',script:'/sw.js'},{scope:'/resources/',script:'/resources/offline-worker.js'}];
 const result=await writeAppVersion(temp,release,{workers});
 assert.equal(result.workers[1].version,release.version);
 assert.deepEqual(JSON.parse(await readFile(join(temp,'app-version.json'),'utf8')),result);
 await assert.rejects(writeAppVersion(temp,release,{workers:[{scope:'/',script:'https://example.com/sw.js'}]}),/worker/);
 assert.throws(()=>createAppRelease({project:'test-app',sources:[source('index.html',html),source('index.html',html)]}),/duplicate/);
});
