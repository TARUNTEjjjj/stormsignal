import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppUpdater,normalizeAppVersion,fetchUpdateText,createReloadGuard,prepareAppWorkers} from '../resources/app-updates.mjs';
const A='a'.repeat(64),B='b'.repeat(64);
const release=version=>({schemaVersion:1,project:'test-app',version,workers:[{scope:'/',script:'/sw.js',version},{scope:'/resources/',script:'/resources/offline-worker.js',version}]});
function fixture(overrides={}) {
 let now=0,id=0;const timers=new Map(),loads=[],prepares=[],pages=[],reloads=[],states=[];
 const options={baseline:release(A),loadVersion:async()=>{loads.push(now);return release(B);},prepareWorkers:async value=>{prepares.push(value.version);return true;},verifyPage:async value=>{pages.push(value.version);return true;},canReload:()=>true,reload:version=>reloads.push(version),now:()=>now,setTimer:(run,delay)=>{timers.set(++id,{run,delay});return id;},clearTimer:key=>timers.delete(key),onState:state=>states.push(state),...overrides};
 const updater=createAppUpdater(options);
 return {updater,timers,loads,prepares,pages,reloads,states,clock:()=>now,advance(ms){now+=ms;},async runTimer(){const [key,timer]=timers.entries().next().value;timers.delete(key);now+=timer.delay;timer.run();await updater.check();}};
}
// Registrations for the root and library workers. The root already runs release B; the library runs A.
// update() starts a complete new install, as in a browser: after host.installMs on host.clock it fails
// (nothing left installing or waiting) or stages a ready worker. Workers answer the update protocol
// like the generated worker code.
function workerHost() {
 const origin='https://app.test',host={origin,fails:true,refuse:false,staged:B,updates:[],activations:0,installMs:0,clock:()=>0};
 const worker=(registration,version,state='installed')=>({scope:registration.scope,scriptURL:registration.script,version,state});
 const registration=(path,script,version)=>{let installing=null,waiting=null,until=0;
  const settle=()=>{if(installing&&host.clock()>=until){if(!host.fails)waiting=Object.assign(installing,{state:'installed'});installing=null;}};
  const value={scope:origin+path,script:origin+script,get installing(){settle();return installing;},get waiting(){settle();return waiting;},set waiting(next){waiting=next;},
   async update(){host.updates.push(path);installing=worker(value,host.staged,'installing');until=host.clock()+host.installMs;}};
  value.active=worker(value,version,'activated');return value;};
 const registrations=[registration('/','/sw.js',B),registration('/resources/','/resources/offline-worker.js',A)];
 host.serviceWorker={getRegistration:async scope=>registrations.find(value=>value.scope===scope)};
 host.request=async(target,message)=>{
  if(message.type==='GET_APP_UPDATE_STATUS')return {type:'APP_UPDATE_STATUS',scope:target.scope,version:target.version,ready:true};
  host.activations++;const owner=registrations.find(value=>value.waiting===target);
  if(!host.refuse){owner.active=target;owner.waiting=null;target.state='activated';}
  return {type:'APP_UPDATE_ACTIVATION',version:message.version,scope:target.scope,nonce:message.nonce,accepted:!host.refuse};
 };
 return host;
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
test('reload guard treats scrolling and pointer movement as recent interaction',()=>{
 let now=0;const listeners=new Map(),options=new Map();
 const doc={activeElement:null,addEventListener:(name,fn,option)=>{listeners.set(name,fn);options.set(name,option);},removeEventListener:name=>listeners.delete(name),querySelectorAll:()=>[]};
 const guard=createReloadGuard({documentObject:doc,windowObject:{},now:()=>now,idleMs:10});
 for(const name of ['wheel','scroll','pointermove','touchmove']){
  now+=20;assert.equal(guard.canReload(),true,`${name}: idle before the event`);
  assert.equal(typeof listeners.get(name),'function',`${name} is not observed as activity`);
  listeners.get(name)({});assert.equal(guard.canReload(),false,`${name} must defer the reload`);
 }
 for(const name of ['wheel','touchmove'])assert.deepEqual(options.get(name),{capture:true,passive:true},`${name} must not block scrolling`);
 now+=20;assert.equal(guard.canReload(),true);
 guard.dispose();assert.equal(listeners.size,0);
});
test('view controls marked data-update-safe never hold back an update; unmarked controls stay protected',()=>{
 let now=0;const listeners=new Map();const doc={activeElement:null,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:()=>{},querySelectorAll:()=>[]};
 const guard=createReloadGuard({documentObject:doc,windowObject:{},now:()=>now,idleMs:10});
 // closest() as in the DOM: the control or an ancestor carries the attribute.
 const control=(tagName,type,marked)=>({tagName,type,value:'0',defaultValue:'0',isConnected:true,closest:selector=>marked&&selector.includes('[data-update-safe]')?{}:null});
 const hour=control('INPUT','range',true),layer=control('SELECT',undefined,true),answer=control('SELECT',undefined,false);
 for(const element of [hour,layer,answer]){listeners.get('focusin')({target:element});element.value='5';listeners.get('change')({target:element});}
 doc.activeElement=hour;now=24*60*60*1000;
 assert.equal(guard.canReload(),false,'an unmarked select still holds an unsaved choice');
 answer.value='0';assert.equal(guard.canReload(),true,'a moved hour slider or map layer is view state, even while focused');
 doc.activeElement=answer;assert.equal(guard.canReload(),false,'a focused unmarked control is still protected');
 guard.dispose();
});
test('a persistently failing worker install is retried with backoff, not reinstalled every 30 s',async()=>{
 const host=workerHost();let f;
 f=fixture({prepareWorkers:(value,options)=>prepareAppWorkers(value,{...options,serviceWorker:host.serviceWorker,origin:host.origin,request:host.request,now:()=>f.clock()})});
 await f.updater.start();
 while(f.clock()<60*60*1000)await f.runTimer();
 assert.equal(f.updater.getState().status,'waiting-for-workers');assert.deepEqual(f.reloads,[]);
 assert.ok(host.updates.length>=5&&host.updates.length<=8,`${host.updates.length} complete reinstalls of the library worker in one hour`);
 assert.ok(host.updates.every(path=>path==='/resources/'),'the root worker was already current');
 host.fails=false;const recovering=f.clock();
 while(!f.reloads.length&&f.clock()-recovering<=15*60*1000)await f.runTimer();
 assert.deepEqual(f.reloads,[B],'the next allowed attempt installs and applies the release');
});
test('an install still running when the wait for it ends, and failing later, is backed off too',async()=>{
 // On a very slow link the install outlives the wait (here it ends at once) and fails after 20 or 90 s.
 for(const installMs of [20000,90000]){
  const host=workerHost();let f;host.installMs=installMs;
  f=fixture({prepareWorkers:(value,options)=>prepareAppWorkers(value,{...options,serviceWorker:host.serviceWorker,origin:host.origin,request:host.request,now:()=>f.clock(),timeoutMs:0})});
  host.clock=()=>f.clock();
  await f.updater.start();
  while(f.clock()<60*60*1000)await f.runTimer();
  assert.equal(f.updater.getState().status,'waiting-for-workers');assert.deepEqual(f.reloads,[]);
  assert.ok(host.updates.length>=5&&host.updates.length<=8,`${host.updates.length} complete reinstalls in one hour when each install fails after ${installMs/1000} s`);
  host.fails=false;const recovering=f.clock();
  while(!f.reloads.length&&f.clock()-recovering<=20*60*1000)await f.runTimer();
  assert.deepEqual(f.reloads,[B],`a ${installMs/1000} s install that succeeds is still applied`);
 }
});
test('a new release is installed at once, and a staged worker awaiting consent is asked again without a reinstall',async()=>{
 const host=workerHost();let now=0;
 const prepare=value=>prepareAppWorkers(value,{serviceWorker:host.serviceWorker,origin:host.origin,request:host.request,now:()=>now});
 assert.equal(await prepare(release(B)),false);now+=30000;assert.equal(await prepare(release(B)),false);
 assert.deepEqual(host.updates,['/resources/'],'a failed install is not repeated on the next idle retry');
 const C='c'.repeat(64);host.staged=C;
 assert.equal(await prepare(release(C)),false);assert.deepEqual(host.updates,['/resources/','/'],'release C is tried at once in the root scope, which has no failed install of its own');
 host.fails=false;host.refuse=true;now+=60000;
 for(let attempt=0;attempt<3;attempt++){assert.equal(await prepare(release(C)),false);now+=30000;}
 assert.deepEqual(host.updates,['/resources/','/','/'],'the staged worker is reused');assert.equal(host.activations,3,'its activation is requested on every retry');
 host.refuse=false;assert.equal(await prepare(release(C)),true);assert.deepEqual(host.updates,['/resources/','/','/','/resources/']);
});
test('a newer release skips the backoff left by the failed install of the previous one in the same scope',async()=>{
 const host=workerHost();let now=0;
 const library=version=>({...release(version),workers:release(version).workers.filter(worker=>worker.scope==='/resources/')});
 const prepare=value=>prepareAppWorkers(value,{serviceWorker:host.serviceWorker,origin:host.origin,request:host.request,now:()=>now});
 assert.equal(await prepare(library(B)),false);now+=30000;assert.equal(await prepare(library(B)),false);
 assert.deepEqual(host.updates,['/resources/'],'release B is backed off after its failed install');
 const C='c'.repeat(64);host.staged=C;
 assert.equal(await prepare(library(C)),false);assert.deepEqual(host.updates,['/resources/','/resources/'],'release C is installed while B is still backed off');
});
test('the install backoff stops growing at the 15-minute check interval',async()=>{
 const host=workerHost();let f;const times=[];
 f=fixture({prepareWorkers:(value,options)=>prepareAppWorkers(value,{...options,serviceWorker:host.serviceWorker,origin:host.origin,request:host.request,now:()=>f.clock()})});
 const library=await host.serviceWorker.getRegistration(`${host.origin}/resources/`),update=library.update;
 library.update=()=>{times.push(f.clock());return update();};
 await f.updater.start();
 while(f.clock()<4*60*60*1000)await f.runTimer();
 // A reinstall is due at most 15 minutes after the last one, and runs at the next 30 s retry.
 const gaps=times.slice(1).map((time,index)=>(time-times[index])/60000);
 assert.ok(gaps.length>=10&&Math.max(...gaps)<=15.5,`minutes between reinstalls over four hours: ${gaps.join(', ')}`);
});
