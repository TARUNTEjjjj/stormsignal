import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  Matrix4,
  Vector3,
  Vector4,
  type Camera,
  type Color,
  type DataTexture,
  type Material,
  type Mesh,
  type Object3D,
  type Points,
  type ShaderMaterial,
  type Texture,
} from 'three';
import {
  AUTO_ROTATE_MS,
  DAILY_OPACITY,
  HOME_GLIDE_MS,
  SETTLE_MS,
  angularDistance,
  latLonToVector,
  outlineSegments,
  pointPlace,
  segmentsCentroid,
  sunDirection,
  vectorToLatLon,
  type GlobeViewState,
  type LatLon,
  type Vector,
} from '../src/globe';
import { createGlobe, loadThree, type GlobeEvents, type ThreeKit } from '../src/globe-scene';
import type { Place } from '../src/types';

// The globe's scene on three.js itself, in Node: everything but the renderer, which alone needs a
// GPU, is real (the scene graph, the camera, OrbitControls, the materials). The browser around it
// is a stand-in: elements, a display that refreshes at 60 Hz, a page clock and the timers.
const three = await loadThree();

class FakeRenderer {
  static made: FakeRenderer[] = [];
  renders = 0;
  disposed = 0;
  forcedLoss = 0;
  fail = false;
  scene: Object3D | null = null;
  camera: Camera | null = null;
  /** Where the camera stood in the last frame drawn: what the viewer saw. */
  seen: Vector | null = null;
  /** The drawing buffer: the stage's size in CSS pixels, times the device pixels in each one. */
  pixelRatio = 1;
  size = { width: 0, height: 0 };
  /**
   * The textures handed to the GPU, in order, by WebGLRenderer's rule: a frame that draws a
   * texture uploads it once it is marked for upload (needsUpdate), and again only when it is
   * marked again. One never marked never reaches the GPU: its sampler reads three.js's own empty
   * texture instead.
   */
  uploads: Texture[] = [];
  private uploaded = new Map<Texture, number>();
  capabilities = { getMaxAnisotropy: () => 16 };
  constructor() {
    FakeRenderer.made.push(this);
  }
  setClearColor() {}
  setPixelRatio(ratio: number) {
    this.pixelRatio = ratio;
  }
  setSize(width: number, height: number) {
    this.size = { width, height };
  }
  render(scene: Object3D, camera: Camera) {
    if (this.fail) throw new Error('A frame could not be drawn.');
    this.renders++;
    this.scene = scene;
    this.camera = camera;
    this.seen = camera.position.toArray() as Vector;
    scene.traverseVisible((object) => {
      const uniforms = ((object as Mesh).material as ShaderMaterial | undefined)?.uniforms ?? {};
      for (const { value } of Object.values(uniforms)) {
        const texture = value as Texture | null;
        if (!texture?.isTexture || texture.version === 0) continue;
        if (this.uploaded.get(texture) === texture.version) continue;
        this.uploaded.set(texture, texture.version);
        this.uploads.push(texture);
      }
    });
  }
  dispose() {
    this.disposed++;
  }
  forceContextLoss() {
    this.forcedLoss++;
  }
}

/** An EventTarget that knows the listeners it holds (a removal of one it never had is no-op). */
class Target extends EventTarget {
  private held: { type: string; listener: unknown; capture: boolean }[] = [];
  get listening() {
    return this.held.length;
  }
  private find(type: string, listener: unknown, options?: boolean | EventListenerOptions) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    return {
      capture,
      index: this.held.findIndex(
        (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
      ),
    };
  }
  addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    const [type, listener, options] = args;
    const { capture, index } = this.find(type, listener, options);
    if (listener && index < 0) this.held.push({ type, listener, capture });
    super.addEventListener(...args);
  }
  removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    const [type, listener, options] = args;
    const { index } = this.find(type, listener, options);
    if (index >= 0) this.held.splice(index, 1);
    super.removeEventListener(...args);
  }
}

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});
function install(name: string, value: unknown, on: object = globalThis) {
  const before = Object.getOwnPropertyDescriptor(on, name);
  Object.defineProperty(on, name, { value, configurable: true, writable: true });
  restore.push(() => {
    if (before) Object.defineProperty(on, name, before);
    else delete (on as Record<string, unknown>)[name];
  });
}

const chennai: Place = {
  id: 'chennai',
  name: 'Chennai',
  country: 'India',
  countryCode: 'IN',
  latitude: 13.0827,
  longitude: 80.2707,
};
const london: Place = {
  id: 'london',
  name: 'London',
  country: 'United Kingdom',
  countryCode: 'GB',
  latitude: 51.5072,
  longitude: -0.1276,
};

/** One globe in a stand-in browser, and the means to let time pass. */
/**
 * One globe in a stand-in browser. `prompt`: a refresh asked for between two is handed out at once,
 * stamped with the last refresh if that one is unused, as Chrome does; otherwise at the next one.
 * `pixels`: the screen's device pixels for each CSS pixel (window.devicePixelRatio), or null for a
 * browser that does not say.
 */
