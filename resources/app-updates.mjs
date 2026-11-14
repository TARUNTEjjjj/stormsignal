export const APP_UPDATE_INTERVAL_MS = 15 * 60 * 1000;
const VERSION = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

export function normalizeAppVersion(value, project) {
  if (!value || value.schemaVersion !== 1 || value.project !== project || !VERSION.test(value.version) || !Array.isArray(value.workers) || value.workers.length > 2 || !value.workers.length) throw new Error('Invalid app version');
  const scopes = new Set();
  const workers = value.workers.map(worker=>{
    if (!worker || !['/','/resources/'].includes(worker.scope) || scopes.has(worker.scope) || !/^\/[a-zA-Z0-9/_-]+\.js$/.test(worker.script) || worker.script.startsWith('//') || worker.version !== value.version ||
      (worker.scope === '/resources/' && worker.script !== '/resources/offline-worker.js')) throw new Error('Invalid update worker');
    scopes.add(worker.scope); return {scope:worker.scope,script:worker.script,version:worker.version};
  });
  if (!scopes.has('/resources/')) throw new Error('Resource worker missing');
  return {schemaVersion:1,project,version:value.version,workers};
}

export async function fetchUpdateText(url, {fetchImpl = globalThis.fetch, maxBytes = 16384, timeoutMs = 6000, signal, accept = 'application/json'} = {}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>2*1024*1024||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new Error('Invalid update request limits');
  const abort = new AbortController(); let response, reader, timer, rejectCancelled;
  const cancel = () => { abort.abort(); try { reader?.cancel().catch(()=>{}); } catch {} try { response?.body?.cancel().catch(()=>{}); } catch {} };
  const cancelled = new Promise((_,reject)=>{rejectCancelled=reject;});
  const onAbort = () => { cancel(); rejectCancelled(new Error('Update check cancelled')); };
  signal?.addEventListener('abort',onAbort,{once:true});
  const transfer = (async()=>{
    if (signal?.aborted) throw new Error('Update check cancelled');
    response = await fetchImpl(url,{method:'GET',cache:'no-store',credentials:'omit',redirect:'error',headers:{Accept:accept},signal:abort.signal});
    abort.signal.throwIfAborted();
    if (!response.ok || response.redirected || !response.body) throw new Error('Update unavailable');
    const declared=Number(response.headers.get('Content-Length')); if (Number.isFinite(declared)&&declared>maxBytes) throw new Error('Update exceeds size limit');
    reader=response.body.getReader(); const chunks=[];let size=0;
    for(;;){const {done,value}=await reader.read();abort.signal.throwIfAborted();if(done)break;size+=value.byteLength;if(size>maxBytes)throw new Error('Update exceeds size limit');chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  })();
  try{return await Promise.race([transfer,cancelled,new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(new Error('Update check timed out'));},timeoutMs);})]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);cancel();try{reader?.releaseLock();}catch{}}
}

export function requestWorker(worker, message, {timeoutMs = 2500, channelFactory = () => new MessageChannel()} = {}) {
  return new Promise((resolve,reject)=>{
    const channel=channelFactory();let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);channel.port1.close();channel.port2.close();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Update worker did not respond')),timeoutMs);
    channel.port1.onmessage=event=>finish(null,event.data);
    try{worker.postMessage(message,[channel.port2]);}catch(error){finish(error);}
  });
}
const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map(byte=>byte.toString(16).padStart(2,'0')).join('');

