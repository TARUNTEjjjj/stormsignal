import type { Place } from './types';

export type Resource<T> = { data: T | null; loading: boolean; error: string | null };
export type ResourceLoader<T> = (place: Place, signal?: AbortSignal) => Promise<T>;
export type ResourceState<T> = Resource<T> & { key: string; loader: ResourceLoader<T> };
export type ResourceUpdate<T> = (update: (previous: ResourceState<T>) => ResourceState<T>) => void;

/**
 * Start one load for a place and report its states through `update`. Returns the cleanup.
 * A refresh of the same place with the same loader keeps the last successful result while it
 * runs and after it fails; `error` then reports the failed refresh. The result keeps its own
 * fetch time, so the age limits for display and saving still apply to it. A different place
 * or loader, or a disabled resource, starts empty.
 */
export function loadResource<T>(
  place: Place,
  key: string,
  loader: ResourceLoader<T>,
  enabled: boolean,
  update: ResourceUpdate<T>,
): () => void {
  const controller = new AbortController();
  let active = true;
  if (!enabled) {
    update(() => ({ data: null, loading: false, error: null, key, loader }));
    return () => controller.abort();
  }
  const kept = (previous: ResourceState<T>) =>
    previous.key === key && previous.loader === loader ? previous.data : null;
  update((previous) => ({ data: kept(previous), loading: true, error: null, key, loader }));
  loader(place, controller.signal)
    .then((data) => {
      if (active) update(() => ({ data, loading: false, error: null, key, loader }));
    })
    .catch((e) => {
      if (active && !controller.signal.aborted)
        update((previous) => ({
          data: kept(previous),
          loading: false,
          error: e instanceof Error ? e.message : 'The data provider is unavailable.',
          key,
          loader,
        }));
    });
  return () => {
    active = false;
    controller.abort();
  };
}

/** What the component renders: never another place's or another loader's result. */
export function currentResource<T>(
  state: ResourceState<T>,
  key: string,
  loader: ResourceLoader<T>,
  enabled: boolean,
): Resource<T> {
  return enabled && state.key === key && state.loader === loader
    ? state
    : { data: null, loading: enabled, error: null };
}
