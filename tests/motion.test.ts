import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TILT,
  REVEAL_SELECTOR,
  TILT_PROPERTIES,
  TILT_SELECTOR,
  startMotion,
  tiltFor,
} from '../src/motion';

// motion.ts runs against stand-ins for the browser: elements that match selectors by name, a
// document and window that keep their listeners, and observers and animation frames that a
// test triggers itself.
type Box = { left: number; top: number; width: number; height: number };
const parts = (selector: string) => selector.split(',').map((part) => part.trim());

class Element {
  attributes = new Map<string, string>();
  properties = new Map<string, string>();
  parent: Element | null = null;
  isConnected = true;
  style = {
    setProperty: (name: string, value: string) => void this.properties.set(name, value),
    removeProperty: (name: string) => {
      const value = this.properties.get(name) ?? '';
      this.properties.delete(name);
      return value;
    },
  };
  constructor(
    readonly names: string[],
    public box: Box = { left: 0, top: 0, width: 300, height: 200 },
  ) {}
  get parentElement() {
    return this.parent;
  }
  getAttribute = (name: string) => this.attributes.get(name) ?? null;
  setAttribute = (name: string, value: string) => void this.attributes.set(name, value);
  removeAttribute = (name: string) => void this.attributes.delete(name);
  getBoundingClientRect = () => ({ ...this.box });
  matches = (selector: string) => parts(selector).some((part) => this.names.includes(part));
  closest(selector: string): Element | null {
    for (let node: Element | null = this; node; node = node.parent)
      if (node.matches(selector)) return node;
    return null;
  }
  contains(node: unknown): boolean {
    for (let current = node as Element | null; current; current = current.parent)
      if (current === this) return true;
    return false;
  }
  child(names: string[] = ['.inner']) {
    const element = new Element(names, this.box);
    element.parent = this;
    return element;
  }
}

type ListenerOptions = boolean | { capture?: boolean; passive?: boolean };
/** Listeners by type; a capturing listener is kept apart from a bubbling one, as in a browser. */
function listeners() {
  const all = new Map<
    string,
    Set<{ listener: (event: object) => void; capture: boolean; passive: boolean }>
  >();
  const capture = (options?: ListenerOptions) =>
    typeof options === 'boolean' ? options : !!options?.capture;
  return {
    addEventListener(type: string, listener: (event: object) => void, options?: ListenerOptions) {
      const set = all.get(type) ?? new Set();
      for (const entry of set) if (entry.listener === listener) return;
      const passive = typeof options === 'object' && !!options.passive;
      set.add({ listener, capture: capture(options), passive });
      all.set(type, set);
    },
    removeEventListener(
      type: string,
      listener: (event: object) => void,
      options?: ListenerOptions,
    ) {
      for (const entry of all.get(type) ?? [])
        if (entry.listener === listener && entry.capture === capture(options))
          all.get(type)!.delete(entry);
    },
    send(type: string, event: object) {
      for (const { listener } of [...(all.get(type) ?? [])]) listener(event);
    },
    capturing: (type: string) => [...(all.get(type) ?? [])].some((entry) => entry.capture),
    has: (type: string) => !!all.get(type)?.size,
    /** Every listener for `type` was added as passive (and there is at least one). */
    passive: (type: string) =>
      !!all.get(type)?.size && [...all.get(type)!].every((entry) => entry.passive),
    count: () => [...all.values()].reduce((total, set) => total + set.size, 0),
  };
}

