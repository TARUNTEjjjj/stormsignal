import {normalizeCatalog, catalogJSON, isOlderCatalog, loadRemoteCatalog, loadBundledCatalog} from './catalog.mjs';
import {createCatalogStore} from './storage.mjs';

export const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const sameCatalog = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

export function createCatalogController({store = createCatalogStore(), fetchRemote = loadRemoteCatalog,
  fetchBundled = loadBundledCatalog, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  intervalMs = REFRESH_INTERVAL_MS, onChange = () => {}} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 24 * 60 * 60 * 1000) throw new Error('Invalid refresh interval');
  let state = {catalog: null, source: null, refreshing: false, lastSuccessfulCheck: null,
    lastAttemptCompleted: null, nextCheckAt: null, savedOffline: false, storageError: false, error: null, retainedNewer: false};
  let running = false, initialized = false, initializing, startupAbort, active, timer, generation = 0, unsubscribe;
  const getState = () => ({...state});
  const emit = patch => { state = {...state, ...patch}; onChange(getState()); };
  const valid = (id, signal) => running && generation === id && !signal?.aborted;
  const normalized = value => JSON.parse(catalogJSON(normalizeCatalog(value)));
  function schedule(delay = intervalMs) {
    clearTimer(timer); timer = undefined;
    if (!running) return;
    timer = setTimer(() => { timer = undefined; void refresh(); }, Math.max(0, delay));
  }
  async function reconcileSaved() {
    const id = generation;
    try {
      const value = await store.load();
      if (!valid(id) || !value) return getState();
      const catalog = normalized(value);
      if (!state.catalog || isOlderCatalog(state.catalog, catalog)) emit({catalog, source: 'saved', savedOffline: true, storageError: false});
      else if (sameCatalog(catalog, state.catalog)) emit({savedOffline: true, storageError: false});
    } catch { if (valid(id)) emit({storageError: true}); }
    return getState();
  }
  function refresh() {
    if (!running) return Promise.resolve(getState());
    if (!initialized && initializing) return initializing;
    if (active) return active.promise;
    clearTimer(timer); timer = undefined;
    const id = generation, abort = new AbortController(), request = {abort, promise: null};
    active = request;
    emit({refreshing: true, error: null, retainedNewer: false, nextCheckAt: null});
    request.promise = (async () => {
      try {
        const incoming = normalized(await fetchRemote({signal: abort.signal}));
        if (!valid(id, abort.signal)) return getState();
        const retainedNewer = isOlderCatalog(incoming, state.catalog);
        let catalog = retainedNewer ? state.catalog : incoming;
        let source = retainedNewer ? state.source : 'github';
        let savedOffline = retainedNewer ? state.savedOffline : sameCatalog(catalog, state.catalog) && state.savedOffline;
        let storageError = false;
        try {
          const saved = await store.save(catalog, {signal: abort.signal});
          if (!valid(id, abort.signal)) return getState();
          const stored = normalized(saved.catalog);
          // A concurrent tab can have saved a newer collection while this
          // request was in flight. Its transaction result takes precedence.
          if (isOlderCatalog(catalog, stored)) { catalog = stored; source = 'saved'; }
          savedOffline = saved.saved === true && sameCatalog(catalog, stored);
        } catch { storageError = true; }
        if (!valid(id, abort.signal)) return getState();
        // A broadcast may also have updated memory during the storage await.
        if (isOlderCatalog(catalog, state.catalog)) {
          catalog = state.catalog; source = state.source; savedOffline = state.savedOffline;
        }
        emit({catalog, source, savedOffline, storageError, lastSuccessfulCheck: now(), error: null,
          retainedNewer: retainedNewer || isOlderCatalog(incoming, catalog)});
      } catch {
        if (valid(id, abort.signal) && state.catalog && !state.savedOffline) {
          try {
            const saved = await store.save(state.catalog, {signal: abort.signal});
            if (!valid(id, abort.signal)) return getState();
            const stored = normalized(saved.catalog);
            if (isOlderCatalog(state.catalog, stored)) emit({catalog: stored, source: 'saved'});
            emit({savedOffline: saved.saved === true && sameCatalog(state.catalog, stored), storageError: false});
          } catch { if (valid(id, abort.signal)) emit({storageError: true}); }
        }
        if (valid(id, abort.signal)) emit({error: 'The live check could not be completed. Your available collection is kept.'});
      } finally {
        if (valid(id, abort.signal) && active === request) {
          active = undefined;
          const completed = now();
          emit({refreshing: false, lastAttemptCompleted: completed, nextCheckAt: completed + intervalMs});
          schedule();
        }
      }
      return getState();
    })();
    return request.promise;
  }
  function checkIfDue() {
    if (!running || !initialized) return initializing ?? Promise.resolve(getState());
    if (active) return active.promise;
    const time = now(), completed = state.lastAttemptCompleted;
    if (completed === null || time - completed >= intervalMs) return refresh();
    if (time < completed) {
      // Wall-clock corrections must not postpone the next elapsed-time check
      // indefinitely or turn a focus event into an immediate request storm.
      emit({lastAttemptCompleted: time, nextCheckAt: time + intervalMs});
      schedule();
    }
    return Promise.resolve(getState());
  }
  function start() {
    if (running) return initializing ?? active?.promise ?? Promise.resolve(getState());
    running = true;
    const id = ++generation;
    unsubscribe = store.subscribe?.(() => { void reconcileSaved(); });
    if (initialized) {
      const remaining = state.nextCheckAt === null ? 0 : Math.min(intervalMs, Math.max(0, state.nextCheckAt - now()));
      schedule(remaining);
      void reconcileSaved();
      return checkIfDue();
    }
    const startupRequest = new AbortController(); startupAbort = startupRequest;
    const startup = (async () => {
      await reconcileSaved();
      if (!valid(id)) return getState();
      try {
        const bundled = normalized(await fetchBundled({signal: startupRequest.signal}));
        if (valid(id) && (!state.catalog || isOlderCatalog(state.catalog, bundled))) emit({catalog: bundled, source: 'bundled', savedOffline: false});
      } catch {}
      if (!valid(id)) return getState();
      initialized = true;
      return refresh();
    })();
    initializing = startup;
    void startup.finally(() => { if (initializing === startup) initializing = undefined; });
    return startup;
  }
  function stop() {
    running = false; generation++;
    clearTimer(timer); timer = undefined;
    startupAbort?.abort(); startupAbort = undefined;
    active?.abort.abort(); active = undefined;
    initializing = undefined;
    unsubscribe?.(); unsubscribe = undefined;
    emit({refreshing: false});
  }
  return {start, refresh, checkIfDue, reconcileSaved, stop, getState};
}

export function bindCatalogLifecycle(controller, {windowObject = globalThis.window, documentObject = globalThis.document} = {}) {
  const due = () => { void controller.reconcileSaved(); void controller.checkIfDue(); };
  const visible = () => { if (documentObject?.visibilityState === 'visible') due(); };
  const resume = () => { void controller.start(); };
  const pause = () => controller.stop();
  windowObject?.addEventListener('focus', due);
  windowObject?.addEventListener('online', due);
  windowObject?.addEventListener('pageshow', resume);
  windowObject?.addEventListener('pagehide', pause);
  documentObject?.addEventListener('visibilitychange', visible);
  return () => {
    windowObject?.removeEventListener('focus', due); windowObject?.removeEventListener('online', due);
    windowObject?.removeEventListener('pageshow', resume); windowObject?.removeEventListener('pagehide', pause);
    documentObject?.removeEventListener('visibilitychange', visible); controller.stop();
  };
}