export async function prepareAppWorkers(release, {serviceWorker = globalThis.navigator?.serviceWorker, origin = globalThis.location?.origin, canReload = () => true,
  request = requestWorker, timeoutMs = 15000, signal} = {}) {
  if (!serviceWorker || !canReload() || signal?.aborted) return false;
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Worker preparation timed out')),timeoutMs);})]);}finally{clearTimeout(timer);}};
  for (const expected of release.workers) {
    const scope=new URL(expected.scope,origin).href,script=new URL(expected.script,origin).href;
    const registration=await bounded(serviceWorker.getRegistration(scope));
    if(signal?.aborted)return false;
    if (!registration || registration.scope!==scope || [registration.active,registration.installing,registration.waiting].some(worker=>worker&&worker.scriptURL!==script)) return false;
    async function status(worker){
      if(!worker)return false;
      try{const state=await request(worker,{type:'GET_APP_UPDATE_STATUS'});return state?.type==='APP_UPDATE_STATUS'&&state.scope===scope&&state.version===expected.version&&state.ready===true;}catch{return false;}
    }
    if(await status(registration.active))continue;
    // A staged waiting worker is reused during idle retries, avoiding repeated
    // update downloads while another app window has unsaved work.
    if(!registration.waiting&&!registration.installing){try{await bounded(registration.update());}catch{return false;}}
    const deadline=Date.now()+timeoutMs;
    while(registration.installing&&Date.now()<deadline&&!signal?.aborted)await sleep(50);
    if(signal?.aborted)return false;
    if(await status(registration.active))continue;
    const waiting=registration.waiting;
    if(!waiting||!await status(waiting)||!canReload()||signal?.aborted)return false;
    const token=nonce();let answer;
    try{answer=await request(waiting,{type:'ACTIVATE_APP_UPDATE',version:expected.version,nonce:token},{timeoutMs:6000});}catch{return false;}
    if(answer?.type!=='APP_UPDATE_ACTIVATION'||answer.version!==expected.version||answer.scope!==scope||answer.nonce!==token||answer.accepted!==true)return false;
    while((registration.active!==waiting||waiting.state!=='activated')&&Date.now()<deadline&&!signal?.aborted)await sleep(50);
    if(registration.active!==waiting||!await status(waiting))return false;
  }
  return canReload()&&!signal?.aborted;
}

export function createReloadGuard({documentObject = globalThis.document, windowObject = globalThis.window, now = Date.now, idleMs = 10000} = {}) {
  let lastActivity=now();const initial=new WeakMap(),dirty=new Set();
  const editable=element=>!!element&&(element.isContentEditable||/^(TEXTAREA|INPUT|SELECT)$/.test(element.tagName));
  const value=element=>element.isContentEditable?element.textContent:/^(checkbox|radio)$/.test(element.type)?`${element.checked}:${element.value}`:
    element.type==='file'?[...element.files??[]].map(file=>`${file.name}:${file.size}:${file.lastModified}`).join('|'):
    element.multiple&&element.selectedOptions?[...element.selectedOptions].map(option=>option.value).join('\0'):element.value;
  const focused=event=>{if(editable(event.target)&&!initial.has(event.target))initial.set(event.target,value(event.target));};
  const activity=()=>{lastActivity=now();};
  const input=event=>{activity();const element=event.target;if(!editable(element))return;if(!initial.has(element))initial.set(element,/^(checkbox|radio)$/.test(element.type)?`${element.defaultChecked}:${element.value}`:element.defaultValue??'');
    if(value(element)===initial.get(element))dirty.delete(element);else dirty.add(element);};
  documentObject?.addEventListener('focusin',focused,true);
  for(const event of ['pointerdown','keydown'])documentObject?.addEventListener(event,activity,true);
  documentObject?.addEventListener('input',input,true);documentObject?.addEventListener('change',input,true);
  const canReload=()=>{
    if(now()-lastActivity<idleMs||editable(documentObject?.activeElement))return false;
    for(const element of dirty){if(!element.isConnected||value(element)===initial.get(element))dirty.delete(element);else return false;}
    if([...documentObject?.querySelectorAll?.('dialog[open], [role="dialog"][aria-modal="true"]')??[]].some(element=>!element.hidden&&element.getClientRects().length))return false;
    try{if(typeof windowObject?.appUpdateCanReload==='function'&&windowObject.appUpdateCanReload()!==true)return false;}catch{return false;}
    return true;
  };
  return {canReload,dispose(){documentObject?.removeEventListener('focusin',focused,true);for(const event of ['pointerdown','keydown'])documentObject?.removeEventListener(event,activity,true);documentObject?.removeEventListener('input',input,true);documentObject?.removeEventListener('change',input,true);}};
}

