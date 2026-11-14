import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppUpdater,normalizeAppVersion,fetchUpdateText,createReloadGuard} from '../resources/app-updates.mjs';
const A='a'.repeat(64),B='b'.repeat(64);
const release=version=>({schemaVersion:1,project:'test-app',version,workers:[{scope:'/',script:'/sw.js',version},{scope:'/resources/',script:'/resources/offline-worker.js',version}]});
function fixture(overrides={}) {
 let now=0,id=0;const timers=new Map(),loads=[],prepares=[],pages=[],reloads=[],states=[];
 const options={baseline:release(A),loadVersion:async()=>{loads.push(now);return release(B);},prepareWorkers:async value=>{prepares.push(value.version);return true;},verifyPage:async value=>{pages.push(value.version);return true;},canReload:()=>true,reload:version=>reloads.push(version),now:()=>now,setTimer:(run,delay)=>{timers.set(++id,{run,delay});return id;},clearTimer:key=>timers.delete(key),onState:state=>states.push(state),...overrides};
 const updater=createAppUpdater(options);
 return {updater,timers,loads,prepares,pages,reloads,states,advance(ms){now+=ms;},async runTimer(){const [key,timer]=timers.entries().next().value;timers.delete(key);now+=timer.delay;timer.run();await updater.check();}};
}
test('a verified new release reloads exactly once after preparing workers and matching HTML',async()=>{
 const f=fixture();await f.updater.start();await f.updater.check();assert.deepEqual(f.prepares,[B]);assert.deepEqual(f.pages,[B]);assert.deepEqual(f.reloads,[B]);assert.equal(f.timers.size,0);assert.equal(f.updater.getState().status,'reloading');
});
test('an unchanged release schedules the next normal check without reloading',async()=>{
 const f=fixture({loadVersion:async()=>release(A)});await f.updater.start();assert.equal(f.updater.getState().status,'current');assert.deepEqual(f.reloads,[]);assert.equal([...f.timers.values()][0].delay,15*60*1000);await f.runTimer();assert.deepEqual(f.reloads,[]);
});
test('active work defers updates and reuses the staged candidate when work ends',async()=>{
 let safe=false;const f=fixture({canReload:()=>safe});await f.updater.start();assert.equal(f.updater.getState().status,'waiting-for-idle');assert.deepEqual(f.prepares,[]);assert.deepEqual(f.reloads,[]);safe=true;await f.runTimer();assert.equal(f.loads.length,1);assert.deepEqual(f.reloads,[B]);
});
test('failed worker preparation and mixed deployment HTML retain the current document',async()=>{
 let ready=false,pageReady=false;const f=fixture({prepareWorkers:async()=>ready,verifyPage:async()=>pageReady});await f.updater.start();assert.equal(f.updater.getState().status,'waiting-for-workers');assert.deepEqual(f.reloads,[]);ready=true;await f.runTimer();assert.equal(f.updater.getState().status,'waiting-for-deployment');assert.deepEqual(f.reloads,[]);pageReady=true;await f.runTimer();assert.deepEqual(f.reloads,[B]);
});
test('network failure is quiet, retains the running release, and retries later',async()=>{
 const f=fixture({loadVersion:async()=>{throw Error('offline');}});await f.updater.start();assert.equal(f.updater.getState().status,'unavailable');assert.equal(f.updater.getState().currentVersion,A);assert.deepEqual(f.reloads,[]);assert.equal([...f.timers.values()][0].delay,15*60*1000);
});
test('concurrent checks share one request and a stopped updater cannot reload',async()=>{
 let finish,signal;const f=fixture({loadVersion:({signal:s})=>{signal=s;return new Promise(resolve=>{finish=resolve;});}});
 const started=f.updater.start(),concurrent=f.updater.check();assert.equal(started,concurrent);f.updater.stop();assert.equal(signal.aborted,true);finish(release(B));await started;assert.deepEqual(f.prepares,[]);assert.deepEqual(f.reloads,[]);assert.equal(f.timers.size,0);
});
test('safety is rechecked after asynchronous preparation and page verification',async()=>{
 let safe=true;const f=fixture({canReload:()=>safe,verifyPage:async()=>{safe=false;return true;}});await f.updater.start();assert.equal(f.updater.getState().status,'waiting-for-idle');assert.deepEqual(f.reloads,[]);
});
test('invalid remote project, version and worker locations cannot activate workers',()=>{
 assert.throws(()=>normalizeAppVersion(release(B),'other-app'));
 for(const bad of [{...release(B),version:'new'}, {...release(B),workers:[{scope:'/',script:'https://attacker.test/sw.js',version:B}]}, {...release(B),workers:[{scope:'/resources/',script:'/other.js',version:B}]}, {...release(B),workers:[...release(B).workers,release(B).workers[0]]}])assert.throws(()=>normalizeAppVersion(bad,'test-app'));
});
test('version requests bypass HTTP caches and bound response bodies',async()=>{
 let init;const text=await fetchUpdateText('https://app.test/app-version.json',{fetchImpl:async(url,options)=>{init=options;return new Response('{"ok":true}');}});assert.equal(text,'{"ok":true}');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
 await assert.rejects(fetchUpdateText('https://app.test/app-version.json',{maxBytes:8,fetchImpl:async()=>new Response('x'.repeat(9))}),/size limit/);
 await assert.rejects(fetchUpdateText('https://app.test/app-version.json',{timeoutMs:10,fetchImpl:()=>new Promise(()=>{})}),/timed out/);
});
test('reload guard protects edits, dialogs, app-specific work and recent interaction',()=>{
 let now=0,modal=false,appSafe=true;const listeners=new Map();const doc={activeElement:null,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),querySelectorAll:()=>modal?[{hidden:false,getClientRects:()=>[1]}]:[]};
 const guard=createReloadGuard({documentObject:doc,windowObject:{appUpdateCanReload:()=>appSafe},now:()=>now,idleMs:10});assert.equal(guard.canReload(),false);now=20;assert.equal(guard.canReload(),true);
 const field={tagName:'TEXTAREA',value:'old',defaultValue:'old',isConnected:true};listeners.get('focusin')({target:field});field.value='draft';listeners.get('input')({target:field});now=40;assert.equal(guard.canReload(),false);field.value='old';assert.equal(guard.canReload(),true);modal=true;assert.equal(guard.canReload(),false);modal=false;appSafe=false;assert.equal(guard.canReload(),false);appSafe=true;doc.activeElement=field;assert.equal(guard.canReload(),false);doc.activeElement=null;listeners.get('keydown')({});assert.equal(guard.canReload(),false);now=60;assert.equal(guard.canReload(),true);guard.dispose();assert.equal(listeners.size,0);
});
test('checkbox and radio edits remain protected after focus leaves the control',()=>{
 for(const type of ['checkbox','radio']) {
  let now=0;const listeners=new Map();const doc={activeElement:null,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:()=>{},querySelectorAll:()=>[]};
  const guard=createReloadGuard({documentObject:doc,windowObject:{},now:()=>now,idleMs:10});
  const input={tagName:'INPUT',type,value:'answer',checked:false,defaultChecked:false,isConnected:true};
  listeners.get('focusin')({target:input});input.checked=true;listeners.get('change')({target:input});now=20;assert.equal(guard.canReload(),false,type);input.checked=false;assert.equal(guard.canReload(),true,type);guard.dispose();
 }
});
