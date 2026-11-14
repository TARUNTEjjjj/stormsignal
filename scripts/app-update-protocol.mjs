// Shared source fragment for generated workers; readyExpression runs only in
// that worker's scope and must verify its own complete release cache.
export function workerUpdateProtocolSource({versionExpression = 'APP_VERSION', readyExpression = 'true', scopeExpression = 'self.registration.scope'} = {}) {
  return `(${installWorkerUpdateProtocol.toString()})({version: ${versionExpression}, scope: ${scopeExpression}, ready: async () => (${readyExpression})});`;
}
function installWorkerUpdateProtocol({version, scope, ready}) {
  const origin = new URL(scope).origin;
  const nonceValid = nonce => typeof nonce === 'string' && /^[a-f0-9]{32}$/.test(nonce);
  const safeClient = (client, nonce) => new Promise(resolve => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = safe => { if (settled) return; settled = true; clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(safe); };
    const timer = setTimeout(()=>finish(false),2000);
    channel.port1.onmessage = event => finish(event.data?.type === 'APP_UPDATE_SAFETY' && event.data.nonce === nonce && event.data.safe === true);
    try { client.postMessage({type:'APP_UPDATE_CAN_ACTIVATE',nonce,version},[channel.port2]); } catch { finish(false); }
  });
  self.addEventListener('message', event => {
    const port = event.ports?.[0], data = event.data;
    if (!port || !event.source?.id) return;
    let sourceURL; try { sourceURL = new URL(event.source.url); } catch { return; }
    if (sourceURL.origin !== origin) return;
    if (data?.type === 'GET_APP_UPDATE_STATUS') {
      event.waitUntil((async()=>{try{port.postMessage({type:'APP_UPDATE_STATUS',version,scope,ready:await ready()});}catch{port.postMessage({type:'APP_UPDATE_STATUS',version,scope,ready:false});}})());
      return;
    }
    if (data?.type !== 'ACTIVATE_APP_UPDATE' || data.version !== version || !nonceValid(data.nonce)) return;
    event.waitUntil((async()=>{
      let accepted = false;
      try {
        if (await ready()) {
          const windows = (await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(client=>new URL(client.url).origin===origin);
          const decisions = await Promise.all(windows.map(client=>safeClient(client,data.nonce)));
          const current = (await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(client=>new URL(client.url).origin===origin);
          accepted = windows.length > 0 && decisions.every(Boolean) && current.every(client=>windows.some(previous=>previous.id===client.id));
          if (accepted) await self.skipWaiting();
        }
      } catch {}
      port.postMessage({type:'APP_UPDATE_ACTIVATION',version,scope,nonce:data.nonce,accepted});
    })());
  });
}