export function createAppUpdater({baseline, loadVersion, prepareWorkers, verifyPage, canReload, reload, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = APP_UPDATE_INTERVAL_MS, retryMs = 30000, onState = () => {}}) {
  if(!baseline||!VERSION.test(baseline.version)||!baseline.project)throw new Error('Missing published app baseline');
  let running=false,timer,active,generation=0,nextPoll=0,candidate,reloaded=false;
  let state={currentVersion:baseline.version,availableVersion:null,status:'idle',lastChecked:null,nextCheck:null};
  const emit=patch=>{state={...state,...patch};onState({...state});};
  const schedule=()=>{clearTimer(timer);if(!running||reloaded)return;const delay=Math.max(1,Math.min(Math.max(0,nextPoll-now()),candidate?retryMs:intervalMs));timer=setTimer(()=>{void check();},delay);emit({nextCheck:now()+delay});};
  function check({force=false}={}) {
    if(!running||reloaded)return Promise.resolve({...state});if(active)return active.promise;
    const id=generation,abort=new AbortController(),request={abort,promise:null};active=request;
    const valid=()=>running&&id===generation&&!abort.signal.aborted;
    request.promise=(async()=>{
      try{
        if(force||!candidate||now()>=nextPoll){
          emit({status:'checking'});
          const incoming=normalizeAppVersion(await loadVersion({signal:abort.signal}),baseline.project);
          if(!valid())return state;
          candidate=incoming;nextPoll=now()+intervalMs;emit({availableVersion:incoming.version,lastChecked:now()});
        }
        if(!candidate)return state;
        if(!canReload()){emit({status:'waiting-for-idle'});return state;}
        emit({status:'preparing'});
        if(!await prepareWorkers(candidate,{canReload,signal:abort.signal})||!valid()){if(valid())emit({status:'waiting-for-workers'});return state;}
        if(candidate.version===baseline.version){candidate=undefined;emit({status:'current'});return state;}
        if(!canReload()){emit({status:'waiting-for-idle'});return state;}
        if(!await verifyPage(candidate,{signal:abort.signal})||!valid()){if(valid())emit({status:'waiting-for-deployment'});return state;}
        if(!canReload()){emit({status:'waiting-for-idle'});return state;}
        reloaded=true;emit({status:'reloading'});reload(candidate.version);
      }catch{if(valid()){nextPoll=now()+intervalMs;emit({status:'unavailable'});}}
      finally{if(valid()&&active===request){active=undefined;schedule();}}
      return {...state};
    })();return request.promise;
  }
  return {start(){if(running)return active?.promise??Promise.resolve({...state});running=true;generation++;return check({force:true});},
    check,stop(){running=false;generation++;clearTimer(timer);active?.abort.abort();active=undefined;},getState:()=>({...state})};
}