function browser({
  reduced = false,
  fine = true,
  intersection = true,
  elements = [] as Element[],
} = {}) {
  const queries = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
  const media = (text: string, matches: boolean) => {
    const query = { matches, listeners: new Set<() => void>() };
    queries.set(text, query);
    return query;
  };
  media('(prefers-reduced-motion: reduce)', reduced);
  media('(hover: hover) and (pointer: fine)', fine);
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const intersections: Intersections[] = [];
  const mutations: Mutations[] = [];
  class Intersections {
    observed = new Set<Element>();
    disconnected = false;
    constructor(
      readonly report: (entries: object[]) => void,
      readonly options: { threshold?: number | number[]; rootMargin?: string } = {},
    ) {
      intersections.push(this);
    }
    observe = (element: Element) => void this.observed.add(element);
    unobserve = (element: Element) => void this.observed.delete(element);
    disconnect = () => {
      this.observed.clear();
      this.disconnected = true;
    };
    /** These elements scroll into view together. */
    enter = (...targets: Element[]) =>
      this.report(targets.map((target) => ({ target, isIntersecting: true })));
  }
  /** The page itself, where panels mount: not inside any section. */
  const main = new Element(['main']);
  class Mutations {
    disconnected = false;
    target: unknown = null;
    constructor(readonly callback: (records: { target: unknown }[]) => void) {
      mutations.push(this);
    }
    observe = (target: unknown) => void (this.target = target);
    disconnect = () => void (this.disconnected = true);
    /** Children changed under these elements; by default, a panel mounted in the page. */
    report = (...targets: Element[]) =>
      this.callback((targets.length ? targets : [main]).map((target) => ({ target })));
  }
  const page = { ...listeners(), body: { name: 'body' } };
  const doc = Object.assign(page, {
    documentElement: new Element(['html']),
    querySelectorAll: (selector: string) =>
      elements.filter((element) => element.isConnected && element.matches(selector)),
  });
  const win = Object.assign(listeners(), {
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    matchMedia: (text: string) => {
      const query = queries.get(text) ?? media(text, false);
      return {
        get matches() {
          return query.matches;
        },
        addEventListener: (_type: string, listener: () => void) => query.listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) =>
          query.listeners.delete(listener),
      };
    },
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (handle: number) => void frames.delete(handle),
    IntersectionObserver: intersection ? Intersections : undefined,
    MutationObserver: Mutations,
  });
  return {
    win,
    doc,
    elements,
    intersections,
    mutations,
    frames,
    /** Run the animation frames requested so far. */
    flush() {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback();
    },
    /** The user changes a media preference while the page is open. */
    prefer(text: string, matches: boolean) {
      const query = queries.get(text)!;
      query.matches = matches;
      for (const listener of [...query.listeners]) listener();
    },
    queryListeners: () => [...queries.values()].reduce((n, q) => n + q.listeners.size, 0),
    start() {
      return startMotion(win as unknown as Window & typeof globalThis, doc as unknown as Document);
    },
  };
}

const below = (names: string[], top: number) =>
  new Element(names, { left: 0, top, width: 900, height: 300 });
const pointer = (target: Element | null, x: number, y: number, extra: object = {}) => ({
  target,
  clientX: x,
  clientY: y,
  pointerType: 'mouse',
  buttons: 0,
  ...extra,
});

test('sections below the fold wait for view, and what is already on screen is never hidden', () => {
  const heading = below(['.page-heading'], 40);
  // Low on the first screen, but on it: a section is held only if it starts below the fold.
  const strip = below(['.signal-strip'], 760);
  const chart = below(['.analytics-grid > .panel'], 1300);
  const footer = below(['.footer'], 2600);
  const page = browser({ elements: [heading, strip, chart, footer] });
  page.start();
  assert.equal(heading.getAttribute('data-reveal'), null, 'the first screen is shown as it is');
  assert.equal(strip.getAttribute('data-reveal'), null, 'its lower half too');
  assert.equal(chart.getAttribute('data-reveal'), 'pending');
  assert.equal(footer.getAttribute('data-reveal'), 'pending');
  const [observer] = page.intersections;
  assert.deepEqual([...observer.observed], [chart, footer]);
  observer.enter(chart);
  assert.equal(chart.getAttribute('data-reveal'), 'shown');
  assert.equal(footer.getAttribute('data-reveal'), 'pending');
  assert.deepEqual([...observer.observed], [footer], 'a shown section is no longer watched');
});

