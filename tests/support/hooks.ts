/**
 * A stand-in for React's hooks, enough to run one function component's state, refs and effects in
 * Node, where React's own renderer would need a DOM. A test compiles the component with 'react'
 * pointing at REACT_STAND_IN; the component then returns its element tree as plain objects, and
 * `mount` renders it, attaches refs (as React does before effects run), runs the effects whose
 * dependencies changed (every cleanup first, then the effects, in order), and renders again while
 * state changes. Hooks it does not know throw, so a component that outgrows it fails loudly.
 */
export const REACT_STAND_IN = `
  const hooks = () => {
    const current = globalThis.__hooks;
    if (!current) throw new Error('A hook was called outside a render.');
    return current;
  };
  export const useState = (initial) => hooks().useState(initial);
  export const useEffect = (effect, deps) => hooks().useEffect(effect, deps);
  export const useRef = (initial) => hooks().useRef(initial);
  export const useCallback = (callback, deps) => hooks().useMemo(() => callback, deps);
  export const useMemo = (make, deps) => hooks().useMemo(make, deps);
  export const useId = () => ':g:';
  export const Fragment = Symbol.for('react.fragment');
  export const jsx = (type, props, key) => ({ type, props, key });
  export const jsxs = jsx;
  export const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
  export const forwardRef = (render) => render;
  export default { useState, useEffect, useRef, useCallback, useMemo, useId, createElement, Fragment, forwardRef };
`;

export interface Element {
  type: unknown;
  props: Record<string, unknown>;
}
type EffectSlot = {
  ran: boolean;
  deps?: unknown[];
  cleanup?: () => void;
  next?: { effect: () => unknown; deps?: unknown[] };
};
const changed = (before?: unknown[], after?: unknown[]) =>
  !before ||
  !after ||
  before.length !== after.length ||
  before.some((v, i) => !Object.is(v, after[i]));

/**
 * Renders `component` with `props` and runs its effects. `attach` receives each rendered element
 * before the effects run, to fill the refs it hands to its children.
 */
export function mount<P>(
  component: (props: P) => Element,
  initial: P,
  { attach }: { attach?(element: Element): void } = {},
) {
  let props = initial;
  const slots: unknown[] = [];
  let dirty = false;
  let alive = true;
  let element: Element | null = null;
  let failure: unknown = null;
  let renders = 0;

  function render() {
    let index = 0;
    const queued: number[] = [];
    (globalThis as { __hooks?: unknown }).__hooks = {
      useState(start: unknown) {
        const at = index++;
        if (!slots[at]) {
          const slot = {
            value: typeof start === 'function' ? (start as () => unknown)() : start,
            set(next: unknown) {
              if (!alive) return;
              const value =
                typeof next === 'function'
                  ? (next as (value: unknown) => unknown)(slot.value)
                  : next;
              if (Object.is(value, slot.value)) return;
              slot.value = value;
              dirty = true;
            },
          };
          slots[at] = slot;
        }
        const slot = slots[at] as { value: unknown; set(next: unknown): void };
        return [slot.value, slot.set];
      },
      useRef(start: unknown) {
        const at = index++;
        slots[at] ??= { current: start };
        return slots[at];
      },
      useMemo(make: () => unknown, deps: unknown[]) {
        const at = index++;
        const slot = slots[at] as { deps: unknown[]; value: unknown } | undefined;
        if (slot && !changed(slot.deps, deps)) return slot.value;
        slots[at] = { deps, value: make() };
        return (slots[at] as { value: unknown }).value;
      },
      useEffect(effect: () => unknown, deps?: unknown[]) {
        const at = index++;
        const slot = (slots[at] ??= { ran: false }) as EffectSlot;
        if (!slot.ran || changed(slot.deps, deps)) {
          slot.next = { effect, deps };
          queued.push(at);
        }
      },
    };
    renders++;
    try {
      element = component(props);
    } catch (error) {
      // An error boundary takes over: the component and its effects are gone.
      failure = error;
      element = null;
      unmount();
      return;
    } finally {
      delete (globalThis as { __hooks?: unknown }).__hooks;
    }
    attach?.(element);
    for (const at of queued) (slots[at] as EffectSlot).cleanup?.();
    for (const at of queued) {
      const slot = slots[at] as EffectSlot;
      const { effect, deps } = slot.next!;
      slot.ran = true;
      slot.deps = deps;
      slot.next = undefined;
      const cleanup = effect();
      slot.cleanup = typeof cleanup === 'function' ? (cleanup as () => void) : undefined;
    }
  }
  /** Renders again while state has changed. */
  function flush() {
    for (let pass = 0; dirty && alive; pass++) {
      if (pass > 100) throw new Error('The component keeps changing its state.');
      dirty = false;
      render();
    }
  }
  function unmount() {
    if (!alive) return;
    alive = false;
    for (const slot of slots) {
      const effect = slot as EffectSlot;
      if (effect && typeof effect === 'object' && 'ran' in effect && effect.ran) effect.cleanup?.();
    }
  }
  render();
  flush();
  return {
    /** The last element rendered. */
    get element(): Element {
      if (!element) throw new Error('Nothing is rendered.');
      return element;
    },
    /** The props of the last element rendered. */
    get props() {
      return this.element.props as Record<string, never>;
    },
    /** What the component threw, for its error boundary. */
    get error() {
      return failure;
    },
    get renders() {
      return renders;
    },
    flush,
    /** Lets promises settle, rendering as state changes. */
    async settle() {
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve();
        flush();
      }
    },
    update(next: Partial<P>) {
      props = { ...props, ...next };
      dirty = true;
      flush();
    },
    unmount,
  };
}