/** Resume checks are bounded so focus events cannot create a request storm. */
export function bindAppUpdateLifecycle(updater, {windowObject = globalThis.window,
  documentObject = globalThis.document, serviceWorker = globalThis.navigator?.serviceWorker,
  now = Date.now, resumeIntervalMs = 60000} = {}) {
  const pending = new Set(['waiting-for-idle','waiting-for-workers','waiting-for-deployment']);
  let lastResumeAttempt=-Infinity;
  const due = () => {
    if(documentObject?.visibilityState === 'hidden') return;
    const state=updater.getState();
    const elapsed=state.lastChecked===null ? Infinity : now()-state.lastChecked;
    const sinceAttempt=now()-lastResumeAttempt;
    if((elapsed >= resumeIntervalMs || elapsed < 0) && (sinceAttempt >= resumeIntervalMs || sinceAttempt < 0)) {
      lastResumeAttempt=now();void updater.check({force:true});
    } else if(pending.has(state.status)) void updater.check();
  };
  const online = () => { lastResumeAttempt=now();void updater.check({force:true}); };
  const visible = () => { if(documentObject?.visibilityState === 'visible') due(); };
  const resume = () => { void updater.start(); due(); };
  const pause = () => updater.stop();
  windowObject?.addEventListener('focus',due);
  windowObject?.addEventListener('online',online);
  windowObject?.addEventListener('pageshow',resume);
  windowObject?.addEventListener('pagehide',pause);
  documentObject?.addEventListener('visibilitychange',visible);
  serviceWorker?.addEventListener('controllerchange',online);
  return () => {
    windowObject?.removeEventListener('focus',due);
    windowObject?.removeEventListener('online',online);
    windowObject?.removeEventListener('pageshow',resume);
    windowObject?.removeEventListener('pagehide',pause);
    documentObject?.removeEventListener('visibilitychange',visible);
    serviceWorker?.removeEventListener('controllerchange',online);
    updater.stop();
  };
}

export function startAppUpdates({windowObject = globalThis.window, documentObject = globalThis.document, navigatorObject = globalThis.navigator} = {}) {
  if(!documentObject||windowObject.__appUpdater)return windowObject?.__appUpdater;
  const baseline={version:documentObject.querySelector('meta[name="app-version"]')?.content,project:documentObject.querySelector('meta[name="app-project"]')?.content};
  if(!VERSION.test(baseline.version??'')||!baseline.project)return null;
  const guard=createReloadGuard({windowObject,documentObject});
  const updater=createAppUpdater({baseline,canReload:guard.canReload,
    loadVersion:async({signal})=>JSON.parse(await fetchUpdateText(new URL('/app-version.json',windowObject.location.origin),{signal})),
    prepareWorkers:(release,{canReload,signal})=>prepareAppWorkers(release,{serviceWorker:navigatorObject.serviceWorker,origin:windowObject.location.origin,canReload,signal}),
    verifyPage:async(release,{signal})=>{
      const url=new URL(windowObject.location.href);url.searchParams.set('__app_update_check',release.version);
      const html=await fetchUpdateText(url,{signal,maxBytes:2*1024*1024,accept:'text/html'});
      const parsed=new DOMParser().parseFromString(html,'text/html');
      return parsed.querySelector('meta[name="app-version"]')?.content===release.version&&parsed.querySelector('meta[name="app-project"]')?.content===baseline.project;
    },
    reload:version=>{
      const key=`app-update-reload:${baseline.project}`;
      try{if(windowObject.sessionStorage.getItem(key)===version)return;windowObject.sessionStorage.setItem(key,version);}catch{}
      windowObject.location.reload();
    },
    onState:state=>{windowObject.__appUpdateState=state;},
  });
  const safety=event=>{
    if(event.data?.type!=='APP_UPDATE_CAN_ACTIVATE'||!NONCE.test(event.data.nonce??'')||!event.ports?.[0])return;
    if(event.origin&&event.origin!==windowObject.location.origin)return;
    event.ports[0].postMessage({type:'APP_UPDATE_SAFETY',nonce:event.data.nonce,safe:guard.canReload()});
  };
  navigatorObject.serviceWorker?.addEventListener('message',safety);
  const unbindLifecycle=bindAppUpdateLifecycle(updater,{windowObject,documentObject,serviceWorker:navigatorObject.serviceWorker});
  windowObject.addEventListener('pagehide',event=>{if(!event.persisted){unbindLifecycle();guard.dispose();navigatorObject.serviceWorker?.removeEventListener('message',safety);}});
  windowObject.__appUpdater=updater;void updater.start();return updater;
}
