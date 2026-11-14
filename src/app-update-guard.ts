import { readPlaces } from './presentation';
import type { Place } from './types';

declare global {
  interface Window { appUpdateCanReload?: () => boolean; }
}

const KEY = 'stormsignal:update-place';
type UpdateStorage = Pick<Storage, 'getItem' | 'setItem'>;
export function restoreUpdatePlace(storage: UpdateStorage, fallback: Place): Place {
  try { return readPlaces(storage.getItem(KEY))[0] ?? fallback; }
  catch { return fallback; }
}

// Keep the selected location across the approved reload. Search drafts,
// geolocation and notification subscriptions remain owned by this window.
export function canApplyAppUpdate(state: {
  query: string; searching: boolean; geoBusy: boolean; drawerOpen: boolean;
  notifications: boolean; place: Place;
}, storage: UpdateStorage): boolean {
  if (state.query.trim() || state.searching || state.geoBusy || state.drawerOpen || state.notifications) return false;
  try {
    storage.setItem(KEY, JSON.stringify([state.place]));
    return true;
  } catch { return false; }
}