function scene({ prompt = false, pixels = 2 as number | null } = {}) {
  let time = 1_000;
  /** The last display refresh, and the last one handed out. */
  let refresh = time;
  let used = -Infinity;
  let wall = Date.parse('2026-11-19T07:30:00Z');
  let handle = 0;
  const frames = new Map<number, (time: number) => void>();
  const timers = new Map<number, { run: () => void; ms: number; due: number; once?: boolean }>();
  let refreshesAsked = 0;
  const document = Object.assign(new Target(), { visibilityState: 'visible' });
  const box = () => ({ left: 0, top: 0, width: 900, height: 700, right: 900, bottom: 700 });
  let removed = 0;
  const canvas = Object.assign(new Target(), {
    style: {} as Record<string, string>,
    ownerDocument: document,
    clientHeight: 700,
    getBoundingClientRect: box,
    setPointerCapture() {},
    releasePointerCapture() {},
    remove: () => void removed++,
  });
  const stage = Object.assign(new Target(), { getBoundingClientRect: box });
  const appended: unknown[] = [];
  const host = { append: (child: unknown) => void appended.push(child) };
  const label = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const observers = { resize: 0, view: 0 };
  let inView: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  install('document', document);
  install('window', {
    ...(pixels === null ? {} : { devicePixelRatio: pixels }),
    setInterval: (run: () => void, ms: number) => {
      timers.set(++handle, { run, ms, due: time + ms });
      return handle;
    },
    clearInterval: (id: number) => void timers.delete(id),
    setTimeout: (run: () => void, ms: number) => {
      timers.set(++handle, { run, ms, due: time + ms, once: true });
      return handle;
    },
    clearTimeout: (id: number) => void timers.delete(id),
  });
  install('requestAnimationFrame', (callback: (time: number) => void) => {
    refreshesAsked++;
    frames.set(++handle, callback);
    return handle;
  });
  install('cancelAnimationFrame', (id: number) => void frames.delete(id));
  install('getComputedStyle', () => ({
    getPropertyValue: (name: string) =>
      ({ '--aurora-teal': '#3EE6C1', '--aurora-violet': '#8B7CFF' })[name] ?? '',
  }));
  install(
    'ResizeObserver',
    class {
      constructor() {
        observers.resize++;
      }
      observe() {}
      disconnect() {
        observers.resize--;
      }
    },
  );
  install(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        observers.view++;
        inView = callback;
      }
      observe() {}
      disconnect() {
        observers.view--;
      }
    },
  );
  install('now', () => time, performance);
  const log: string[] = [];
  const picked: Place[] = [];
  const events: GlobeEvents = {
    interact: () => void log.push('interact'),
    turned: () => void log.push('turned'),
    pick: (place) => {
      log.push(`pick ${place.name}`);
      picked.push(place);
    },
    wheel: () => void log.push('wheel'),
    zoomed: (closer) => void log.push(`zoomed ${closer}`),
    lost: () => void log.push('lost'),
    restored: () => void log.push('restored'),
    failed: () => void log.push('failed'),
  };
  const kit = { ...three, WebGLRenderer: FakeRenderer } as unknown as ThreeKit;
  const context = { isContextLost: () => false };
  const globe = createGlobe(
    kit,
    { canvas, context } as never,
    stage as never,
    host as never,
    label as never,
    events,
    { clock: () => wall },
  );
  assert.ok(globe, 'the scene starts on the stand-in renderer');
  const renderer = FakeRenderer.made[FakeRenderer.made.length - 1];
  /** Lets `ms` pass on a display refreshing at `hz`: due timers run, then any frame asked for. */
  /** Runs the animation frames asked for, stamped with refresh `stamp`. */
  const handOut = (stamp: number) => {
    used = stamp;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(stamp);
  };
  /**
   * Lets `ms` pass on a display refreshing at `hz`: timers run when they are due, and the frames
   * asked for at the next refresh (or at once, when `prompt` and the last refresh is unused).
   */
  const run = (ms: number, hz = 60) => {
    const end = time + ms + 1e-6;
    for (;;) {
      const next = refresh + 1000 / hz;
      let due = Infinity;
      for (const timer of timers.values()) due = Math.min(due, timer.due);
      if (Math.min(next, due) > end) break;
      if (due < next) {
        time = due;
        for (const [id, timer] of [...timers])
          if (timer.due <= time) {
            if (timer.once) timers.delete(id);
            else timer.due += timer.ms;
            timer.run();
          }
        if (prompt && frames.size && refresh > used) handOut(refresh);
      } else {
        time = refresh = next;
        if (frames.size) handOut(refresh);
      }
    }
    time = end - 1e-6;
  };
  /** The material with `uniform` in the last frame drawn. */
  const shader = (uniform: string, what: string) => {
    let found: ShaderMaterial | null = null;
    renderer.scene?.traverse((object) => {
      const material = (object as Mesh).material as ShaderMaterial | undefined;
      if (material?.uniforms?.[uniform]) found = material;
    });
    assert.ok(found, `${what} in the scene`);
    return found as ShaderMaterial;
  };
  const material = () => shader('baseMap', 'the earth is');
  const stars = () => shader('twinkle', 'the stars are');
  const glow = () => shader('edge', 'the glow round the globe is');
  /** How far the view's centre is from the place, in degrees. */
  const offPlace = (place: LatLon = chennai) => angularDistance(globe.centre(), place);
  /** The view the last frame drawn showed: its centre and the camera's distance. */
  const seen = (): GlobeViewState => {
    assert.ok(renderer.seen, 'a frame was drawn');
    return { ...vectorToLatLon(renderer.seen), distance: Math.hypot(...renderer.seen) };
  };
  /** Timers waiting to ask for the next frame (the sun's minute is the only one that repeats). */
  const waits = () => [...timers.values()].filter(({ once }) => once).length;
  return {
    globe,
    renderer,
    canvas,
    stage,
    document,
    label,
    log,
    picked,
    frames,
    timers,
    observers,
    run,
    material,
    stars,
    glow,
    offPlace,
    seen,
    waits,
    removed: () => removed,
    refreshesAsked: () => refreshesAsked,
    setWall: (value: number) => void (wall = value),
    view: (visible: boolean) => inView?.([{ isIntersecting: visible }]),
  };
}
/** A pointer event as OrbitControls and the scene read it. */
function pointer(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  return Object.assign(new Event(type), {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    ...extra,
  });
}
/** A mouse drag across the middle of the globe, `pixels` to the left, over ten refreshes. */
function drag(s: ReturnType<typeof scene>, pixels = 200) {
  s.canvas.dispatchEvent(pointer('pointerdown', 450, 350));
  for (let step = 1; step <= 10; step++) {
    s.document.dispatchEvent(pointer('pointermove', 450 - (step * pixels) / 10, 350));
    s.run(16);
  }
  s.document.dispatchEvent(pointer('pointerup', 450 - pixels, 350));
  s.canvas.dispatchEvent(pointer('pointerup', 450 - pixels, 350));
}
/** A pointer event the browser stamped at `time` ms: the stamps tell a tap from a press. */
function stamped(
  type: string,
  x: number,
  y: number,
  time: number,
  extra: Record<string, unknown> = {},
) {
  const event = pointer(type, x, y, extra);
  Object.defineProperty(event, 'timeStamp', { value: time });
  return event;
}
/** A pointer let go at (x, y): on the canvas, then on the document, where it bubbles. */
function lift(
  s: ReturnType<typeof scene>,
  x: number,
  y: number,
  time: number,
  extra: Record<string, unknown> = {},
) {
  s.canvas.dispatchEvent(stamped('pointerup', x, y, time, extra));
  s.document.dispatchEvent(stamped('pointerup', x, y, time, extra));
}
/** A mouse click on the globe at (x, y): pressed and let go on the spot, 120 ms later. */
function tap(s: ReturnType<typeof scene>, x: number, y: number) {
  s.canvas.dispatchEvent(stamped('pointerdown', x, y, 5_000));
  lift(s, x, y, 5_120);
}
/** Asserts that two views share their centre. */
function sameCentre(actual: LatLon, expected: LatLon, what: string) {
  const off = angularDistance(actual, expected);
  assert.ok(off < 0.01, `${what}: ${off}° from where it should be`);
}

