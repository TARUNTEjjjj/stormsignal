import test from 'node:test';
import assert from 'node:assert/strict';
import {bindAppUpdateLifecycle,createAppUpdater} from '../resources/app-updates.mjs';
function target(properties={}){const listeners=new Map();return {...properties,listeners,addEventListener:(event,handler)=>listeners.set(event,handler),removeEventListener:event=>listeners.delete(event),emit(event,value={}){listeners.get(event)?.(value);}};}
function fixture(){let now=0;const state={lastChecked:0,status:'current'},checks=[];let starts=0,stops=0;
 const windowObject=target(),documentObject=target({visibilityState:'visible'}),serviceWorker=target();
 const updater={getState:()=>state,check:options=>{checks.push(options??{});state.lastChecked=now;},start:()=>{starts++;},stop:()=>{stops++;}};
 const dispose=bindAppUpdateLifecycle(updater,{windowObject,documentObject,serviceWorker,now:()=>now});
 return {windowObject,documentObject,serviceWorker,state,checks,dispose,advance:ms=>{now+=ms;},counts:()=>({starts,stops})};}
test('focus and visibility check fresh deployments with a one-minute resume throttle',()=>{
 const f=fixture();f.windowObject.emit('focus');assert.equal(f.checks.length,0);f.advance(60000);f.windowObject.emit('focus');assert.deepEqual(f.checks,[{force:true}]);f.windowObject.emit('focus');assert.equal(f.checks.length,1);f.documentObject.visibilityState='hidden';f.advance(60000);f.documentObject.emit('visibilitychange');assert.equal(f.checks.length,1);f.documentObject.visibilityState='visible';f.documentObject.emit('visibilitychange');assert.equal(f.checks.length,2);f.dispose();
});
test('reconnection and another window activating a worker check immediately',()=>{
 const f=fixture();f.windowObject.emit('online');f.serviceWorker.emit('controllerchange');assert.deepEqual(f.checks,[{force:true},{force:true}]);f.dispose();
});
test('an idle pending update retries without forcing another catalog-version download',()=>{
 const f=fixture();f.state.status='waiting-for-idle';f.windowObject.emit('focus');assert.deepEqual(f.checks,[{}]);f.dispose();
});
test('back-forward cache pauses and resumes updates without discarding page state',()=>{
 const f=fixture();f.windowObject.emit('pagehide',{persisted:true});assert.equal(f.counts().stops,1);f.windowObject.emit('pageshow',{persisted:true});assert.equal(f.counts().starts,1);f.dispose();assert.equal(f.windowObject.listeners.size,0);assert.equal(f.documentObject.listeners.size,0);assert.equal(f.serviceWorker.listeners.size,0);
});
test('lifecycle request bursts coalesce in the actual controller',async()=>{
 const A='a'.repeat(64);let finish,requests=0;const updater=createAppUpdater({baseline:{project:'test',version:A},loadVersion:()=>{requests++;return new Promise(resolve=>{finish=resolve;});},prepareWorkers:async()=>true,verifyPage:async()=>true,canReload:()=>true,reload:()=>assert.fail('No new version'),setTimer:()=>1,clearTimer:()=>{}});
 const windowObject=target(),documentObject=target({visibilityState:'visible'}),serviceWorker=target();const dispose=bindAppUpdateLifecycle(updater,{windowObject,documentObject,serviceWorker});
 const started=updater.start();windowObject.emit('online');windowObject.emit('focus');serviceWorker.emit('controllerchange');assert.equal(requests,1);finish({schemaVersion:1,project:'test',version:A,workers:[{scope:'/resources/',script:'/resources/offline-worker.js',version:A}]});await started;dispose();
});
test('failed resume checks are also throttled instead of retrying on every focus',async()=>{
 const A='a'.repeat(64);let now=0,requests=0;const updater=createAppUpdater({baseline:{project:'test',version:A},loadVersion:async()=>{requests++;throw Error('offline');},prepareWorkers:async()=>true,verifyPage:async()=>true,canReload:()=>true,reload:()=>assert.fail('Offline reload'),now:()=>now,setTimer:()=>1,clearTimer:()=>{}});
 const windowObject=target(),documentObject=target({visibilityState:'visible'});const dispose=bindAppUpdateLifecycle(updater,{windowObject,documentObject,now:()=>now});
 await updater.start();now=60000;windowObject.emit('focus');await new Promise(resolve=>setImmediate(resolve));const afterFirst=requests;windowObject.emit('focus');documentObject.emit('visibilitychange');await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,afterFirst);now+=60000;windowObject.emit('focus');await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,afterFirst+1);dispose();
});
