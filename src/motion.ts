/**
 * Interface motion, started once from main.tsx. Styles are in frontend-design.css.
 *
 * Reveal: sections that start below the fold fade up as they scroll into view, in every connection
 * mode (it downloads nothing and draws no frames once a section is shown). Only this module hides
 * anything (data-reveal="pending"), so the page is complete without it, and it hides nothing when
 * reduced motion is preferred or IntersectionObserver is missing. A held section is shown at
 * once, without the fade, when keyboard focus reaches it, and at once when printing. Official
 * warnings, and the forecast hazards beside them, are never held: they are on the page the moment
 * it renders.
 *
 * Tilt: under a fine pointer, cards lean a few degrees toward it. One delegated, passive
 * pointermove listener writes CSS custom properties, at most once per animation frame. A card
 * keeps the lean while the pointer stays inside the box it had before it leaned (a lean moves its
 * edges, so the element under a pointer near one can change while the pointer does not), and
 * loses the properties, and data-tilt, once the pointer leaves that box or the window. Pressing a
 * button (to select text, say) stops it. Like the 3D globe, it belongs to Full workspace: in field
 * mode (Data saver, Offline only) cards stay flat. The globe's card is neither held nor tilted: it
 * keeps its size from the first paint, and picking a point on it relies on boxes that do not move.
 *
 * Choosing reduced motion while the page is open stops both at once and shows every held section.
 */

/**
 * Page sections that can be held back until they scroll into view. The safety grid (official
 * warnings and forecast hazards) is left out on purpose, so a warning never waits on a fade.
 */
export const REVEAL_SELECTOR = [
  '.page-heading',
  '.field-controls',
  '.overview-grid > *',
  '.signal-strip',
  '.analytics-grid > .panel',
  '.offline-briefing',
  '.disaster-watch',
  '.preparedness-banner',
  '.sources-panel',
  '.footer',
].join(', ');

/**
 * Cards that lean toward the pointer. Interactive data surfaces (the map, the chart) and the
 * official warnings never do: a moving target would make them harder to read and to operate.
 */
export const TILT_SELECTOR = [
  '.conditions-card',
  '.disaster-card',
  '.sources-grid > div',
  '.preparedness-banner',
].join(', ');

/** App marks the shell with this class in Data saver and Offline only. */
export const FIELD_MODE_SELECTOR = '.field-mode';
/** The most a small card leans, in degrees; larger cards lean less (see tiltFor). */
export const MAX_TILT = 5;
export const TILT_PROPERTIES = [
  '--tilt-rx',
  '--tilt-ry',
  '--tilt-px',
  '--tilt-py',
  '--glare-x',
  '--glare-y',
  '--glare-angle',
] as const;
export type Tilt = Record<(typeof TILT_PROPERTIES)[number], string>;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const FINE_POINTER = '(hover: hover) and (pointer: fine)';
/** Delay between sections that come into view together, and the most it adds up to. */
const STAGGER_MS = 90;
const MAX_STAGGER_STEPS = 4;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The custom properties for a pointer at (x, y) over a card's box: rotations toward the pointer,
 * its position from -1 to 1 for parallax, and its position in percent and directional angle for
 * the specular sheen. A larger card leans less, so its far edge moves about as far as a small
 * card's. Null for an empty or non-finite box.
 */
export function tiltFor(
  box: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  x: number,
  y: number,
): Tilt | null {
  if (
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !(box.width > 0) ||
    !(box.height > 0)
  )
    return null;
  const px = clamp((x - box.left) / box.width, 0, 1);
  const py = clamp((y - box.top) / box.height, 0, 1);
  const max = MAX_TILT * Math.min(1, 260 / Math.max(box.width, box.height));
  const angle = (Math.atan2(py - 0.5, px - 0.5) * 180) / Math.PI + 90;
  return {
    '--tilt-rx': `${((0.5 - py) * 2 * max).toFixed(2)}deg`,
    '--tilt-ry': `${((px - 0.5) * 2 * max).toFixed(2)}deg`,
    '--tilt-px': ((px - 0.5) * 2).toFixed(3),
    '--tilt-py': ((py - 0.5) * 2).toFixed(3),
    '--glare-x': `${(px * 100).toFixed(1)}%`,
    '--glare-y': `${(py * 100).toFixed(1)}%`,
    '--glare-angle': `${angle.toFixed(1)}deg`,
  };
}

