import { readPlaces } from './presentation';
import type { Place } from './types';

declare global {
  interface Window {
    appUpdateCanReload?: () => boolean;
    /** Published by resources/app-updates.mjs; 'reloading' is set just before it reloads. */
    __appUpdateState?: { status?: string };
  }
}

const KEY = 'stormsignal:update-place';
const PROBE = `${KEY}:probe`;
type UpdateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** The place an update reload handed over, used once; otherwise the fallback. */
export function restoreUpdatePlace(storage: UpdateStorage, fallback: Place): Place {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return fallback;
    storage.removeItem(KEY);
    return readPlaces(raw)[0] ?? fallback;
  } catch {
    return fallback;
  }
}

// Keep the selected location across the approved reload. Search drafts,
// geolocation and notification subscriptions remain owned by this window.
export function canApplyAppUpdate(
  state: {
    query: string;
    searching: boolean;
    geoBusy: boolean;
    drawerOpen: boolean;
    notifications: boolean;
    place: Place;
  },
  storage: UpdateStorage,
): boolean {
  if (
    state.query.trim() ||
    state.searching ||
    state.geoBusy ||
    state.drawerOpen ||
    state.notifications
  )
    return false;
  // The updater also asks on routine checks that find no new version, so only test that the
  // place could be stored: one left behind would reopen on an ordinary reload.
  try {
    storage.setItem(PROBE, JSON.stringify([state.place]));
    storage.removeItem(PROBE);
    return true;
  } catch {
    return false;
  }
}

/** As the page is hidden: store the place only when the updater itself is reloading the page. */
export function handOverUpdatePlace(
  update: Window['__appUpdateState'],
  place: Place,
  storage: UpdateStorage,
): boolean {
  if (update?.status !== 'reloading') return false;
  try {
    storage.setItem(KEY, JSON.stringify([place]));
    return true;
  } catch {
    return false;
  }
}