test('the globe turns by itself for a minute, then glides back to the selected place and rests', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, true);
  assert.ok(s.offPlace() < 0.01, 'it starts on the place');
  s.run(30_000);
  // 1.2° a second: well away by now, and still on the near side of the planet.
  assert.ok(s.offPlace() > 25 && s.offPlace() < 45, `${s.offPlace()}° after 30 s`);
  s.run(AUTO_ROTATE_MS - 30_000 - 500);
  assert.ok(s.offPlace() > 55 && s.offPlace() < 74, `${s.offPlace()}° near the end`);
  assert.equal(s.label.dataset.hidden, 'false', 'the place is still on the near side');
  // Its minute over, the globe glides back to the place, and rests there.
  s.run(500 + HOME_GLIDE_MS + 200);
  assert.ok(s.offPlace() < 0.05, `${s.offPlace()}° from the place at rest`);
  assert.equal(s.label.dataset.hidden, 'false', 'its label is shown');
  s.run(SETTLE_MS);
  const drawn = s.renderer.renders;
  s.run(120_000);
  // At rest it draws one frame a minute, as the sun moves on, and nothing else.
  assert.ok(s.renderer.renders - drawn <= 2, `${s.renderer.renders - drawn} frames in 2 minutes`);
  assert.equal(s.frames.size, 0);
  assert.ok(s.offPlace() < 0.05, 'and stays on the place');
});

test('a change restarts the pulse, not the turning; Play turns it for another minute', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, true);
  s.run(AUTO_ROTATE_MS + HOME_GLIDE_MS + SETTLE_MS + 1000);
  const drawn = s.renderer.renders;
  // A new mosaic: the pulse runs for a while, the view stays on the place.
  s.globe.setImage('daily', { width: 2048, height: 1024 } as unknown as TexImageSource);
  s.run(SETTLE_MS + 2000);
  assert.ok(s.renderer.renders > drawn, 'the change is drawn');
  assert.ok(s.offPlace() < 0.05, 'no turning');
  assert.equal(s.frames.size, 0, 'and it rests again');
  s.globe.setDailyVisible(false);
  s.run(SETTLE_MS + 2000);
  assert.ok(s.offPlace() < 0.05);
  // Pause, then Play: it turns again, and comes back on the minute. The same motion asked for
  // again while it turns does not start the minute over.
  s.globe.setMotion(false, false);
  s.globe.setMotion(true, true);
  s.run(30_000);
  assert.ok(s.offPlace() > 5, 'turning after Play');
  s.globe.setMotion(true, true);
  s.run(AUTO_ROTATE_MS - 30_000 + HOME_GLIDE_MS + 200);
  assert.ok(s.offPlace() < 0.05, `${s.offPlace()}°: home on the minute`);
});

test('a globe the user takes in hand stops turning, and is never pulled back', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, true);
  s.run(5_000);
  // A drag across the globe.
  s.canvas.dispatchEvent(pointer('pointerdown', 450, 350));
  for (let step = 1; step <= 10; step++) {
    s.document.dispatchEvent(pointer('pointermove', 450 - step * 20, 350));
    s.run(16);
  }
  s.document.dispatchEvent(pointer('pointerup', 250, 350));
  s.canvas.dispatchEvent(pointer('pointerup', 250, 350));
  assert.ok(s.log.includes('interact'), 'OrbitControls reported the drag');
  s.run(3_000);
  const centre = s.globe.centre();
  s.run(AUTO_ROTATE_MS + HOME_GLIDE_MS + 5_000);
  assert.ok(angularDistance(s.globe.centre(), centre) < 0.01, 'it stays where the user left it');
  assert.ok(s.offPlace() > 1);
});

for (const prompt of [false, true])
  test(`turning by itself is drawn 30 times a second, a drag or a fly-to at every refresh${prompt ? ' (refreshes handed out at once)' : ''}`, () => {
    const s = scene({ prompt });
    s.globe.setPlace(chennai);
    s.globe.setMotion(true, true);
    s.run(1000);
    let drawn = s.renderer.renders;
    const asked = s.refreshesAsked();
    s.run(10_000);
    const turning = (s.renderer.renders - drawn) / 10;
    assert.ok(turning >= 29 && turning <= 31, `${turning} frames a second while turning`);
    // Between frames it waits on a timer, so a display that hands out the next refresh is woken
    // once a frame. One that hands out a refresh at once, stamped with the one in between, is
    // asked twice: still no more than its refresh rate.
    const woken = (s.refreshesAsked() - asked) / 10;
    assert.ok(woken <= (prompt ? 61 : 31), `${woken} refreshes asked for a second`);
    // At 120 Hz too.
    drawn = s.renderer.renders;
    s.run(2_000, 120);
    assert.ok((s.renderer.renders - drawn) / 2 <= 31);
    // A key pressed while it waits is drawn at the very next refresh, not after the wait.
    for (let tick = 0; tick < 4; tick++) {
      const before = s.renderer.renders;
      s.run(1000 / 60);
      if (s.renderer.renders > before) break;
    }
    drawn = s.renderer.renders;
    s.globe.rotate({ kind: 'rotate', latitude: 0, longitude: 10 });
    s.run(1000 / 60);
    assert.equal(s.renderer.renders, drawn + 1, 'drawn at the next refresh');
    // Once at rest, a step of the rotate pad flies at every refresh.
    s.run(AUTO_ROTATE_MS + HOME_GLIDE_MS + SETTLE_MS);
    drawn = s.renderer.renders;
    s.globe.rotate({ kind: 'rotate', latitude: 0, longitude: 10 });
    s.run(250);
    assert.ok(s.renderer.renders - drawn >= 14, `${s.renderer.renders - drawn} frames in 250 ms`);
  });

test('the globe draws only on screen, in a shown tab and with its graphics context', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, true);
  s.run(500);
  let drawn = s.renderer.renders;
  assert.ok(drawn > 0);
  // Scrolled out of view: nothing is asked for or drawn, and the turning does not go on.
  s.view(false);
  assert.equal(s.frames.size, 0);
  s.run(5_000);
  assert.equal(s.renderer.renders, drawn, 'off screen');
  s.view(true);
  s.run(500);
  assert.ok(s.renderer.renders > drawn, 'back on screen');
  // A hidden tab.
  drawn = s.renderer.renders;
  s.document.visibilityState = 'hidden';
  s.document.dispatchEvent(new Event('visibilitychange'));
  s.run(5_000);
  assert.equal(s.renderer.renders, drawn, 'in a hidden tab');
  s.document.visibilityState = 'visible';
  s.document.dispatchEvent(new Event('visibilitychange'));
  s.run(500);
  assert.ok(s.renderer.renders > drawn, 'shown again');
  // The browser takes the graphics context away: the label goes, nothing is drawn, until it is
  // given back.
  drawn = s.renderer.renders;
  const lost = new Event('webglcontextlost', { cancelable: true });
  s.canvas.dispatchEvent(lost);
  assert.ok(lost.defaultPrevented, 'the scene asks for the context back');
  assert.deepEqual(s.log.slice(-1), ['lost']);
  assert.equal(s.label.dataset.hidden, 'true');
  s.run(5_000);
  assert.equal(s.renderer.renders, drawn, 'without a context');
  s.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.deepEqual(s.log.slice(-1), ['restored']);
  s.run(500);
  assert.ok(s.renderer.renders > drawn);
});

