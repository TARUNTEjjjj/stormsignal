/**
 * The 3D globe's scene (components/GlobeView.tsx): a WebGL 2 context found before three.js is
 * requested, then the renderer, camera, controls and everything drawn on the globe. What it
 * decides comes from globe.ts and what it draws from globe-shaders.ts. tests/globe-scene.test.ts
 * runs it on three.js itself, with a stand-in for the renderer, which alone needs a GPU.
 */
// Types only: three.js itself is downloaded by loadThree, after the browser shows it has WebGL 2.
import type { Color, Group, ShaderMaterial, Texture, Vector3, WebGLRenderer } from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { normalizeLongitude } from './imagery';
import {
  DAILY_OPACITY,
  HOME_GLIDE_MS,
  WARNING_LINE,
  ambientWait,
  angularDistance,
  autoRotating,
  cosmeticMotion,
  createLifecycle,
  dailyLayer,
  drawing,
  fadeDaily,
  fitDistance,
  hatchDegrees,
  hexColor,
  isTap,
  latLonToVector,
  nearestMarker,
  nextFrame,
  pointPlace,
  raySphere,
  returnsHome,
  skipsFrame,
  starfield,
  stepView,
  sunDirection,
  vectorToLatLon,
  type FrameState,
  type GlobeKey,
  type GlobeViewState,
  type LatLon,
  type Vector,
} from './globe';
import {
  atmosphereFragment,
  beamFragment,
  earthFragment,
  flatFragment,
  glowFragment,
  hideBeyondHorizon,
  plainVertex,
  starFragment,
  starVertex,
  surfaceVertex,
} from './globe-shaders';
import type { Place } from './types';

const FOV = 30;
/** The camera orbits with north up, so the centre of the view stays within this latitude. */
export const MAX_LATITUDE = 80;
const MIN_DISTANCE = 1.32;
const ATMOSPHERE = 1.16;
export const OUTLINE_RADIUS = 1.003;
/** Auto-rotation's speed (OrbitControls): 1.2° a second, so the place stays on the near side. */
const AUTO_ROTATE_SPEED = 0.2;
const RAD = Math.PI / 180;

/**
 * three.js and the add-ons the globe uses, downloaded on demand: never in the main bundle. Each
 * part is named, so the bundler keeps only those. The build emits them as separate chunks (the
 * core, OrbitControls and three line add-ons), fetched together.
 */
export async function loadThree() {
  const [core, OrbitControls, LineMaterial, LineSegments2, LineSegmentsGeometry] =
    await Promise.all([
      import('three').then(
        ({
          AdditiveBlending,
          BackSide,
          BufferAttribute,
          BufferGeometry,
          CircleGeometry,
          Color,
          CylinderGeometry,
          DataTexture,
          Group,
          LinearMipmapLinearFilter,
          Mesh,
          PerspectiveCamera,
          Points,
          Raycaster,
          RepeatWrapping,
          RingGeometry,
          Scene,
          ShaderMaterial,
          SphereGeometry,
          SRGBColorSpace,
          Texture,
          Vector2,
          Vector3,
          WebGLRenderer,
        }) => ({
          AdditiveBlending,
          BackSide,
          BufferAttribute,
          BufferGeometry,
          CircleGeometry,
          Color,
          CylinderGeometry,
          DataTexture,
          Group,
          LinearMipmapLinearFilter,
          Mesh,
          PerspectiveCamera,
          Points,
          Raycaster,
          RepeatWrapping,
          RingGeometry,
          Scene,
          ShaderMaterial,
          SphereGeometry,
          SRGBColorSpace,
          Texture,
          Vector2,
          Vector3,
          WebGLRenderer,
        }),
      ),
      import('three/examples/jsm/controls/OrbitControls.js').then((m) => m.OrbitControls),
      import('three/examples/jsm/lines/LineMaterial.js').then((m) => m.LineMaterial),
      import('three/examples/jsm/lines/LineSegments2.js').then((m) => m.LineSegments2),
      import('three/examples/jsm/lines/LineSegmentsGeometry.js').then(
        (m) => m.LineSegmentsGeometry,
      ),
    ]);
  return { ...core, OrbitControls, LineMaterial, LineSegments2, LineSegmentsGeometry };
}
export type ThreeKit = Awaited<ReturnType<typeof loadThree>>;

