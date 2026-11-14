export const RESOURCE_SCOPE = '/resources/';
export const RESOURCE_WORKER = '/resources/offline-worker.js';

/** Register only the library scope, including when called from the main app. */
export async function ensureOfflineShell({serviceWorker = globalThis.navigator?.serviceWorker,
  origin = globalThis.location?.origin, channelFactory = () => new MessageChannel(), timeoutMs = 15000} = {}) {
  if (!serviceWorker || !origin || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    return {available: false, reason: 'Offline page storage is not available in this browser.'};
  }
  const scope = new URL(RESOURCE_SCOPE, origin).href;
  const script = new URL(RESOURCE_WORKER, origin).href;
  const controller = new AbortController();
  let timer;
  const abortable = promise => Promise.race([promise, new Promise((_, reject) => {
    if (controller.signal.aborted) reject(new Error('Offline page preparation timed out'));
    else controller.signal.addEventListener('abort', () => reject(new Error('Offline page preparation timed out')), {once: true});
  })]);
  try {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const registration = await abortable(serviceWorker.register(script, {scope: RESOURCE_SCOPE, updateViaCache: 'none'}));
    if (registration.scope !== scope) throw new Error('Unexpected offline page scope');
    const active = await abortable(new Promise((resolve, reject) => {
      const watched = new Set();
      const cleanup = () => {
        registration.removeEventListener?.('updatefound', check);
        controller.signal.removeEventListener('abort', aborted);
        for (const worker of watched) worker.removeEventListener('statechange', check);
      };
      const aborted = () => { cleanup(); reject(new Error('Offline preparation timed out')); };
      function check() {
        const worker = registration.active;
        if (worker?.state === 'activated') { cleanup(); resolve(worker); return; }
        for (const pending of [registration.installing, registration.waiting, worker]) {
          if (pending && !watched.has(pending)) { watched.add(pending); pending.addEventListener('statechange', check); }
        }
        if (watched.size && [...watched].every(worker => worker.state === 'redundant')) { cleanup(); reject(new Error('Offline page could not be installed')); }
      }
      registration.addEventListener?.('updatefound', check);
      controller.signal.addEventListener('abort', aborted, {once: true});
      check();
    }));
    if (active.scriptURL !== script) throw new Error('Unexpected offline worker');
    const status = await abortable(new Promise((resolve, reject) => {
      const channel = channelFactory();
      const cleanup = () => { controller.signal.removeEventListener('abort', aborted); channel.port1.close(); channel.port2.close(); };
      const aborted = () => { cleanup(); reject(new Error('Offline status timed out')); };
      controller.signal.addEventListener('abort', aborted, {once: true});
      channel.port1.onmessage = event => { cleanup(); resolve(event.data); };
      try { active.postMessage({type: 'RESOURCE_SHELL_STATUS'}, [channel.port2]); }
      catch (error) { cleanup(); reject(error); }
    }));
    if (status?.type !== 'RESOURCE_SHELL_STATUS' || status.scope !== scope || !status.ready || typeof status.version !== 'string') {
      return {available: false, reason: 'The resource page is not fully saved for offline reopening yet.'};
    }
    return {available: true, version: status.version, scope};
  } catch {
    return {available: false, reason: 'The resource page could not be saved for offline reopening. Reconnect and try again.'};
  } finally { clearTimeout(timer); controller.abort(); }
}