test('a frame that fails stops the globe, says so once and frees its graphics memory', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, true);
  s.run(500);
  assert.ok(s.canvas.listening > 0 && s.document.listening > 0 && s.stage.listening > 0);
  s.renderer.fail = true;
  s.run(2_000);
  assert.deepEqual(
    s.log.filter((entry) => entry === 'failed'),
    ['failed'],
  );
  assert.equal(s.label.dataset.hidden, 'true');
  // Released at once, not at Restart: the renderer, its context and canvas, every listener,
  // observer and timer.
  assert.equal(s.renderer.disposed, 1);
  assert.equal(s.renderer.forcedLoss, 1);
  assert.equal(s.removed(), 1);
  assert.equal(s.frames.size, 0);
  assert.equal(s.timers.size, 0);
  assert.deepEqual(s.observers, { resize: 0, view: 0 });
  assert.equal(s.canvas.listening, 0);
  assert.equal(s.document.listening, 0);
  assert.equal(s.stage.listening, 0);
  // Restart disposes the old globe again: nothing happens twice.
  s.globe.dispose();
  assert.equal(s.renderer.disposed, 1);
  s.globe.setImage('base', { width: 2048, height: 1024 } as unknown as TexImageSource);
  s.run(1_000);
  assert.equal(s.frames.size, 0, 'a stopped globe draws nothing more');
});

test('dispose lets go of everything the globe holds, once', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, true);
  s.run(500);
  s.globe.dispose();
  s.globe.dispose();
  assert.equal(s.renderer.disposed, 1);
  assert.equal(s.removed(), 1);
  assert.equal(s.frames.size, 0);
  assert.equal(s.timers.size, 0);
  assert.deepEqual(s.observers, { resize: 0, view: 0 });
  assert.equal(s.canvas.listening, 0);
  assert.equal(s.document.listening, 0);
  assert.equal(s.stage.listening, 0);
});

test('the sun is placed by the clock the globe is given, and moves with it every minute', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  const sun = () => (s.material().uniforms.sun.value as Vector3).toArray();
  const expect = (time: number) =>
    sunDirection(time).forEach((value, axis) =>
      assert.ok(Math.abs(sun()[axis] - value) < 1e-9, `axis ${axis}: ${sun()[axis]} vs ${value}`),
    );
  expect(Date.parse('2026-11-19T07:30:00Z'));
  // The warning source's clock reads six hours on: within a minute the sun follows it.
  const later = Date.parse('2026-11-19T13:30:00Z');
  s.setWall(later);
  s.run(60_000);
  expect(later);
});

test('a wheel turn scrolls the page unless Ctrl or ⌘ is held, which zooms the globe', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  const wheel = (held: Record<string, boolean>) => {
    const event = Object.assign(new Event('wheel'), { ctrlKey: false, metaKey: false, ...held });
    let stopped = false;
    event.stopPropagation = () => void (stopped = true);
    s.stage.dispatchEvent(event);
    return stopped;
  };
  assert.equal(wheel({}), true, 'kept from the globe, so the page scrolls');
  assert.deepEqual(s.log.slice(-1), ['wheel'], 'and the hint shows');
  assert.equal(wheel({ ctrlKey: true }), false, 'Ctrl and scroll zooms');
  assert.equal(wheel({ metaKey: true }), false, '⌘ and scroll zooms');
  assert.equal(s.log.filter((entry) => entry === 'wheel').length, 1);
});

test('the daily mosaic fades in with motion, and goes at once when its image goes', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, false);
  const uniforms = () => s.material().uniforms;
  const image = { width: 2048, height: 1024 } as unknown as TexImageSource;
  s.run(100);
  s.globe.setImage('daily', image);
  s.run(250);
  const mix = uniforms().dailyMix.value as number;
  assert.ok(mix > 0.2 && mix < DAILY_OPACITY, `fading in: ${mix}`);
  s.run(1000);
  assert.equal(uniforms().dailyMix.value, DAILY_OPACITY);
  assert.equal(uniforms().dailyShown.value, 1);
  // The card no longer dates it: nothing of it stays, not even for a frame.
  s.globe.setImage('daily', null);
  assert.equal(uniforms().dailyMix.value, 0);
  assert.equal(uniforms().dailyShown.value, 0);
  // Without motion it appears at once.
  s.globe.setMotion(false, false);
  s.globe.setImage('daily', image);
  s.run(20);
  assert.equal(uniforms().dailyMix.value, DAILY_OPACITY);
  // Hidden with the layer button: it fades out, and its image stays for when it comes back.
  s.globe.setDailyVisible(false);
  s.run(20);
  assert.equal(uniforms().dailyMix.value, 0);
});

// Reduced motion: nothing moves by itself, and nothing the user asks for is animated either.
test('under reduced motion a step, a zoom, Home and a new place land at once, in one frame', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  /** The move is drawn at the next refresh, where it ends, and nothing is drawn after it. */
  const lands = (what: string, move: () => void, check: (view: GlobeViewState) => void) => {
    const drawn = s.renderer.renders;
    move();
    s.run(1000 / 60);
    assert.equal(s.renderer.renders, drawn + 1, `${what}: drawn at the next refresh`);
    check(s.seen());
    s.run(2_000);
    assert.equal(s.renderer.renders, drawn + 1, `${what}: nothing moves after it`);
  };
  let step: LatLon = chennai;
  lands(
    'a step of the rotate pad',
    () => void (step = s.globe.rotate({ kind: 'rotate', latitude: 0, longitude: 30 })),
    (view) => sameCentre(view, step, 'a step'),
  );
  assert.ok(s.offPlace() > 25);
  const distance = s.seen().distance;
  lands(
    'a zoom step',
    () => void s.globe.zoom(1 / 1.25),
    (view) => assert.ok(Math.abs(view.distance - distance / 1.25) < 1e-6, `${view.distance}`),
  );
  lands(
    'Home',
    () => s.globe.reset(),
    (view) => {
      sameCentre(view, chennai, 'Home');
      assert.ok(Math.abs(view.distance - distance) < 1e-6, 'at its starting distance');
    },
  );
  lands(
    'a new place',
    () => void s.globe.setPlace(london),
    (view) => sameCentre(view, london, 'a new place'),
  );
});