test('a section counts as in view from its first visible pixel, so the last one is revealed too', () => {
  // A threshold above 0, or a margin that shrinks the bottom of the viewport, would leave a short
  // section at the very end of the page, the footer, outside it even when scrolled to the bottom.
  const page = browser({ elements: [below(['.footer'], 2600)] });
  page.start();
  const { threshold = 0, rootMargin = '0px' } = page.intersections[0].options;
  assert.deepEqual([threshold].flat(), [0], 'any visible pixel');
  const [top, , bottom = top] = rootMargin.trim().split(/\s+/);
  assert.ok(
    Number.parseFloat(bottom) >= 0,
    `the viewport is not shrunk at the bottom: ${rootMargin}`,
  );
});

test('official warnings, and the forecast hazards beside them, are never held back', () => {
  // Whatever names the safety grid's panels carry, none of them is a section that waits for view.
  for (const part of parts(REVEAL_SELECTOR))
    assert.doesNotMatch(part, /safety|alert|hazard|warning|^\.panel$/, part);
  const names = ['.panel', '.safety-grid > .panel', '.safety-grid > *', 'section'];
  const alerts = below([...names, '.alerts-panel'], 1500);
  const hazards = below([...names, '.hazards-panel'], 1500);
  const page = browser({ elements: [alerts, hazards] });
  page.start();
  page.mutations[0].report();
  page.flush();
  assert.equal(
    alerts.getAttribute('data-reveal'),
    null,
    'warnings are there when the page renders',
  );
  assert.equal(hazards.getAttribute('data-reveal'), null);
});

test('sections that come into view together follow each other, by at most 360 ms', () => {
  const sections = [0, 1, 2, 3, 4, 5].map((step) =>
    below(['.analytics-grid > .panel'], 1300 + step * 50),
  );
  const page = browser({ elements: sections });
  page.start();
  page.intersections[0].enter(...sections);
  assert.deepEqual(
    sections.map((section) => [
      section.getAttribute('data-reveal'),
      section.properties.get('--reveal-delay'),
    ]),
    [
      ['shown', undefined],
      ['shown', '90ms'],
      ['shown', '180ms'],
      ['shown', '270ms'],
      ['shown', '360ms'],
      ['shown', '360ms'],
    ],
    'a long run of sections does not keep the last ones waiting',
  );
});

test('a section seen on screen is not held later, even when something pushes it below the fold', () => {
  // A panel that mounts above it (the satellite card, say) moves it down. What the reader already
  // saw does not vanish to fade in again.
  const outlook = below(['.analytics-grid > .panel'], 300);
  const page = browser({ elements: [outlook] });
  page.start();
  assert.equal(outlook.getAttribute('data-reveal'), null);
  outlook.box = { ...outlook.box, top: 1500 };
  const reports = below(['.disaster-watch'], 2400);
  page.elements.push(reports);
  page.mutations[0].report();
  page.flush();
  assert.equal(outlook.getAttribute('data-reveal'), null, 'still shown as it was');
  assert.equal(reports.getAttribute('data-reveal'), 'pending', 'the new panel below is held');
});

test('changes inside a section, such as map tiles or a redrawn chart, schedule no scan', () => {
  const map = below(['.overview-grid > *'], 200);
  const tiles = map.child(['.leaflet-tile-pane']);
  const page = browser({ elements: [map] });
  page.start();
  const [mutations] = page.mutations;
  mutations.report(tiles, map);
  assert.equal(page.frames.size, 0, 'satellite playback never rescans the page');
  // A change in the page itself, where panels mount, still does.
  mutations.report(tiles, new Element(['main']));
  assert.equal(page.frames.size, 1);
});