/** Listen for a media query change, in browsers with either listener API. */
function onChange(query: MediaQueryList, listener: () => void): () => void {
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }
  query.addListener?.(listener);
  return () => query.removeListener?.(listener);
}

type MotionWindow = Window & typeof globalThis;

/** Start reveal and tilt for `doc`. Returns a function that stops both and shows every section. */
export function startMotion(win: MotionWindow = window, doc: Document = document): () => void {
  if (typeof win.matchMedia !== 'function') return () => {};
  const reduced = win.matchMedia(REDUCED_MOTION);
  const fine = win.matchMedia(FINE_POINTER);
  let stopReveal: (() => void) | null = null;
  let stopTilt: (() => void) | null = null;
  const update = () => {
    const calm = reduced.matches;
    if (calm || !win.IntersectionObserver) {
      stopReveal?.();
      stopReveal = null;
    } else stopReveal ??= startReveal(win, doc);
    if (calm || !fine.matches) {
      stopTilt?.();
      stopTilt = null;
    } else stopTilt ??= startTilt(win, doc);
  };
  update();
  const unlisten = [onChange(reduced, update), onChange(fine, update)];
  return () => {
    for (const stop of unlisten) stop();
    stopReveal?.();
    stopTilt?.();
    stopReveal = stopTilt = null;
  };
}

function startReveal(win: MotionWindow, doc: Document): () => void {
  const held = new Set<Element>();
  const seen = new WeakSet<Element>();
  let frame = 0;
  const show = (element: Element, order = 0, instant = false) => {
    if (!held.delete(element)) return;
    observer.unobserve(element);
    const style = (element as HTMLElement).style;
    if (order)
      style?.setProperty('--reveal-delay', `${Math.min(order, MAX_STAGGER_STEPS) * STAGGER_MS}ms`);
    if (!instant) return element.setAttribute('data-reveal', 'shown');
    // A control that keyboard focus reaches is shown as it is, not faded in under the focus ring:
    // the shown state is applied with transitions off, then they are handed back to the stylesheet.
    style?.setProperty('transition', 'none');
    element.setAttribute('data-reveal', 'shown');
    void win.getComputedStyle?.(element).opacity;
    style?.removeProperty('transition');
  };
  const showAll = () => {
    for (const element of [...held]) show(element);
  };
  // Any visible pixel counts. A margin that shrank the viewport would leave a short section at the
  // very end of the page, such as the footer, outside it even when scrolled to the bottom.
  const observer = new win.IntersectionObserver(
    (entries) => {
      let order = 0;
      for (const entry of entries) if (entry.isIntersecting) show(entry.target, order++);
    },
    { threshold: 0 },
  );
  // Only sections that start below the fold are held: what is on screen never flickers, and a
  // section once shown (before reduced motion was switched on and off again) stays shown.
  const scan = () => {
    frame = 0;
    for (const element of [...held])
      if (!element.isConnected) {
        held.delete(element);
        observer.unobserve(element);
      }
    for (const element of doc.querySelectorAll(REVEAL_SELECTOR)) {
      if (seen.has(element) || element.getAttribute('data-reveal')) continue;
      seen.add(element);
      if (element.getBoundingClientRect().top < win.innerHeight) continue;
      element.setAttribute('data-reveal', 'pending');
      held.add(element);
      observer.observe(element);
    }
  };
  // React renders after this starts, and panels mount later (Full workspace, lazy tools). A panel
  // mounts beside the others, never inside one, so changes within a section (a chart redrawing,
  // map tiles, satellite playback) schedule nothing.
  const schedule = () => {
    frame ||= win.requestAnimationFrame(scan);
  };
  const changed = (records: MutationRecord[]) => {
    for (const record of records)
      if (!(record.target as Element).closest?.(REVEAL_SELECTOR)) return schedule();
  };
  const mutations = win.MutationObserver ? new win.MutationObserver(changed) : null;
  mutations?.observe(doc.body, { childList: true, subtree: true });
  // Focus that reaches a held section, from Tab or a skip link, shows it at once. One that lands in
  // a section still fading in (scrolled to a moment before) ends the fade there and then.
  const focus = (event: Event) => {
    const target = event.target as Node | null;
    if (!target) return;
    for (const element of [...held]) if (element.contains(target)) show(element, 0, true);
    for (let node = target as Element | null; node; node = node.parentElement)
      if (node.getAttribute?.('data-reveal') === 'shown') {
        for (const fade of node.getAnimations?.() ?? [])
          if (/^(?:opacity|translate)$/.test((fade as CSSTransition).transitionProperty ?? ''))
            fade.finish();
        break;
      }
  };
  doc.addEventListener('focusin', focus);
  win.addEventListener('beforeprint', showAll);
  scan();
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    mutations?.disconnect();
    doc.removeEventListener('focusin', focus);
    win.removeEventListener('beforeprint', showAll);
    showAll();
    observer.disconnect();
  };
}