test('under reduced motion a drag turns the globe only while the pointer moves: no glide after', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  const stopsWithThePointer = (what: string) => {
    const before = s.globe.centre();
    drag(s);
    const released = s.globe.centre();
    assert.ok(angularDistance(released, before) > 20, `${what}: the drag turned the globe`);
    const drawn = s.renderer.renders;
    s.run(3_000);
    sameCentre(s.globe.centre(), released, `${what}: it stays where the pointer let go`);
    assert.ok(s.renderer.renders - drawn <= 1, `${what}: ${s.renderer.renders - drawn} frames`);
  };
  stopsWithThePointer('a drag');
  // A step of the rotate pad ends any glide a drag left behind; it must not bring one back.
  s.globe.rotate({ kind: 'rotate', latitude: 0, longitude: 10 });
  s.run(100);
  stopsWithThePointer('a drag after a step');
});

test('Pause, or reduced motion switched on, in the middle of a glide lands it at once', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, false);
  s.run(1_000);
  const step = s.globe.rotate({ kind: 'rotate', latitude: 0, longitude: 30 });
  s.run(60);
  assert.ok(angularDistance(s.seen(), step) > 1, 'gliding');
  s.globe.setMotion(false, false);
  s.run(1000 / 60);
  sameCentre(s.seen(), step, 'the next frame shows where the step lands');
  const drawn = s.renderer.renders;
  s.run(2_000);
  sameCentre(s.seen(), step, 'and it stays there');
  assert.ok(s.renderer.renders - drawn <= 1, `${s.renderer.renders - drawn} frames after`);
});

test('the place label hides while the place is on the far side of the globe, and returns with it', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  assert.equal(s.label.dataset.hidden, 'false');
  // Six steps of Shift and an arrow key: half way round, and back.
  const turn = (longitude: number) => {
    for (let step = 0; step < 6; step++) s.globe.rotate({ kind: 'rotate', latitude: 0, longitude });
    s.run(100);
  };
  turn(30);
  assert.ok(s.offPlace() > 120, `${s.offPlace()}° from the place`);
  assert.equal(s.label.dataset.hidden, 'true', 'no label over the far side');
  turn(-30);
  assert.ok(s.offPlace() < 0.05);
  assert.equal(s.label.dataset.hidden, 'false', 'shown over the place again');
});

test('a new place flies the view to it; the same place renamed leaves the view alone', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, false);
  s.run(1_000);
  assert.equal(s.globe.setPlace(london), true, 'the view moves to the new place');
  // Chennai to London is about 74°: a glide of about 0.9 s, half way there in under half a second.
  s.run(450);
  assert.ok(angularDistance(s.seen(), chennai) > 20 && angularDistance(s.seen(), london) > 20);
  s.run(700);
  sameCentre(s.seen(), london, 'at rest on the new place');
  assert.equal(s.label.dataset.hidden, 'false', 'with its label');
  // Renamed, as when a saved place is edited: the view stays where the user turned it.
  s.globe.rotate({ kind: 'rotate', latitude: 0, longitude: 20 });
  s.run(1_000);
  const turned = s.seen();
  assert.equal(s.globe.setPlace({ ...london, name: 'London, UK' }), false);
  s.run(1_500);
  sameCentre(s.seen(), turned, 'a renamed place');
});

test('Home brings the view back over the place at its starting distance', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, false);
  s.run(1_000);
  const start = s.seen();
  s.globe.rotate({ kind: 'rotate', latitude: 20, longitude: 30 });
  s.globe.zoom(1 / 1.25);
  s.run(1_000);
  assert.ok(s.offPlace() > 20 && s.seen().distance < start.distance - 0.5);
  s.globe.reset();
  s.run(1_200);
  sameCentre(s.seen(), chennai, 'Home');
  assert.ok(Math.abs(s.seen().distance - start.distance) < 1e-6, 'at its starting distance');
});

test('quick steps add up: each starts where the last one lands, not where the glide has got to', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, false);
  s.run(1_000);
  // A held arrow key repeats about every 30 ms, well inside a step's quarter-second glide.
  let step: LatLon = chennai;
  for (let press = 0; press < 3; press++) {
    step = s.globe.rotate({ kind: 'rotate', latitude: 0, longitude: 10 });
    s.run(30);
  }
  assert.ok(Math.abs(step.longitude - chennai.longitude - 30) < 1e-9, `${step.longitude}`);
  s.run(1_000);
  sameCentre(s.seen(), step, 'where the third step lands');
});

test('it turns by itself for one minute by the clock, then glides home in a second and a half', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, true);
  s.run(59_000);
  const late = s.globe.centre();
  s.run(500);
  assert.ok(angularDistance(s.globe.centre(), late) > 0.3, 'still turning at 59.5 s');
  // From 60 s it glides back: part way home 0.8 s later, home by 1.6 s, never a jump.
  s.run(500 + 800);
  const part = angularDistance(s.seen(), chennai);
  assert.ok(part > 5 && part < 65, `${part}° from the place 0.8 s into the glide`);
  s.run(800 + 200);
  sameCentre(s.seen(), chennai, 'at rest on the place');
});

test('a vertical swipe over the globe scrolls the page; a sideways one or a pinch turns it', () => {
  const s = scene();
  // OrbitControls takes every touch gesture from the page (touch-action: none). The globe gives
  // vertical pans back, so a phone can scroll past a globe that fills its screen.
  assert.equal(s.canvas.style.touchAction, 'pan-y');
});

const tab = (s: ReturnType<typeof scene>, shown: boolean) => {
  s.document.visibilityState = shown ? 'visible' : 'hidden';
  s.document.dispatchEvent(new Event('visibilitychange'));
};
for (const [where, leave, back] of [
  ['scrolled out of view', (s) => s.view(false), (s) => s.view(true)],
  ['in a hidden tab', (s) => tab(s, false), (s) => tab(s, true)],
] as [string, (s: ReturnType<typeof scene>) => void, (s: ReturnType<typeof scene>) => void][])
  test(`${where}, the globe asks for no frame and keeps no timer but the sun's minute`, () => {
    const s = scene();
    s.globe.setPlace(chennai);
    s.globe.setMotion(true, true);
    s.run(1_000);
    // Turning by itself, it waits on a timer between two frames.
    for (let tick = 0; tick < 4 && !s.waits(); tick++) s.run(1000 / 60);
    assert.equal(s.waits(), 1, 'waiting for the next frame');
    leave(s);
    assert.equal(s.waits(), 0, 'the wait is cancelled');
    assert.equal(s.frames.size, 0, 'no frame is asked for');
    let drawn = s.renderer.renders;
    s.run(5_000);
    assert.equal(s.renderer.renders, drawn, 'nothing is drawn');
    back(s);
    s.run(500);
    assert.ok(s.renderer.renders > drawn, 'drawn again once back');
    // A step of the rotate pad asks for a frame at once: leaving cancels it too.
    s.globe.rotate({ kind: 'rotate', latitude: 0, longitude: 10 });
    assert.equal(s.frames.size, 1);
    leave(s);
    assert.equal(s.frames.size, 0, 'the frame asked for is cancelled');
    drawn = s.renderer.renders;
    s.run(5_000);
    assert.equal(s.renderer.renders, drawn, 'and not drawn');
    assert.equal(s.waits(), 0);
  });