test('nothing is held back under reduced motion or without IntersectionObserver', () => {
  for (const options of [{ reduced: true }, { intersection: false }]) {
    const section = below(['.sources-panel'], 2000);
    const page = browser({ ...options, elements: [section] });
    const stop = page.start();
    assert.equal(section.getAttribute('data-reveal'), null, JSON.stringify(options));
    assert.equal(page.intersections.length, 0);
    stop();
  }
  // Reduced motion also leaves the cards still.
  const reduced = browser({ reduced: true });
  reduced.start();
  assert.equal(reduced.doc.count(), 0, 'no pointer or focus listeners');
});

test('focus that reaches a held section, and printing, show it at once', () => {
  const briefing = below(['.offline-briefing'], 1800);
  const sources = below(['.sources-panel'], 2600);
  const footer = below(['.footer'], 3000);
  const page = browser({ elements: [briefing, sources, footer] });
  /** The section's inline transition at the moment it is marked shown. */
  const transitionWhenShown = (section: Element) => {
    const marks: (string | undefined)[] = [];
    const set = section.setAttribute;
    section.setAttribute = (name: string, value: string) => {
      if (name === 'data-reveal' && value === 'shown')
        marks.push(section.properties.get('transition'));
      set(name, value);
    };
    return marks;
  };
  const focused = transitionWhenShown(briefing);
  const scrolled = transitionWhenShown(footer);
  const flushes: unknown[] = [];
  Object.assign(page.win, {
    getComputedStyle: (element: unknown) => (flushes.push(element), { opacity: '1' }),
  });
  page.start();
  page.doc.send('focusin', { target: briefing.child() });
  assert.equal(briefing.getAttribute('data-reveal'), 'shown');
  assert.equal(sources.getAttribute('data-reveal'), 'pending', 'focus elsewhere leaves it');
  // The focused control is shown as it is: no fade or rise under the focus ring. The shown state
  // is applied (a style read) before the stylesheet's transitions come back.
  assert.deepEqual(focused, ['none'], 'transitions are off when it is shown');
  assert.deepEqual(flushes, [briefing], 'the shown state is applied before they come back');
  assert.equal(briefing.properties.has('transition'), false, 'and then handed back');
  // A section scrolled into view still fades in.
  page.intersections[0].enter(footer);
  assert.deepEqual(scrolled, [undefined]);
  page.win.send('beforeprint', {});
  assert.equal(sources.getAttribute('data-reveal'), 'shown');
});

test('focus that lands in a section still fading in ends the fade at once', () => {
  // Tab scrolls the next control into view: its section can start fading in a moment before
  // focus reaches it. The fade (opacity and rise) ends there and then; a lean is left alone.
  const banner = below(['.preparedness-banner'], 1800);
  const finished: string[] = [];
  const transition = (property: string) => ({
    transitionProperty: property,
    finish: () => void finished.push(property),
  });
  Object.assign(banner, {
    getAnimations: () => ['opacity', 'translate', 'transform'].map(transition),
  });
  const page = browser({ elements: [banner] });
  page.start();
  page.intersections[0].enter(banner);
  assert.equal(banner.getAttribute('data-reveal'), 'shown', 'scrolled into view: it fades in');
  assert.deepEqual(finished, []);
  page.doc.send('focusin', { target: banner.child().child(['a']) });
  assert.deepEqual(finished, ['opacity', 'translate'], 'the fade ends; the lean is left alone');
  // Focus elsewhere on the page touches no section.
  finished.length = 0;
  page.doc.send('focusin', { target: new Element(['main']) });
  assert.deepEqual(finished, []);
});

test('without matchMedia, motion starts nothing and hides nothing', () => {
  const section = below(['.sources-panel'], 2000);
  const page = browser({ elements: [section] });
  Object.assign(page.win, { matchMedia: undefined });
  const stop = page.start();
  assert.equal(section.getAttribute('data-reveal'), null);
  assert.equal(page.intersections.length + page.mutations.length, 0);
  assert.equal(page.doc.count() + page.win.count(), 0, 'no listeners');
  stop();
});