export interface Probe {
  canvas: HTMLCanvasElement;
  context: WebGL2RenderingContext;
}
/**
 * The globe's WebGL 2 context, or null, having written nothing to the console, where the browser
 * has none. It is opened before three.js is requested, so such a browser never downloads it.
 */
export function openContext(): Probe | null {
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: 'default',
    });
    return context && !context.isContextLost() ? { canvas, context } : null;
  } catch {
    return null;
  }
}
/** Gives a context back now rather than at garbage collection: browsers keep only a few. */
export function releaseContext({ context }: Probe) {
  if (!context.isContextLost()) context.getExtension('WEBGL_lose_context')?.loseContext();
}

export interface GlobeEvents {
  /** The user dragged, zoomed or tapped the globe. */
  interact(): void;
  /** A drag turned the view to another centre. */
  turned(): void;
  pick(place: Place): void;
  /** A wheel turn without Ctrl or ⌘ scrolls the page, not the globe. */
  wheel(): void;
  /** The view moved closer than its default distance, or back. */
  zoomed(closer: boolean): void;
  lost(): void;
  restored(): void;
  /** Drawing a frame failed: the globe stops, says so and lets go of its graphics memory. */
  failed(): void;
}
export type RotateAction = Extract<GlobeKey, { kind: 'rotate' }>;
export interface Globe {
  /** Shows `place` and returns whether the view moved to it from another place. */
  setPlace(place: Place): boolean;
  setSaved(places: readonly Place[], selected: Place): void;
  setOutlines(segments: Float32Array[]): void;
  /** The image a layer shows, or null for none: the same image again changes nothing. */
  setImage(layer: 'base' | 'daily', image: TexImageSource | null): void;
  setDailyVisible(visible: boolean): void;
  /** Whether anything moves, and whether the globe turns by itself: switched on, it turns a minute. */
  setMotion(animate: boolean, rotate: boolean): void;
  rotate(action: RotateAction): LatLon;
  zoom(factor: number): 'in' | 'out' | 'closest' | 'furthest';
  reset(): void;
  centre(): LatLon;
  dispose(): void;
}
export interface SceneOptions {
  /** The wall clock that places the sun (GlobeView: the warning source's clock where known). */
  clock(): number;
}

/**
 * The 3D scene: renderer, camera, controls and every object on the globe, on `probe`'s context.
 * Everything it creates or listens to is registered with one lifecycle and released by dispose(),
 * or as soon as a frame fails to draw. Returns null when three.js cannot start a renderer there.
 */