test('a tab shown again draws the sun where it is now, not where it was when it was hidden', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  const sun = () => (s.material().uniforms.sun.value as Vector3).toArray();
  tab(s, false);
  // Six hours on by the clock, before the sun's minute comes round: a browser holds back the
  // timers of a hidden tab.
  const later = Date.parse('2026-11-19T13:30:00Z');
  s.setWall(later);
  s.run(10_000);
  tab(s, true);
  s.run(1000 / 60);
  sunDirection(later).forEach((value, axis) =>
    assert.ok(Math.abs(sun()[axis] - value) < 1e-9, `axis ${axis}: ${sun()[axis]} vs ${value}`),
  );
});

test('a click or tap on the globe selects what is under it; a drag, or another pointer let go, selects nothing', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setSaved([], chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  // The view is centred on Chennai: its marker is in the middle of the 900 × 700 stage.
  tap(s, 450, 350);
  assert.deepEqual(
    s.picked.map(({ name }) => name),
    ['Chennai'],
    'a click on a marker selects its place',
  );
  // Off the markers, the point under the pointer: 100 px right of the centre of a globe some
  // 530 px across lies about 19° east of Chennai.
  tap(s, 550, 350);
  assert.equal(s.picked.length, 2, 'a click on the globe selects a point');
  const point = s.picked[1];
  assert.ok(Math.abs(point.latitude - chennai.latitude) < 1.5, `${point.latitude}°`);
  const east = point.longitude - chennai.longitude;
  assert.ok(east > 15 && east < 22, `${east}° east of Chennai`);
  // A finger's tap on a phone selects too, though a finger lands and lifts a few pixels apart:
  // here 8 px, more than a mouse may move in a click (5 px), within a finger's 12.
  const finger = { pointerId: 7, pointerType: 'touch' };
  s.canvas.dispatchEvent(stamped('pointerdown', 450, 350, 6_000, finger));
  lift(s, 456, 355, 6_090, finger);
  assert.deepEqual(
    s.picked.map(({ name }) => name).slice(2),
    ['Chennai'],
    'a tap on a marker selects its place',
  );
  // A drag turns the globe and selects nothing.
  drag(s);
  assert.equal(s.picked.length, 3, 'a drag is not a click');
  // A finger rests on the globe while a mouse, pressed elsewhere on the page, is let go over it.
  // That release is not the finger's tap.
  s.canvas.dispatchEvent(stamped('pointerdown', 450, 350, 9_000, finger));
  lift(s, 450, 350, 9_080, { pointerId: 1, pointerType: 'mouse' });
  assert.equal(s.picked.length, 3, 'another pointer let go selects nothing');
  // Only lets the finger go, so no pointer is left down on the globe: nothing more is checked.
  lift(s, 450, 350, 9_160, finger);
});

test('on a high-density screen the globe is drawn in its device pixels, up to two for each CSS pixel', () => {
  for (const [pixels, drawn] of [
    [2, 2],
    [1.5, 1.5],
    [3, 2],
    [1, 1],
    [null, 1],
  ] as const) {
    const s = scene({ pixels });
    s.globe.setPlace(chennai);
    s.run(100);
    const screen = `a ${pixels ?? 'silent'}× screen`;
    // The 900 × 700 stage: 1800 × 1400 pixels on a 2× screen, so the globe is sharp there.
    assert.equal(s.renderer.pixelRatio, drawn, screen);
    assert.deepEqual(s.renderer.size, { width: 900, height: 700 }, screen);
    // The stars are sized in the same pixels, so they look the same size on every screen.
    assert.equal(s.stars().uniforms.pixelRatio.value, drawn, `${screen}: stars`);
    s.globe.dispose();
  }
});

test("every texture the earth is drawn with reaches the GPU: a plain placeholder, then NASA's imagery", () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, false);
  s.run(100);
  const maps = () =>
    ['baseMap', 'dailyMap'].map((name) => s.material().uniforms[name].value as Texture);
  const uploaded = (texture: Texture) => s.renderer.uploads.includes(texture);
  // Before NASA answers, each map is one opaque black texel, handed to the GPU with the first
  // frame: the shader draws a plain sphere until an image arrives.
  for (const texture of maps()) {
    assert.ok(uploaded(texture), 'the placeholder is uploaded');
    const { data, width, height } = (texture as DataTexture).image;
    assert.deepEqual([width, height, ...(data ?? [])], [1, 1, 0, 0, 0, 255]);
  }
  // The Blue Marble and a daily mosaic arrive: each is uploaded by the next frame.
  const base = { width: 2048, height: 1024 } as unknown as TexImageSource;
  const daily = { width: 2048, height: 1024 } as unknown as TexImageSource;
  s.globe.setImage('base', base);
  s.globe.setImage('daily', daily);
  s.run(1000 / 60);
  const [baseMap, dailyMap] = maps();
  assert.equal(baseMap.image, base);
  assert.equal(dailyMap.image, daily);
  assert.ok(uploaded(baseMap), 'the base image reaches the GPU');
  assert.ok(uploaded(dailyMap), 'the mosaic reaches the GPU');
  // Once: not again with each frame of the mosaic's fade and the marker's pulse.
  const drawn = s.renderer.renders;
  s.run(1_000);
  assert.ok(s.renderer.renders > drawn + 10, `${s.renderer.renders - drawn} frames in a second`);
  for (const map of [baseMap, dailyMap])
    assert.equal(s.renderer.uploads.filter((texture) => texture === map).length, 1);
  // The card no longer dates the mosaic: a new placeholder takes its place on the GPU.
  s.globe.setImage('daily', null);
  s.run(100);
  const [, cleared] = maps();
  assert.notEqual(cleared, dailyMap);
  assert.ok(uploaded(cleared), 'the new placeholder is uploaded');
});

/**
 * What the last frame drew on the globe at `place`: the colour of each marker part lying there
 * (within a hundredth of the globe's radius of its point on the surface), in the order drawn.
 */
