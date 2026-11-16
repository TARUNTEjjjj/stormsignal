// The dashboard's entry to this library's background work: release checks, the collection check
// with GitHub and the library's offline copy. Loading it starts nothing. The dashboard starts and
// stops the work as its connection mode allows (src/background-work.ts); the library page has its
// own entry point. Dashboard pages saved by earlier releases still load this file with a script
// tag, so it must stay free of side effects.
export {createCatalogController, bindCatalogLifecycle} from './live.mjs';
export {ensureOfflineShell} from './offline.mjs';
export {startAppUpdates} from './app-updates.mjs';
