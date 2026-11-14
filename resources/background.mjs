import {createCatalogController, bindCatalogLifecycle} from './live.mjs';
import {ensureOfflineShell} from './offline.mjs';

// The same-origin library has its own entry point and must not run twice.
if (typeof document !== 'undefined' && !document.getElementById('resource-grid')) {
  const controller = createCatalogController();
  bindCatalogLifecycle(controller);
  void controller.start();
  void ensureOfflineShell().catch(() => {});
}