function drawnAt(s: ReturnType<typeof scene>, place: LatLon) {
  const surface = new Vector3(...latLonToVector(place.latitude, place.longitude));
  const parts: string[] = [];
  s.renderer.scene?.traverseVisible((object) => {
    const part = object as Mesh;
    if (!part.isMesh || part.getWorldPosition(new Vector3()).distanceTo(surface) > 0.01) return;
    const colour = (part.material as ShaderMaterial).uniforms?.colour?.value as Color | undefined;
    parts.push(colour ? `#${colour.getHexString()}` : 'no colour');
  });
  return parts;
}

test('each saved place is marked on the globe in violet; the selected place by its own marker alone', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setSaved([], chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  // The selected place: a white dot in a teal ring, with its glow, beam and pulses.
  const own = drawnAt(s, chennai);
  assert.ok(own.includes('#ffffff') && own.includes('#3ee6c1'), `${own}`);
  // Saved too, with London and a point picked on the globe due north of Chennai, on its meridian.
  const north = pointPlace(30, chennai.longitude);
  s.globe.setSaved([london, chennai, north], chennai);
  s.run(100);
  assert.deepEqual(drawnAt(s, chennai), own, 'no saved marker under the selected one');
  for (const place of [london, north])
    assert.deepEqual(drawnAt(s, place), ['#8b7cff', '#8b7cff'], `${place.name}: violet dot, glow`);
  // A place no longer saved loses its marker.
  s.globe.setSaved([north], chennai);
  s.run(100);
  assert.deepEqual(drawnAt(s, london), []);
  assert.deepEqual(drawnAt(s, north), ['#8b7cff', '#8b7cff']);
});

/**
 * The starry sky as the GPU leaves it in the last frame drawn. three.js (WebGLRenderer) draws
 * opaque objects first, then see-through ones by render order and from the furthest to the
 * nearest, judged by the centre of each one's bounding sphere; a star is hidden where something
 * drawn before it wrote depth nearer the camera, as the stars' own depth test finds. Each object
 * stands for its bounding sphere here, which for the earth and its glow is the object itself.
 */
function sky(s: ReturnType<typeof scene>) {
  const { scene: drawn, camera } = s.renderer;
  assert.ok(drawn && camera, 'a frame was drawn');
  drawn.updateMatrixWorld();
  camera.updateMatrixWorld();
  const screen = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const items: { object: Mesh | Points; centre: Vector3; radius: number; z: number }[] = [];
  drawn.traverseVisible((object) => {
    const shape = object as Mesh | Points;
    if (!(shape as Mesh).isMesh && !(shape as Points).isPoints) return;
    if (!shape.geometry.boundingSphere) shape.geometry.computeBoundingSphere();
    const { center, radius } = shape.geometry
      .boundingSphere!.clone()
      .applyMatrix4(object.matrixWorld);
    const z = new Vector4(center.x, center.y, center.z, 1).applyMatrix4(screen).z;
    items.push({ object: shape, centre: center, radius, z });
  });
  const material = ({ object }: (typeof items)[number]) => object.material as Material;
  const order = [
    ...items.filter((item) => !material(item).transparent),
    ...items
      .filter((item) => material(item).transparent)
      .sort(
        (a, b) =>
          a.object.renderOrder - b.object.renderOrder || b.z - a.z || a.object.id - b.object.id,
      ),
  ];
  const at = order.findIndex(({ object }) => (object as Points).isPoints);
  assert.ok(at >= 0, 'the stars are drawn');
  const stars = order[at].object;
  const eye = camera.getWorldPosition(new Vector3());
  const points = stars.geometry.getAttribute('position');
  const star = (index: number) =>
    new Vector3().fromBufferAttribute(points, index).applyMatrix4(stars.matrixWorld);
  /** Whether the line of sight to `point` passes through the sphere at `centre` on the way. */
  const through = (point: Vector3, centre: Vector3, radius: number) => {
    const sight = point.clone().sub(eye);
    const along = Math.min(1, Math.max(0, centre.clone().sub(eye).dot(sight) / sight.lengthSq()));
    return eye.clone().addScaledVector(sight, along).distanceTo(centre) < radius;
  };
  const indices = Array.from({ length: points.count }, (_, index) => index);
  const before = order.slice(0, at);
  // Stars drawn without the depth test would show over everything, the earth included.
  const writers = material(order[at]).depthTest
    ? before.filter((item) => material(item).depthWrite && material(item).depthTest)
    : [];
  return {
    /** The stars no viewer sees in this frame. */
    hidden: indices.filter((index) =>
      writers.some(({ centre, radius }) => through(star(index), centre, radius)),
    ),
    /** The stars seen through a sphere of `radius` at the centre of the globe. */
    behind: (radius: number) =>
      indices.filter((index) => through(star(index), new Vector3(), radius)),
    /** Whether `material` is drawn before the stars in this frame. */
    drawnBefore: (wanted: Material) => before.some((item) => material(item) === wanted),
  };
}

test('the glow round the globe hides no star: only the earth itself does, whichever is drawn first', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  const glow = s.glow();
  /** The glow's shell reaches 1.16 times the earth's radius (globe-scene.ts ATMOSPHERE). */
  const shell = 1.16;
  let throughGlow = 0;
  // Round the globe in steps of the rotate pad: along Chennai's parallel, then further north.
  for (let step = 0; step < 24; step++) {
    s.globe.rotate({ kind: 'rotate', latitude: step === 12 ? 40 : 0, longitude: 30 });
    s.run(100);
    const view = sky(s);
    const earth = view.behind(1);
    assert.deepEqual(
      view.hidden,
      earth,
      `view ${step}: only the stars behind the earth are hidden`,
    );
    if (view.drawnBefore(glow)) throughGlow += view.behind(shell).length - earth.length;
  }
  // three.js drew the glow before the stars in some of those views, with stars seen through it.
  assert.ok(throughGlow > 0, `${throughGlow} stars seen through a glow drawn before them`);
});

test('a globe first drawn after its minute, in a tab opened late, draws once and rests', () => {
  const s = scene();
  tab(s, false); // hidden before the first refresh, as a dashboard opened in a background tab
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, true);
  s.run(AUTO_ROTATE_MS + 5_000);
  tab(s, true);
  s.run(HOME_GLIDE_MS + 500);
  assert.ok(s.offPlace() < 0.01, 'it is already on the place');
  assert.equal(s.renderer.renders, 1, 'one frame, not a glide back to where it already is');
  assert.equal(s.frames.size, 0, 'and no frame is left asked for');
});

test('a zoom step says how the view moved, and when it reaches the furthest view', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  assert.equal(s.globe.zoom(1 / 1.25), 'in', 'one step in from the starting view');
  assert.equal(s.globe.zoom(1.25), 'out', 'and back');
  assert.deepEqual(
    [1, 2, 3].map(() => s.globe.zoom(1.25)),
    ['out', 'out', 'furthest'],
    'the third step out reaches the limit',
  );
});