type Box = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

function startTilt(win: MotionWindow, doc: Document): () => void {
  let card: HTMLElement | null = null;
  /**
   * The card's box before it leaned, in page coordinates. A lean lifts the card and pulls its far
   * edge in, so hit-testing the leaning card would drop a pointer near an edge, flatten the card
   * under it and lean it again: the lean and its hit-test use this box instead.
   */
  let rest: Box | null = null;
  let frame = 0;
  let x = 0;
  let y = 0;
  /** The box at rest where it is on screen now, after any scrolling since it was read. */
  const box = (): Box | null =>
    rest && { ...rest, left: rest.left - win.scrollX, top: rest.top - win.scrollY };
  const inside = (px: number, py: number) => {
    const at = box();
    return (
      !!at && px >= at.left && px <= at.left + at.width && py >= at.top && py <= at.top + at.height
    );
  };
  const release = () => {
    if (card) {
      for (const name of TILT_PROPERTIES) card.style.removeProperty(name);
      card.removeAttribute('data-tilt');
    }
    card = null;
    rest = null;
  };
  // Read before the card has data-tilt, so the box is the card at rest.
  const enter = (next: HTMLElement) => {
    const { left, top, width, height } = next.getBoundingClientRect();
    card = next;
    rest = { left: left + win.scrollX, top: top + win.scrollY, width, height };
  };
  const apply = () => {
    frame = 0;
    const at = box();
    if (!card || !at) return;
    const tilt = tiltFor(at, x, y);
    if (!tilt) return;
    for (const name of TILT_PROPERTIES) card.style.setProperty(name, tilt[name]);
    card.setAttribute('data-tilt', '');
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    const target = event.target as Element | null;
    let next: HTMLElement | null = null;
    if (!event.buttons) {
      // Inside the box at rest the card keeps its lean, whatever lies under its moved edge.
      if (card && inside(event.clientX, event.clientY)) next = card;
      else if (typeof target?.closest === 'function')
        next = target.closest<HTMLElement>(TILT_SELECTOR);
    }
    // Checked on every move: switching mode adds or removes the class without a reload.
    if (next?.closest(FIELD_MODE_SELECTOR)) next = null;
    if (next !== card) {
      release();
      if (next) enter(next);
    }
    if (!card) return;
    x = event.clientX;
    y = event.clientY;
    frame ||= win.requestAnimationFrame(apply);
  };
  // pointerleave does not bubble, but a capturing listener on the document still receives it.
  const leave = (event: PointerEvent) => {
    if (!card) return;
    // The pointer left the window: whatever it was over, the lean ends.
    if (!event.relatedTarget && event.target === doc.documentElement) return release();
    if (event.target !== card) return;
    // Off the card's moved edge but still inside its box at rest: the next move decides.
    if (event.relatedTarget && inside(event.clientX, event.clientY)) return;
    release();
  };
  // Scrolling moves the card under a still pointer: the lean follows, or ends outside the box.
  const scrolled = () => {
    if (!card) return;
    if (!inside(x, y)) return release();
    frame ||= win.requestAnimationFrame(apply);
  };
  // A new layout can move or resize the card: the next move reads its box again.
  const resized = () => release();
  doc.addEventListener('pointermove', move, { passive: true });
  doc.addEventListener('pointerleave', leave, { passive: true, capture: true });
  win.addEventListener('scroll', scrolled, { passive: true });
  win.addEventListener('resize', resized, { passive: true });
  win.addEventListener('blur', release, { passive: true });
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    doc.removeEventListener('pointermove', move);
    doc.removeEventListener('pointerleave', leave, { capture: true });
    win.removeEventListener('scroll', scrolled);
    win.removeEventListener('resize', resized);
    win.removeEventListener('blur', release);
    release();
  };
}