test('panels that mount later are held too, with one layout read per frame', () => {
  const page = browser();
  page.start();
  const [mutations] = page.mutations;
  assert.equal(mutations.target, page.doc.body, 'the whole page is watched for new panels');
  const reports = below(['.disaster-watch'], 2200);
  page.elements.push(reports);
  mutations.report();
  mutations.report();
  assert.equal(page.frames.size, 1, 'mutations in one frame share a single scan');
  assert.equal(reports.getAttribute('data-reveal'), null, 'nothing is read before the frame');
  page.flush();
  assert.equal(reports.getAttribute('data-reveal'), 'pending');
  // A section that is removed while held is no longer watched.
  reports.isConnected = false;
  mutations.report();
  page.flush();
  assert.equal(page.intersections[0].observed.size, 0);
});

test('a fine pointer leans the card under it, writing at most once per frame', () => {
  const card = new Element(['.sources-grid > div'], {
    left: 100,
    top: 100,
    width: 260,
    height: 160,
  });
  const page = browser({ elements: [card] });
  page.start();
  // Passive listeners never hold up scrolling while the pointer moves over the page.
  assert.ok(page.doc.passive('pointermove'), 'pointermove is passive');
  assert.ok(page.doc.passive('pointerleave'), 'pointerleave is passive');
  const text = card.child(['.text']);
  page.doc.send('pointermove', pointer(text, 330, 120));
  page.doc.send('pointermove', pointer(text, 360, 100));
  assert.equal(page.frames.size, 1, 'pointer moves within a frame share one write');
  assert.equal(card.getAttribute('data-tilt'), null, 'nothing is written before the frame');
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), '');
  // The latest position, the top-right corner, leans the card fully right and back.
  const tilt = tiltFor(card.box, 360, 100)!;
  for (const name of TILT_PROPERTIES) assert.equal(card.properties.get(name), tilt[name], name);
  assert.equal(tilt['--tilt-ry'], `${MAX_TILT.toFixed(2)}deg`);
  assert.equal(tilt['--tilt-rx'], `${MAX_TILT.toFixed(2)}deg`);
  // pointerleave does not bubble, so it is heard while capturing. Leaving the text for the
  // card's own padding keeps the lean; leaving the card ends it.
  assert.ok(page.doc.capturing('pointerleave'));
  page.doc.send('pointerleave', { target: text });
  assert.equal(card.getAttribute('data-tilt'), '', 'still over the card');
  page.doc.send('pointerleave', { target: card });
  assert.equal(card.getAttribute('data-tilt'), null);
  assert.equal(card.properties.size, 0, 'every custom property is removed');
});

test('the lean moves to the next card, and never follows touch or a pointer with a button held', () => {
  const first = new Element(['.disaster-card'], { left: 0, top: 0, width: 200, height: 200 });
  const second = new Element(['.disaster-card'], { left: 220, top: 0, width: 200, height: 200 });
  const page = browser({ elements: [first, second] });
  page.start();
  page.doc.send('pointermove', pointer(first, 50, 50));
  page.flush();
  assert.equal(first.getAttribute('data-tilt'), '');
  page.doc.send('pointermove', pointer(second, 300, 50));
  assert.equal(first.getAttribute('data-tilt'), null, 'the previous card is released at once');
  page.flush();
  assert.equal(second.getAttribute('data-tilt'), '');
  // Selecting text drags with a button held down: the card stays still for it.
  page.doc.send('pointermove', pointer(second, 310, 60, { buttons: 1 }));
  assert.equal(second.getAttribute('data-tilt'), null);
  page.flush();
  assert.equal(second.getAttribute('data-tilt'), null);
  page.doc.send('pointermove', pointer(first, 50, 50, { pointerType: 'touch' }));
  page.flush();
  assert.equal(first.getAttribute('data-tilt'), null, 'touch never tilts');
  // A pen hovering on a fine-pointer device leans the card as a mouse does.
  page.doc.send('pointermove', pointer(first, 60, 40, { pointerType: 'pen' }));
  page.flush();
  assert.equal(first.getAttribute('data-tilt'), '', 'a hovering pen tilts');
  // Over anything that is not a card (here the warnings below the cards), nothing leans.
  page.doc.send('pointermove', pointer(new Element(['.alerts-panel']), 60, 400));
  page.flush();
  assert.equal(page.elements.filter((e) => e.getAttribute('data-tilt') !== null).length, 0);
});