test('zoomed in, a new place keeps the zoom the viewer chose', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(false, false);
  s.run(100);
  s.globe.zoom(1 / 1.25);
  s.run(100);
  const close = s.seen().distance;
  assert.equal(s.globe.setPlace(london), true);
  s.run(100);
  sameCentre(s.seen(), london, 'the new place');
  assert.ok(Math.abs(s.seen().distance - close) < 1e-6, `${s.seen().distance}: not ${close}`);
  assert.deepEqual(s.log, ['zoomed true'], 'still closer: the title stays aside');
});

test('orbital arcs, ground-track sweeps, and jet-stream ribbons animate under motion, pause cleanly, and hide no stars', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, false);
  s.run(100);
  const drawnScene = s.renderer.scene!;
  const orbits = drawnScene.getObjectByName('satellite-orbits');
  const jets = drawnScene.getObjectByName('jet-streams');
  assert.ok(
    orbits && orbits.children.length === 8,
    'polar + geo arcs, ground tracks, satellites, footprints',
  );
  assert.ok(jets && jets.children.length === 3, 'three atmospheric jet-stream flow ribbons');

  const trackUniforms = orbits.children
    .map((child) => ((child as Mesh).material as ShaderMaterial | undefined)?.uniforms)
    .filter((u): u is NonNullable<typeof u> => !!u?.headPhase);
  const jetUniforms = jets.children.map(
    (child) => ((child as Mesh).material as ShaderMaterial).uniforms,
  );
  const satBeacons = orbits.children.filter((child) => child.type === 'Group');
  assert.equal(trackUniforms.length, 2);
  assert.equal(jetUniforms.length, 3);
  assert.equal(satBeacons.length, 2);

  const head0 = trackUniforms[0].headPhase.value as number;
  const jet0 = jetUniforms[0].time.value as number;
  const sat0 = satBeacons[0].position.clone();
  s.run(2_000);
  assert.notEqual(trackUniforms[0].headPhase.value, head0, 'ground-track sweep advances');
  assert.ok((jetUniforms[0].time.value as number) > jet0, 'jet-stream phase advances');
  assert.ok(satBeacons[0].position.distanceTo(sat0) > 0.01, 'satellite beacon moves along orbit');

  // Under reduced motion / Pause, everything freezes and hides zero stars.
  s.globe.setMotion(false, false);
  s.run(100);
  const frozenHead = trackUniforms[0].headPhase.value as number;
  const frozenJet = jetUniforms[0].time.value as number;
  const frozenSat = satBeacons[0].position.clone();
  s.run(3_000);
  assert.equal(trackUniforms[0].headPhase.value, frozenHead, 'ground track pauses');
  assert.equal(jetUniforms[0].time.value, frozenJet, 'jet streams pause');
  assert.equal(satBeacons[0].position.distanceTo(frozenSat), 0, 'satellite beacons pause');
  const view = sky(s);
  assert.deepEqual(view.hidden, view.behind(1), 'orbital and jet-stream layers hide zero stars');
});

test('severe-warning beacons anchor to active outline centroids, pulse, hide no stars, and dispose on update', () => {
  const s = scene();
  s.globe.setPlace(chennai);
  s.globe.setMotion(true, false);
  s.run(100);
  const beacons = s.renderer.scene!.getObjectByName('warning-beacons')!;
  assert.ok(beacons);
  assert.equal(beacons.children.length, 0, 'no warning beacons without active outlines');

  const segA = outlineSegments(
    {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [76, 10],
            [84, 10],
            [84, 16],
            [76, 16],
            [76, 10],
          ],
        ],
      ],
    },
    1.003,
    1,
  );
  const segB = outlineSegments(
    {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [-4, 49],
            [4, 49],
            [4, 54],
            [-4, 54],
            [-4, 49],
          ],
        ],
      ],
    },
    1.003,
    1,
  );
  s.globe.setOutlines([segA, segB]);
  s.run(100);
  assert.equal(beacons.children.length, 2, 'one beacon assembly per active warning polygon');
  const expectedA = new Vector3(...segmentsCentroid(segA, 1.003)!);
  const expectedB = new Vector3(...segmentsCentroid(segB, 1.003)!);
  assert.ok(beacons.children[0].position.distanceTo(expectedA) < 1e-6);
  assert.ok(beacons.children[1].position.distanceTo(expectedB) < 1e-6);

  // Track disposal of beacon materials when outlines are replaced or cleared.
  const firstMaterials: Material[] = [];
  beacons.traverse((obj) => {
    const mat = (obj as Mesh).material as Material | undefined;
    if (mat) firstMaterials.push(mat);
  });
  assert.equal(firstMaterials.length, 4, 'two materials (cone + ring) per beacon');
  let disposedCount = 0;
  for (const mat of firstMaterials) {
    const orig = mat.dispose.bind(mat);
    mat.dispose = () => {
      disposedCount++;
      orig();
    };
  }

  // Verify beacon pulse advances with motion and hides no stars.
  const coneUniform = ((beacons.children[0].children[0] as Mesh).material as ShaderMaterial)
    .uniforms.pulse;
  const p0 = coneUniform.value as number;
  s.run(500);
  assert.notEqual(coneUniform.value, p0, 'warning beacon cone pulses');
  const view = sky(s);
  assert.deepEqual(view.hidden, view.behind(1), 'warning beacons hide zero stars');

  // Replace outlines -> previous beacon materials must be disposed immediately.
  s.globe.setOutlines([segA]);
  assert.equal(disposedCount, 4, 'replaced warning beacon materials disposed immediately');
  assert.equal(beacons.children.length, 1);

  // Clear outlines -> all warning beacons removed.
  s.globe.setOutlines([]);
  s.run(100);
  assert.equal(beacons.children.length, 0);
});

test('geodesic SLERP fly-to crosses the antimeridian along the short great-circle path', () => {
  const s = scene();
  const eastSide: Place = {
    id: 'kamchatka',
    name: 'East',
    country: 'Test',
    countryCode: 'TS',
    latitude: 40,
    longitude: 170,
  };
  const westSide: Place = {
    id: 'aleutians',
    name: 'West',
    country: 'Test',
    countryCode: 'TS',
    latitude: 40,
    longitude: -170,
  };
  s.globe.setPlace(eastSide);
  s.globe.setMotion(true, false);
  s.run(100);
  s.globe.setPlace(westSide);
  s.run(380);
  const mid = s.seen();
  assert.ok(
    angularDistance(mid, { latitude: 40, longitude: 180 }) < 12,
    `mid-flight passes near 180° instead of wrapping through 0° (got lon ${mid.longitude})`,
  );
  s.run(600);
  sameCentre(s.seen(), westSide, 'lands cleanly on antimeridian destination');
});
