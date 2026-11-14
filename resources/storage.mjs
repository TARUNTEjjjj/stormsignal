import {PROJECT, normalizeCatalog, catalogJSON, isOlderCatalog} from './catalog.mjs';

export const CATALOG_DATABASE = 'resource-library-v1';
export const CATALOG_STORE = 'catalogs';
export const CATALOG_KEY = `${PROJECT}:1`;

// A transaction compares the existing snapshot and writes its replacement together.
// No request timestamps, browsing state, credentials, or private data are stored.
export function createCatalogStore({indexedDB: database, BroadcastChannel: Channel, timeoutMs = 1500} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid storage deadline');
  if (database === undefined) { try { database = globalThis.indexedDB; } catch {} }
  if (Channel === undefined) { try { Channel = globalThis.BroadcastChannel; } catch {} }
  let connection, opening, channel;
  const listeners = new Set();
  function validate(value) {
    try { return value ? JSON.parse(catalogJSON(value)) : null; } catch { return null; }
  }
  function open() {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    const attempt = new Promise((resolve, reject) => {
      if (!database) { reject(new Error('Offline storage is unavailable')); return; }
      let request, settled = false;
      const timer = setTimeout(() => finish(new Error('Offline storage did not open in time')), timeoutMs);
      const finish = (error, db) => {
        if (settled) { db?.close(); return; }
        settled = true; clearTimeout(timer);
        if (error) reject(error);
        else {
          connection = db;
          db.onversionchange = () => { db.close(); if (connection === db) connection = undefined; };
          resolve(db);
        }
      };
      try {
        request = database.open(CATALOG_DATABASE, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(CATALOG_STORE)) request.result.createObjectStore(CATALOG_STORE);
        };
        request.onsuccess = () => finish(null, request.result);
        request.onerror = () => finish(new Error('Offline storage could not be opened'));
        // A blocked upgrade stays bounded by the deadline; it is not a reason to
        // delete another tab's database or discard its last good snapshot.
      } catch { finish(new Error('Offline storage is unavailable')); }
    });
    opening = attempt;
    void attempt.then(() => { if (opening === attempt) opening = undefined; }, () => { if (opening === attempt) opening = undefined; });
    return attempt;
  }
  async function transaction(mode, candidate, signal) {
    if (signal?.aborted) throw new Error('Offline save cancelled');
    const db = await open();
    if (signal?.aborted) throw new Error('Offline save cancelled');
    return new Promise((resolve, reject) => {
      let tx, result = null, settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => { try { tx?.abort(); } catch {} finish(new Error('Offline save cancelled')); };
      const timer = setTimeout(() => { try { tx?.abort(); } catch {} finish(new Error('Offline storage timed out')); }, timeoutMs);
      signal?.addEventListener('abort', abort, {once: true});
      try {
        tx = db.transaction(CATALOG_STORE, mode);
        const store = tx.objectStore(CATALOG_STORE), request = store.get(CATALOG_KEY);
        request.onsuccess = () => {
          try {
            const existing = validate(request.result);
            if (mode === 'readonly') { result = existing; return; }
            if (isOlderCatalog(candidate, existing)) { result = {catalog: existing, saved: true, accepted: false}; return; }
            const unchanged = existing && JSON.stringify(existing) === JSON.stringify(candidate);
            if (!unchanged) store.put(candidate, CATALOG_KEY);
            result = {catalog: unchanged ? existing : candidate, saved: true, accepted: !unchanged};
          } catch {
            try { tx.abort(); } catch {}
            finish(new Error('Offline storage could not save this collection'));
          }
        };
        tx.oncomplete = () => finish();
        tx.onabort = tx.onerror = () => finish(new Error('Offline storage could not save or read this collection'));
      } catch { finish(new Error('Offline storage is unavailable')); }
    });
  }
  function getChannel() {
    if (!channel && Channel) {
      try {
        channel = new Channel('resource-library-updates-v1');
        channel.onmessage = event => {
          if (event.data?.key !== CATALOG_KEY) return;
          for (const listener of listeners) { try { listener(); } catch {} }
        };
      } catch {}
    }
    return channel;
  }
  return {
    load: () => transaction('readonly'),
    async save(catalog, {signal} = {}) {
      const candidate = JSON.parse(catalogJSON(normalizeCatalog(catalog)));
      const result = await transaction('readwrite', candidate, signal);
      if (result.accepted) { try { getChannel()?.postMessage({key: CATALOG_KEY}); } catch {} }
      return result;
    },
    subscribe(listener) { listeners.add(listener); getChannel(); return () => listeners.delete(listener); },
    close() { connection?.close(); connection = undefined; channel?.close(); channel = undefined; listeners.clear(); },
  };
}