test('a card keeps its lean while the pointer stays inside the box it had at rest', () => {
  // Leaning lifts a card and pulls its far edge in, so a pointer near an edge can end up over
  // whatever lies behind the card while it has not moved at all. Hit-testing the leaning card
  // flattened it under the pointer and leaned it again, flickering at every edge.
  const grid = new Element(['.sources-grid']);
  const rest = { left: 100, top: 100, width: 400, height: 200 };
  const card = new Element(['.sources-grid > div'], { ...rest });
  card.parent = grid;
  const page = browser({ elements: [card] });
  page.start();
  page.doc.send('pointermove', pointer(card.child(), 480, 280));
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), '');
  // Leaning, the card's box on screen is smaller and higher than at rest.
  card.box = { left: 106, top: 97, width: 388, height: 196 };
  page.doc.send('pointerleave', { ...pointer(card, 497, 298), relatedTarget: grid });
  assert.equal(card.getAttribute('data-tilt'), '', 'off the moved edge, inside the box at rest');
  page.doc.send('pointermove', pointer(grid, 498, 299));
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), '', 'a move over the grid there keeps the lean');
  // The lean is computed from the box at rest, not from the leaning card it would feed back into.
  const tilt = tiltFor(rest, 498, 299)!;
  for (const name of TILT_PROPERTIES) assert.equal(card.properties.get(name), tilt[name], name);
  // Leaving the box at rest ends it.
  page.doc.send('pointermove', pointer(grid, 503, 299));
  assert.equal(card.getAttribute('data-tilt'), null);
  assert.equal(card.properties.size, 0);
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), null, 'and nothing leans it again');
  // A pointerleave outside the box at rest ends it too.
  card.box = { ...rest };
  page.doc.send('pointermove', pointer(card, 300, 200));
  page.flush();
  page.doc.send('pointerleave', { ...pointer(card, 99, 200), relatedTarget: grid });
  assert.equal(card.getAttribute('data-tilt'), null);
});

test('the lean ends when the pointer leaves the window, the page scrolls away or the layout changes', () => {
  const rest = { left: 100, top: 100, width: 400, height: 200 };
  const card = new Element(['.disaster-card'], { ...rest });
  const page = browser({ elements: [card] });
  page.start();
  const lean = () => {
    card.box = { ...rest, top: rest.top - page.win.scrollY };
    page.doc.send('pointermove', pointer(card, 300, 150));
    page.flush();
    assert.equal(card.getAttribute('data-tilt'), '');
  };
  lean();
  // Out of the window through the card's moved edge: the document hears that leave.
  page.doc.send('pointerleave', {
    ...pointer(page.doc.documentElement, 300, 299),
    relatedTarget: null,
  });
  assert.equal(card.getAttribute('data-tilt'), null, 'left the window');
  // Scrolling moves the card under a still pointer: the lean follows it while the pointer is
  // inside its box, and ends once it is not.
  lean();
  page.win.scrollY = 40;
  page.win.send('scroll', {});
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), '', 'still under the pointer');
  assert.equal(
    card.properties.get('--tilt-rx'),
    tiltFor({ ...rest, top: 60 }, 300, 150)!['--tilt-rx'],
  );
  page.win.scrollY = 260;
  page.win.send('scroll', {});
  assert.equal(card.getAttribute('data-tilt'), null, 'scrolled out from under the pointer');
  page.win.scrollY = 0;
  lean();
  page.win.send('resize', {});
  assert.equal(card.getAttribute('data-tilt'), null, 'a new layout reads the box again');
  assert.ok(page.win.passive('scroll') && page.win.passive('resize'), 'passive listeners');
});

