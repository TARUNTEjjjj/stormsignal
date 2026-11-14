import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
import {workerUpdateProtocolSource} from './app-update-protocol.mjs';

const version='a'.repeat(64),nonce='b'.repeat(32),scope='https://app.example/resources/';
function fixture({ready=true,clients=[],appearingClient=false}={}) {
  let handler,skips=0,reads=0;
  const context={URL,MessageChannel,clearTimeout,setTimeout:fn=>setTimeout(fn,15),APP_VERSION:version,
    complete:()=>ready,
    self:{registration:{scope},addEventListener:(_name,fn)=>{handler=fn;},skipWaiting:async()=>{skips++;},clients:{matchAll:async()=>++reads>1&&appearingClient?[...clients,{id:'new',url:'https://app.example/new'}]:clients}}};
  vm.runInNewContext(workerUpdateProtocolSource({readyExpression:'complete()'}),context);
  return {get skips(){return skips;},async message(data,{url='https://app.example/',id='sender'}={}) {
    let waiting,result;
    handler({source:{id,url},data,ports:[{postMessage:value=>{result=value;}}],waitUntil:value=>{waiting=value;}});
    await waiting;return result;
  }};
}
const client=(id,safe=true,respond=true)=>({id,url:'https://app.example/',postMessage(message,ports){if(respond)ports[0].postMessage({type:'APP_UPDATE_SAFETY',nonce:message.nonce,safe});}});
const activate={type:'ACTIVATE_APP_UPDATE',version,nonce};

test('worker status identifies its exact release, scope and verified cache readiness',async()=>{
  const app=fixture({ready:false});const result=await app.message({type:'GET_APP_UPDATE_STATUS'});
  assert.equal(result.type,'APP_UPDATE_STATUS');assert.equal(result.version,version);assert.equal(result.scope,scope);assert.equal(result.ready,false);
});
test('activation requires a prepared cache and unanimous safe clients',async()=>{
  for(const options of [{ready:false,clients:[client('a')]},{clients:[client('a'),client('b',false)]},{clients:[]}]){
    const app=fixture(options);assert.equal((await app.message(activate)).accepted,false);assert.equal(app.skips,0);
  }
  const app=fixture({clients:[client('a'),client('b')]});assert.equal((await app.message(activate)).accepted,true);assert.equal(app.skips,1);
});
test('legacy or newly opened clients defer activation until every window can participate',async()=>{
  for(const options of [{clients:[client('legacy',true,false)]},{clients:[client('a')],appearingClient:true}]){
    const app=fixture(options);assert.equal((await app.message(activate)).accepted,false);assert.equal(app.skips,0);
  }
});
test('wrong version, nonce or sender origin cannot trigger activation',async()=>{
  const app=fixture({clients:[client('a')]});
  assert.equal(await app.message({...activate,version:'c'.repeat(64)}),undefined);
  assert.equal(await app.message({...activate,nonce:'invalid'}),undefined);
  assert.equal(await app.message(activate,{url:'https://another.example/'}),undefined);
  assert.equal(await app.message(activate,{id:''}),undefined);
  assert.equal(app.skips,0);
});