export function createGlobe(
  three: ThreeKit,
  { canvas, context }: Probe,
  stage: HTMLDivElement,
  host: HTMLDivElement,
  label: HTMLElement | null,
  events: GlobeEvents,
  { clock }: SceneOptions,
): Globe | null {
  const {
    AdditiveBlending,
    BackSide,
    BufferAttribute,
    BufferGeometry,
    CircleGeometry,
    Color,
    CylinderGeometry,
    DataTexture,
    Group,
    LinearMipmapLinearFilter,
    Mesh,
    PerspectiveCamera,
    Points,
    Raycaster,
    RepeatWrapping,
    RingGeometry,
    Scene,
    ShaderMaterial,
    SphereGeometry,
    SRGBColorSpace,
    Texture,
    Vector2,
    Vector3,
    WebGLRenderer,
    OrbitControls,
    LineMaterial,
    LineSegments2,
    LineSegmentsGeometry,
  } = three;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, context, antialias: true, alpha: true });
  } catch {
    return null;
  }
  const life = createLifecycle();
  const { keep } = life;
  // Deferred first, so it runs last: the renderer goes after everything it drew.
  life.defer(() => {
    renderer.dispose();
    if (!context.isContextLost()) renderer.forceContextLoss();
    canvas.remove();
  });
  host.append(canvas);
  renderer.setClearColor(0x000000, 0);
  const style = getComputedStyle(stage);
  const token = (name: string, fallback: string) =>
    new Color().setRGB(...hexColor(style.getPropertyValue(name), fallback), SRGBColorSpace);
  const teal = token('--aurora-teal', '#3EE6C1');
  const violet = token('--aurora-violet', '#8B7CFF');
  const plain = token('--aurora-surface-raised', '#131E33');

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 200);
  const controls = new OrbitControls(camera, canvas);
  life.defer(() => controls.dispose());
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomSpeed = 0.7;
  controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
  controls.minPolarAngle = (90 - MAX_LATITUDE) * RAD;
  controls.maxPolarAngle = (90 + MAX_LATITUDE) * RAD;
  controls.minDistance = MIN_DISTANCE;
  controls.cursorStyle = 'grab';
  // Vertical swipes keep scrolling the page; horizontal ones and pinches turn and zoom the globe.
  canvas.style.touchAction = 'pan-y';

  const blank = () => {
    const texture = keep(new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1));
    texture.needsUpdate = true;
    return texture;
  };
  const sun = new Vector3();
  const earthMaterial = keep(
    new ShaderMaterial({
      uniforms: {
        baseMap: { value: blank() },
        dailyMap: { value: blank() },
        baseReady: { value: 0 },
        dailyMix: { value: 0 },
        dailyShown: { value: 0 },
        hatchStep: { value: 4 },
        sun: { value: sun },
        teal: { value: teal },
        violet: { value: violet },
        plain: { value: plain },
      },
      vertexShader: surfaceVertex,
      fragmentShader: earthFragment,
    }),
  );
  scene.add(new Mesh(keep(new SphereGeometry(1, 128, 64)), earthMaterial));
  scene.add(
    new Mesh(
      keep(new SphereGeometry(ATMOSPHERE, 96, 48)),
      keep(
        new ShaderMaterial({
          uniforms: {
            teal: { value: teal },
            violet: { value: violet },
            sun: { value: sun },
            edge: { value: Math.sqrt(1 - 1 / ATMOSPHERE ** 2) },
          },
          vertexShader: surfaceVertex,
          fragmentShader: atmosphereFragment,
          side: BackSide,
          blending: AdditiveBlending,
          transparent: true,
          depthWrite: false,
        }),
      ),
    ),
  );
  const sky = starfield(1800);
  const starGeometry = keep(new BufferGeometry());
  starGeometry.setAttribute('position', new BufferAttribute(sky.positions, 3));
  starGeometry.setAttribute('size', new BufferAttribute(sky.sizes, 1));
  starGeometry.setAttribute('tint', new BufferAttribute(sky.tints, 1));
  const starMaterial = keep(
    new ShaderMaterial({
      uniforms: {
        pixelRatio: { value: 1 },
        time: { value: 0 },
        twinkle: { value: 0 },
        teal: { value: teal },
        violet: { value: violet },
      },
      vertexShader: starVertex,
      fragmentShader: starFragment,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  scene.add(new Points(starGeometry, starMaterial));

  // Markers lie flat on the surface: each group's +Z is the local vertical.
  const disc = keep(new CircleGeometry(1, 48));
  const ring = keep(new RingGeometry(0.82, 1, 72));
  const beamGeometry = keep(new CylinderGeometry(0.0016, 0.0016, 0.15, 8, 1, true));
  beamGeometry.rotateX(Math.PI / 2);
  beamGeometry.translate(0, 0, 0.075);
  const glow = (colour: Color, opacity: number) =>
    keep(
      new ShaderMaterial({
        uniforms: { colour: { value: colour }, opacity: { value: opacity } },
        vertexShader: plainVertex,
        fragmentShader: glowFragment,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
  const flat = (colour: Color, opacity: number): ShaderMaterial =>
    keep(
      new ShaderMaterial({
        uniforms: { colour: { value: colour }, opacity: { value: opacity } },
        vertexShader: plainVertex,
        fragmentShader: flatFragment,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
  const white = new Color(1, 1, 1);
  const pulses = [flat(teal, 0.7), flat(violet, 0.6)];
  const selected = new Group();
  const selectedParts = {
    halo: new Mesh(disc, glow(teal, 0.55)),
    core: new Mesh(disc, flat(white, 1)),
    rim: new Mesh(ring, flat(teal, 1)),
    pulses: pulses.map((material) => new Mesh(ring, material)),
    beam: new Mesh(
      beamGeometry,
      keep(
        new ShaderMaterial({
          uniforms: { colour: { value: teal } },
          vertexShader: plainVertex,
          fragmentShader: beamFragment,
          blending: AdditiveBlending,
          transparent: true,
          depthWrite: false,
        }),
      ),
    ),
  };
  selectedParts.halo.scale.setScalar(0.05);
  selectedParts.core.scale.setScalar(0.0075);
  selectedParts.rim.scale.setScalar(0.014);
  for (const part of [selectedParts.core, selectedParts.rim]) part.position.z = 0.0015;
  selected.add(
    selectedParts.halo,
    selectedParts.core,
    selectedParts.rim,
    selectedParts.beam,
    ...selectedParts.pulses,
  );
  selected.visible = false;
  scene.add(selected);
  const savedGroup = new Group();
  scene.add(savedGroup);
  const savedHalo = glow(violet, 0.5);
  const savedCore = flat(violet, 0.95);
  let markerPlaces: { place: Place; position: Vector3 }[] = [];
  // Warning outlines (WARNING_LINE): the casing, then the red line, sharing one geometry.
  const line = (color: string, linewidth: number, opacity: number): LineMaterial => {
    const material = keep(
      new LineMaterial({ color, linewidth, transparent: true, opacity, depthWrite: false }),
    );
    material.onBeforeCompile = hideBeyondHorizon;
    return material;
  };
  const outlineMaterials = [
    line(WARNING_LINE.casing, WARNING_LINE.casingWidth, WARNING_LINE.casingOpacity),
    line(WARNING_LINE.colour, WARNING_LINE.width, 1),
  ];
  let outlineGeometry: LineSegmentsGeometry | null = null;
  let outlineLines: LineSegments2[] = [];

  let width = 1;
  let height = 1;
  let fit = 4;
  let frame = 0;
  /** Ambient motion waits on this timer before it asks for the next refresh (ambientWait). */
  let wait = 0;
  let rendering = false;
  let inView = true;
  let pageVisible = document.visibilityState !== 'hidden';
  let lost = false;
  let failed = false;
  let animate = false;
  let rotate = false;
  let last = performance.now();
  let lastActive = last;
  /** When auto-rotation began (setMotion), or null: it turns for AUTO_ROTATE_MS from then. */
  let turnStart: number | null = null;
  let wasTurning = false;
  /** The controls moved the camera in the last frame without auto-rotation: a drag's glide. */
  let settling = false;
  /** Pointers down on the globe: a drag in progress is drawn at every refresh. */
  let pointers = 0;
  let drawnAt = -Infinity;
  let phase = 0;
  let dailyTarget = 0;
  let dailyVisible = true;
  const shown: Record<'base' | 'daily', TexImageSource | null> = { base: null, daily: null };
  let closer = false;
  let current: Place | null = null;
  let flight: {
    from: GlobeViewState;
    to: GlobeViewState;
    start: number;
    duration: number;
  } | null = null;

  const view = (): GlobeViewState => ({
    ...vectorToLatLon(camera.position.toArray() as Vector),
    distance: camera.position.length(),
  });
  const show = (state: GlobeViewState) => {
    camera.position.set(...latLonToVector(state.latitude, state.longitude, state.distance));
    camera.lookAt(0, 0, 0);
  };
  const limits = () => ({
    maxLatitude: MAX_LATITUDE,
    minDistance: MIN_DISTANCE,
    maxDistance: controls.maxDistance,
  });
  const running = () => drawing({ inView, pageVisible, lost, failed, disposed: life.disposed });
  /** Something changed or the user acted: the pulse and twinkle move again for a while. */
  const touch = () => {
    lastActive = performance.now();
  };
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    if (wait) window.clearTimeout(wait);
    frame = 0;
    wait = 0;
  };
  life.defer(stop);
  const ask = () => {
    frame = requestAnimationFrame(loop);
  };
  /** The next frame: at the next display refresh, or after `delay` ms for ambient motion. */
  const schedule = (delay: number) => {
    if (delay <= 0) ask();
    else
      wait = window.setTimeout(() => {
        wait = 0;
        if (running()) ask();
      }, delay);
  };
  const invalidate = () => {
    if (frame || rendering || !running()) return;
    // A change while ambient motion waits is drawn at the next refresh; from rest, the frame
    // counts its time from now.
    if (wait) window.clearTimeout(wait);
    else last = performance.now();
    wait = 0;
    ask();
  };
  /** Ends the glide a drag left behind, without moving the camera, so a fly-to lands on target. */
  const still = () => {
    const position = camera.position.clone();
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = animate;
    camera.position.copy(position);
    camera.lookAt(0, 0, 0);
  };
  const updateSun = () => {
    sun.set(...sunDirection(clock()));
  };
  /** Moves the view to `target`: over `duration` with motion, at once without. */
  const glide = (target: GlobeViewState, duration: number) => {
    controls.autoRotate = false;
    still();
    if (!animate || duration <= 0) {
      flight = null;
      show(target);
      controls.update();
      invalidate();
      return;
    }
    flight = { from: view(), to: target, start: performance.now(), duration };
    invalidate();
  };
  /** A move the user asked for, or a new place: the pulse comes back too. */
  const flyTo = (target: GlobeViewState, duration: number) => {
    touch();
    glide(target, duration);
  };
  const facing = (position: Vector3) =>
    position.dot(camera.position) / camera.position.length() > 1 / camera.position.length() + 0.02;
  const projected = new Vector3();
  const toScreen = (position: Vector3) => {
    projected.copy(position).project(camera);
    return { x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height };
  };
  const placeView = (place: LatLon, distance: number): GlobeViewState => ({
    latitude: Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, place.latitude)),
    longitude: normalizeLongitude(place.longitude),
    distance,
  });

  /** The floating place label goes with the drawing: never over a fallback or a stale frame. */
  const hideLabel = () => {
    if (label) label.dataset.hidden = 'true';
  };

  function loop(now: number) {
    frame = 0;
    const state: FrameState = {
      running: running(),
      moving: false,
      autoRotate: rotate && !flight,
      animate,
      idle: now - lastActive,
      turning: turnStart === null ? Infinity : now - turnStart,
    };
    // The globe turns by itself for a minute after it starts, then rests (AUTO_ROTATE_MS).
    const turningNow = autoRotating(state);
    const cosmetic = cosmeticMotion(state);
    const mix = earthMaterial.uniforms.dailyMix;
    // Turning by itself, the pulse and the twinkle are drawn 30 times a second (skipsFrame).
    const ambient = () =>
      (turningNow || cosmetic) && !flight && !pointers && !settling && mix.value === dailyTarget;
    if (skipsFrame(ambient(), now - drawnAt)) {
      if (state.running) schedule(0);
      return;
    }
    rendering = true;
    let again = false;
    try {
      const delta = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      // Its minute over, the globe glides back to the place unless the user took it in hand.
      if (returnsHome(wasTurning, state) && current)
        glide(placeView(current, camera.position.length()), HOME_GLIDE_MS);
      wasTurning = turningNow;
      controls.autoRotate = turningNow && !flight;
      let moving = false;
      if (flight) {
        const t = Math.min(1, Math.max(0, (now - flight.start) / flight.duration));
        const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        const turn = normalizeLongitude(flight.to.longitude - flight.from.longitude);
        show({
          latitude: flight.from.latitude + (flight.to.latitude - flight.from.latitude) * eased,
          longitude: flight.from.longitude + turn * eased,
          distance: flight.from.distance + (flight.to.distance - flight.from.distance) * eased,
        });
        if (t >= 1) flight = null;
        moving = true;
      }
      const moved = controls.update(delta);
      if (moved) moving = true;
      settling = moved && !controls.autoRotate;
      const distance = camera.position.length();
      // Dragging moves the surface under the pointer at about the same speed at every zoom.
      controls.rotateSpeed = 0.62 * Math.min(1.4, Math.max(0.08, (distance - 1) / (fit - 1)));
      const scale = Math.min(1.5, Math.max(0.3, distance / fit));
      if (closer !== distance < fit * 0.88) {
        closer = !closer;
        events.zoomed(closer);
      }
      selected.scale.setScalar(scale);
      for (const marker of savedGroup.children) marker.scale.setScalar(scale);
      if (mix.value !== dailyTarget) {
        mix.value = fadeDaily(mix.value, dailyTarget, delta, animate);
        earthMaterial.uniforms.dailyShown.value = mix.value / DAILY_OPACITY;
        moving = true;
      }
      // After a few quiet seconds the pulse comes to rest and nothing is drawn until a change.
      if (cosmetic) phase += delta;
      pulses.forEach((material, index) => {
        const at = cosmetic ? (phase / 2.6 + index / 2) % 1 : 0.55;
        selectedParts.pulses[index].scale.setScalar(0.016 + 0.05 * at);
        material.uniforms.opacity.value = (cosmetic ? (1 - at) ** 2 : 0.25) * (index ? 0.5 : 0.7);
      });
      starMaterial.uniforms.time.value = phase;
      starMaterial.uniforms.twinkle.value = cosmetic ? 1 : 0;
      if (label && current) {
        const position = selected.position;
        const visible = selected.visible && facing(position);
        label.dataset.hidden = String(!visible);
        if (visible) {
          const { x, y } = toScreen(position);
          label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        }
      }
      renderer.render(scene, camera);
      drawnAt = now;
      again = nextFrame({ ...state, moving });
    } catch {
      failed = true;
      hideLabel();
      events.failed();
      // Nothing is drawn again until Restart, which starts a new globe: the GPU memory goes now.
      life.dispose();
    } finally {
      rendering = false;
    }
    if (again && running()) schedule(ambient() ? ambientWait(performance.now() - drawnAt) : 0);
  }

  const resize = () => {
    const rect = stage.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    starMaterial.uniforms.pixelRatio.value = ratio;
    for (const material of outlineMaterials) material.resolution.set(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const previous = fit;
    fit = fitDistance(camera.aspect, FOV, camera.aspect < 1.3 ? 0.76 : 0.8);
    controls.maxDistance = fit * 1.8;
    // The hatch keeps about the same spacing on screen at every stage size, and meets itself
    // across 180° (a whole number of stripes around the globe).
    const radius =
      ((Math.min(width, height) / 2) * Math.tan(Math.asin(1 / fit))) / Math.tan((FOV / 2) * RAD);
    earthMaterial.uniforms.hatchStep.value = 360 / Math.round(360 / hatchDegrees(radius));
    // Keep the zoom the viewer chose, in proportion to the new size.
    const distance = camera.position.length();
    if (distance > 0)
      camera.position.multiplyScalar(
        Math.max(MIN_DISTANCE, (distance * fit) / previous) / distance,
      );
    controls.update();
    invalidate();
  };

  let press: { id: number; x: number; y: number; time: number } | null = null;
  const down = (event: PointerEvent) => {
    pointers++;
    press =
      pointers === 1 && (event.pointerType !== 'mouse' || event.button === 0)
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp }
        : null;
  };
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const pickAt = (clientX: number, clientY: number): Place | null => {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const markers = markerPlaces.map(({ position }) => ({
      ...toScreen(position),
      visible: facing(position),
    }));
    const hit = nearestMarker(markers, x, y);
    if (hit >= 0) return markerPlaces[hit].place;
    pointer.set((x / rect.width) * 2 - 1, 1 - (y / rect.height) * 2);
    raycaster.setFromCamera(pointer, camera);
    const point = raySphere(
      raycaster.ray.origin.toArray() as Vector,
      raycaster.ray.direction.toArray() as Vector,
    );
    if (!point) return null;
    const { latitude, longitude } = vectorToLatLon(point);
    return pointPlace(latitude, longitude);
  };
  const up = (event: PointerEvent) => {
    pointers = Math.max(0, pointers - 1);
    const started = press;
    press = null;
    if (!started || started.id !== event.pointerId) return;
    if (
      !isTap(
        started,
        { x: event.clientX, y: event.clientY, time: event.timeStamp },
        event.pointerType,
      )
    )
      return;
    const picked = pickAt(event.clientX, event.clientY);
    if (picked) events.pick(picked);
  };
  const cancel = () => {
    pointers = 0;
    press = null;
  };
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    // The page scrolls instead: OrbitControls, listening on the canvas, never sees this turn.
    event.stopPropagation();
    events.wheel();
  };
  let grabbed: LatLon | null = null;
  const interact = () => {
    flight = null;
    rotate = false;
    controls.autoRotate = false;
    grabbed = vectorToLatLon(camera.position.toArray() as Vector);
    touch();
    events.interact();
  };
  const release = () => {
    const centre = vectorToLatLon(camera.position.toArray() as Vector);
    if (grabbed && angularDistance(grabbed, centre) > 0.1) events.turned();
    grabbed = null;
  };
  controls.addEventListener('start', interact);
  controls.addEventListener('end', release);
  controls.addEventListener('change', invalidate);
  life.defer(() => {
    controls.removeEventListener('start', interact);
    controls.removeEventListener('end', release);
    controls.removeEventListener('change', invalidate);
  });
  life.listen(canvas, 'pointerdown', down as EventListener);
  life.listen(canvas, 'pointerup', up as EventListener);
  life.listen(canvas, 'pointercancel', cancel);
  life.listen(canvas, 'webglcontextlost', (event) => {
    event.preventDefault();
    lost = true;
    stop();
    hideLabel();
    events.lost();
  });
  life.listen(canvas, 'webglcontextrestored', () => {
    lost = false;
    events.restored();
    invalidate();
  });
  life.listen(stage, 'wheel', wheel as EventListener, { capture: true, passive: true });
  life.listen(document, 'visibilitychange', () => {
    pageVisible = document.visibilityState !== 'hidden';
    if (pageVisible) {
      updateSun();
      invalidate();
    } else stop();
  });
  const resizer = new ResizeObserver(resize);
  resizer.observe(stage);
  life.defer(() => resizer.disconnect());
  if (typeof IntersectionObserver === 'function') {
    const watcher = new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      if (inView) invalidate();
      else stop();
    });
    watcher.observe(stage);
    life.defer(() => watcher.disconnect());
  }
  const sunTimer = window.setInterval(() => {
    updateSun();
    invalidate();
  }, 60_000);
  life.defer(() => window.clearInterval(sunTimer));
  updateSun();
  show({ latitude: 0, longitude: 0, distance: fit });
  resize();

  const marker = (position: Vector3, group: Group) => {
    group.position.copy(position);
    group.lookAt(position.clone().multiplyScalar(2));
  };
  return {
    setPlace(place) {
      const position = new Vector3(...latLonToVector(place.latitude, place.longitude));
      marker(position, selected);
      selected.visible = true;
      const target = placeView(place, current ? Math.min(camera.position.length(), fit) : fit);
      const moved =
        !!current && (current.latitude !== place.latitude || current.longitude !== place.longitude);
      if (current && label) label.dataset.hidden = 'true';
      if (moved) {
        const angle = Math.acos(
          Math.max(-1, Math.min(1, position.dot(camera.position) / camera.position.length())),
        );
        flyTo(target, 700 + 500 * (angle / Math.PI));
      } else if (!current) {
        show(target);
        controls.update();
      }
      current = place;
      touch();
      invalidate();
      return moved;
    },
    setSaved(places, place) {
      for (const child of [...savedGroup.children]) savedGroup.remove(child);
      markerPlaces = [];
      for (const saved of places) {
        const position = new Vector3(...latLonToVector(saved.latitude, saved.longitude));
        markerPlaces.push({ place: saved, position });
        // The selected place has its own marker.
        if (
          Math.abs(saved.latitude - place.latitude) < 0.01 &&
          Math.abs(saved.longitude - place.longitude) < 0.01
        )
          continue;
        const group = new Group();
        const halo = new Mesh(disc, savedHalo);
        halo.scale.setScalar(0.028);
        const core = new Mesh(disc, savedCore);
        core.scale.setScalar(0.0065);
        core.position.z = 0.0012;
        group.add(halo, core);
        marker(position, group);
        savedGroup.add(group);
      }
      markerPlaces.push({ place, position: selected.position.clone() });
      invalidate();
    },
    setOutlines(segments) {
      if (outlineGeometry) {
        scene.remove(...outlineLines);
        life.drop(outlineGeometry);
        outlineGeometry = null;
        outlineLines = [];
      }
      const points = segments.reduce((total, part) => total + part.length, 0);
      if (points) {
        const all = new Float32Array(points);
        let offset = 0;
        for (const part of segments) {
          all.set(part, offset);
          offset += part.length;
        }
        const geometry = keep(new LineSegmentsGeometry().setPositions(all));
        outlineGeometry = geometry;
        outlineLines = outlineMaterials.map((material, index) => {
          const shape = new LineSegments2(geometry, material);
          shape.renderOrder = 2 + index;
          return shape;
        });
        scene.add(...outlineLines);
      }
      invalidate();
    },
    setImage(layer, image) {
      if (shown[layer] === image) return;
      shown[layer] = image;
      const uniform = earthMaterial.uniforms[layer === 'base' ? 'baseMap' : 'dailyMap'];
      life.drop(uniform.value as Texture);
      if (image) {
        const texture: Texture = keep(new Texture(image));
        texture.colorSpace = SRGBColorSpace;
        // An ImageBitmap ignores flipY, so no image is flipped: the shader reads rows from north.
        texture.flipY = false;
        texture.wrapS = RepeatWrapping;
        texture.minFilter = LinearMipmapLinearFilter;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        texture.needsUpdate = true;
        uniform.value = texture;
      } else uniform.value = blank();
      if (layer === 'base') earthMaterial.uniforms.baseReady.value = image ? 1 : 0;
      else {
        const mix = earthMaterial.uniforms.dailyMix;
        const next = dailyLayer(mix.value, { visible: dailyVisible, image: !!image });
        dailyTarget = next.target;
        mix.value = next.mix;
        earthMaterial.uniforms.dailyShown.value = next.mix / DAILY_OPACITY;
      }
      touch();
      invalidate();
    },
    setDailyVisible(visible) {
      dailyVisible = visible;
      const mix = earthMaterial.uniforms.dailyMix.value as number;
      dailyTarget = dailyLayer(mix, { visible, image: !!shown.daily }).target;
      touch();
      invalidate();
    },
    setMotion(on, turn) {
      // Turning by itself starts when it is switched on: as the globe starts, and on Play.
      if (on && turn && !(animate && rotate)) turnStart = performance.now();
      animate = on;
      rotate = turn;
      controls.enableDamping = on;
      if (!on && flight) {
        show(flight.to);
        flight = null;
      }
      if (on) touch();
      invalidate();
    },
    rotate(action) {
      const target = stepView(flight ? flight.to : view(), action, limits());
      flyTo(target, 260);
      return target;
    },
    zoom(factor) {
      const start = flight ? flight.to : view();
      const target = stepView(start, { kind: 'zoom', factor }, limits());
      flyTo(target, 220);
      if (target.distance <= MIN_DISTANCE + 1e-6) return 'closest';
      if (target.distance >= controls.maxDistance - 1e-6) return 'furthest';
      return factor < 1 ? 'in' : 'out';
    },
    reset() {
      if (current) flyTo(placeView(current, fit), 900);
    },
    centre() {
      const { latitude, longitude } = flight ? flight.to : view();
      return { latitude, longitude };
    },
    dispose() {
      life.dispose();
    },
  };
}