test('plugging in a mouse while the page is open starts the tilt, and unplugging it stops it', () => {
  const card = new Element(['.conditions-card'], { left: 0, top: 0, width: 300, height: 300 });
  const page = browser({ fine: false, elements: [card] });
  page.start();
  page.doc.send('pointermove', pointer(card, 280, 20));
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), null, 'a touch screen: no tilt');
  page.prefer('(hover: hover) and (pointer: fine)', true);
  page.doc.send('pointermove', pointer(card, 280, 20));
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), '', 'a mouse is plugged in');
  page.prefer('(hover: hover) and (pointer: fine)', false);
  assert.equal(card.getAttribute('data-tilt'), null, 'unplugged: the card is released');
  assert.equal(page.doc.capturing('pointerleave'), false, 'and nothing listens for the pointer');
  for (const type of ['pointermove', 'scroll', 'resize'])
    assert.equal(page.doc.has(type) || page.win.has(type), false, type);
});

test('cards stay flat in Data saver and Offline only, and lean again in Full workspace', () => {
  // App's shell carries .field-mode in those modes; a mode change swaps the class in place.
  const shell = new Element(['.app-shell', '.field-mode']);
  const card = new Element(['.conditions-card'], { left: 0, top: 0, width: 400, height: 500 });
  card.parent = shell;
  const page = browser({ elements: [card] });
  page.start();
  page.doc.send('pointermove', pointer(card, 380, 20));
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), null, 'no 3D in field mode');
  assert.equal(card.properties.size, 0);
  shell.names.splice(shell.names.indexOf('.field-mode'), 1);
  page.doc.send('pointermove', pointer(card, 380, 20));
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), '', 'Full workspace');
  shell.names.push('.field-mode');
  page.doc.send('pointermove', pointer(card, 370, 30));
  assert.equal(card.getAttribute('data-tilt'), null, 'released as soon as the mode changes');
});

test('the scroll reveal runs in every connection mode, as motion.ts says; only the tilt is Full', () => {
  // It downloads nothing, so Data saver and Offline only fade sections in as Full workspace does.
  const shell = new Element(['.app-shell', '.field-mode']);
  const section = below(['.sources-panel'], 1800);
  section.parent = shell;
  const page = browser({ elements: [section] });
  page.start();
  assert.equal(section.getAttribute('data-reveal'), 'pending', 'held in field mode too');
  page.intersections[0].enter(section);
  assert.equal(section.getAttribute('data-reveal'), 'shown');
});

test('coarse pointers get no tilt at all', () => {
  const page = browser({ fine: false });
  page.start();
  assert.equal(page.doc.capturing('pointerleave'), false);
  page.doc.send('pointermove', pointer(new Element(['.conditions-card']), 10, 10));
  assert.equal(page.frames.size, 0);
});

test('choosing reduced motion while open shows every held section and stops the tilt', () => {
  const sources = below(['.sources-panel'], 2600);
  const card = new Element(['.preparedness-banner'], { left: 0, top: 0, width: 800, height: 140 });
  const page = browser({ elements: [sources, card] });
  page.start();
  page.doc.send('pointermove', pointer(card, 700, 20));
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), '');
  page.doc.send('pointermove', pointer(card, 710, 30));
  page.prefer('(prefers-reduced-motion: reduce)', true);
  assert.equal(sources.getAttribute('data-reveal'), 'shown');
  assert.equal(card.getAttribute('data-tilt'), null);
  assert.equal(card.properties.size, 0);
  assert.equal(page.frames.size, 0, 'a pending write is cancelled');
  assert.ok(page.intersections[0].disconnected);
  assert.ok(page.mutations[0].disconnected);
  assert.equal(page.doc.count(), 0, 'pointer and focus listeners are gone');
  // Allowing motion again starts it again, but a section already shown is never hidden again;
  // one that mounts afterwards below the fold is held as usual.
  page.prefer('(prefers-reduced-motion: reduce)', false);
  assert.equal(sources.getAttribute('data-reveal'), 'shown');
  const later = below(['.footer'], 3200);
  page.elements.push(later);
  page.mutations.at(-1)!.report();
  page.flush();
  assert.equal(later.getAttribute('data-reveal'), 'pending');
  page.doc.send('pointermove', pointer(card, 100, 20));
  page.flush();
  assert.equal(card.getAttribute('data-tilt'), '');
});

