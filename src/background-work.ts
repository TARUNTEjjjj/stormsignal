/**
 * The dashboard's background work: a check of this site for a new release, a check of the
 * resource library's collection on GitHub, and the library's offline copy. The code is the
 * resource library's own, published under /resources/; resources/background.mjs is its entry for
 * the dashboard, and loading it starts nothing.
 *
 * It runs only while the connection policy allows polling: Full workspace, with the browser
 * reporting a connection. Data saver and Offline only promise no background requests, so there the
 * dashboard does not even request this code.
 */
import type { ConnectionMode } from './connectivity';

interface CatalogController {
  start(): Promise<unknown>;
  stop(): void;
}
interface AppUpdater {
  start(): Promise<unknown>;
  stop(): void;
  getState(): unknown;
}
/** The parts of resources/background.mjs that the dashboard uses. */
export interface BackgroundModule {
  createCatalogController(options?: { countInterruptedChecks?: boolean }): CatalogController;
  /** Returns the function that removes the page listeners and stops the controller. */
  bindCatalogLifecycle(controller: CatalogController): () => void;
  ensureOfflineShell(): Promise<unknown>;
  /** Starts checking at once. Null when the page carries no release stamp (the dev server). */
  startAppUpdates(): AppUpdater | null | undefined;
}

/** A failed module download is tried again after the interval of the checks themselves. */
export const MODULE_RETRY_MS = 15 * 60_000;

/**
 * The address of a resource-library module. It is absolute: Vite's dev server rewrites a relative
 * runtime import into a request it refuses for files in public/. A retry gets an address of its
 * own, because a browser can remember a failed module download for the life of the page.
 */
export function resourceModuleUrl(file: string, origin: string, attempt: number): string {
  const url = new URL(`/resources/${file}`, origin);
  if (attempt > 0) url.searchParams.set('retry', String(attempt));
  return url.href;
}

function importBackgroundModule(attempt: number): Promise<BackgroundModule> {
  return import(
    /* @vite-ignore */ resourceModuleUrl('background.mjs', window.location.origin, attempt)
  );
}

/**
 * Whether choosing `next` in the connection-mode control ends this page's alerts. They are
 * notifications from Full workspace's warning checks, so a real change of mode ends them. Choosing
 * the mode already in use changes nothing and leaves them on.
 */
export function modeChoiceEndsPageAlerts(
  current: ConnectionMode,
  next: ConnectionMode,
  alertsOn: boolean,
): boolean {
  return alertsOn && next !== current;
}

export function createBackgroundWork(load: (attempt: number) => Promise<BackgroundModule>) {
  let wanted = false;
  let running = false;
  let library: BackgroundModule | undefined;
  let loading = false;
  let attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let catalog: CatalogController | undefined;
  let unbindCatalog: (() => void) | undefined;
  let updater: AppUpdater | null | undefined;

  // App switches this work from an effect, where a throw would replace the dashboard with its
  // error screen. A fault in the published code only leaves the background work off.
  const guarded = (action: () => void) => {
    try {
      action();
    } catch {
      /* The dashboard works without its background work. */
    }
  };

  function start(entry: BackgroundModule) {
    if (running) return;
    running = true;
    guarded(() => {
      // One controller for the page: it remembers its last check, even one the switch interrupted,
      // so switching modes back and forth cannot ask GitHub more often than its 15-minute interval.
      catalog ??= entry.createCatalogController({ countInterruptedChecks: true });
      unbindCatalog = entry.bindCatalogLifecycle(catalog);
      void catalog.start();
    });
    guarded(() => {
      if (updater === undefined) {
        const shared = entry.startAppUpdates() ?? null;
        if (shared) {
          // The updater keeps its page listeners for the life of the page, and the one for
          // `pageshow` starts it again when the page returns from the back/forward cache. It
          // must stay stopped while this work is off.
          const resume = shared.start;
          shared.start = () => (running ? resume.call(shared) : Promise.resolve(shared.getState()));
        }
        updater = shared;
      }
      void updater?.start();
    });
    guarded(() => void entry.ensureOfflineShell().catch(() => {}));
  }

  function stop() {
    if (!running) return;
    running = false;
    guarded(() => unbindCatalog?.());
    unbindCatalog = undefined;
    guarded(() => updater?.stop());
  }

  function request() {
    if (loading) return;
    loading = true;
    load(attempts++).then(
      (loaded) => {
        loading = false;
        library = loaded;
        if (wanted) start(loaded);
      },
      () => {
        loading = false;
        if (wanted) retry = setTimeout(request, MODULE_RETRY_MS);
      },
    );
  }

  return {
    /** Switch the background work on or off. Takes effect at once; no reload is needed. */
    set(on: boolean) {
      if (on === wanted) return;
      wanted = on;
      clearTimeout(retry);
      retry = undefined;
      if (!on) stop();
      else if (library) start(library);
      else request();
    },
  };
}

const dashboard = createBackgroundWork(importBackgroundModule);

/** App passes its polling policy: Full workspace while the browser reports a connection. */
export const setBackgroundWork = dashboard.set;