test('stopping removes every listener and observer and shows every section', () => {
  const footer = below(['.footer'], 3000);
  const page = browser({ elements: [footer] });
  const stop = page.start();
  assert.ok(page.queryListeners() > 0);
  stop();
  assert.equal(footer.getAttribute('data-reveal'), 'shown');
  assert.equal(page.doc.count() + page.win.count() + page.queryListeners(), 0);
  assert.ok(page.intersections[0].disconnected && page.mutations[0].disconnected);
});

test('tilt follows the pointer, and larger cards lean less', () => {
  const box = { left: 0, top: 0, width: 200, height: 200 };
  const centre = tiltFor(box, 100, 100)!;
  assert.equal(centre['--tilt-rx'], '0.00deg');
  assert.equal(centre['--tilt-ry'], '0.00deg');
  assert.equal(centre['--glare-x'], '50.0%');
  const corner = tiltFor(box, 0, 200)!;
  assert.equal(corner['--tilt-ry'], `-${MAX_TILT.toFixed(2)}deg`, 'left edge leans left');
  assert.equal(corner['--tilt-rx'], `-${MAX_TILT.toFixed(2)}deg`, 'bottom edge leans forward');
  assert.equal(corner['--tilt-px'], '-1.000');
  // Outside the card the values stop at its edge.
  assert.deepEqual(tiltFor(box, -50, 400), corner);
  // A card twice as wide as the reference leans half as far.
  const wide = tiltFor({ left: 0, top: 0, width: 520, height: 200 }, 520, 100)!;
  assert.equal(wide['--tilt-ry'], `${(MAX_TILT / 2).toFixed(2)}deg`);
  assert.equal(tiltFor({ left: 0, top: 0, width: 0, height: 100 }, 0, 0), null);
});

test('warnings and the interactive map and chart never tilt; whole sections are revealed', () => {
  for (const surface of [
    '.alerts-panel',
    '.official-alert',
    '.map-card',
    '.forecast-panel',
    '.field-forecast',
  ])
    assert.ok(!parts(TILT_SELECTOR).includes(surface), surface);
  for (const section of [
    '.analytics-grid > .panel',
    '.offline-briefing',
    '.sources-panel',
    '.footer',
  ])
    assert.ok(parts(REVEAL_SELECTOR).includes(section), section);
});

test('the 3D globe card is never held back or tilted', () => {
  // It keeps its size from the first paint, and picking a point on the globe reads boxes that do
  // not move. It sits directly in the page, outside every revealed section and tilted card.
  for (const part of [...parts(REVEAL_SELECTOR), ...parts(TILT_SELECTOR)])
    assert.doesNotMatch(part, /globe|^main > |^\*$|^section$|^\.panel$/, part);
  const slot = below(['.globe-slot'], 1200);
  const view = slot.child(['.globe-view']);
  const page = browser({ elements: [slot, view] });
  page.start();
  page.mutations[0].report();
  page.flush();
  page.doc.send('pointermove', pointer(view, 100, 1300));
  page.flush();
  for (const element of [slot, view]) {
    assert.equal(element.getAttribute('data-reveal'), null);
    assert.equal(element.getAttribute('data-tilt'), null);
  }
});
