/**
 * Helpers for the 3D globe (components/GlobeView.tsx, globe-scene.ts) and the satellite map:
 * positions on the globe, the sun's position and the day/night shading, NASA GIBS whole-Earth
 * images and where they have pixels, which daily mosaic to show and when to look for a newer one,
 * warning outlines, keyboard and button steps, when to draw, what the globe says in each state,
 * and the image and mosaic loaders, whose network and decoder are passed in. The decisions that
 * GlobeView's effects and the scene act on are here too, so the tests can check each of them:
 * when three.js may load, which imagery to request and draw, when to look again, where focus goes
 * and how the globe moves. Nothing here imports three.js, so the map and the tests can use it
 * without the 3D code.
 */
import { sourceClock } from './connectivity';
import { alertOutline } from './data';
import { normalizeLongitude, type ImagerySource } from './imagery';
import type { Place, WeatherAlert } from './types';

const RAD = Math.PI / 180;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export type Vector = [x: number, y: number, z: number];
export interface LatLon {
  latitude: number;
  longitude: number;
}

/**
 * The point at `latitude`, `longitude` on a sphere of `radius`. +Y is north; longitude 0 lies on +X
 * and 90° E on −Z, which is how three.js's SphereGeometry lays an equirectangular image.
 */
export function latLonToVector(latitude: number, longitude: number, radius = 1): Vector {
  const phi = latitude * RAD;
  const lambda = longitude * RAD;
  return [
    radius * Math.cos(phi) * Math.cos(lambda),
    radius * Math.sin(phi),
    -radius * Math.cos(phi) * Math.sin(lambda),
  ];
}

/** The latitude and longitude (−180 to under 180) of a point; a pole reports longitude 0. */
export function vectorToLatLon([x, y, z]: Vector): LatLon {
  const length = Math.hypot(x, y, z);
  if (!(length > 0) || !Number.isFinite(length)) throw new Error('A position needs a direction.');
  const horizontal = Math.hypot(x, z);
  // atan2 keeps its precision next to the poles, where asin(y / length) loses it.
  const latitude = Math.atan2(y, horizontal) / RAD;
  const longitude = horizontal <= length * 1e-12 ? 0 : normalizeLongitude(Math.atan2(-z, x) / RAD);
  return { latitude, longitude };
}

/**
 * Where the sun is overhead at `time`, from the Astronomical Almanac's low-precision solar
 * coordinates: within about 0.05° of latitude and 0.25° of longitude this century.
 */
export function subsolarPoint(time: number): LatLon {
  const days = time / 86_400_000 - 10_957.5; // since J2000.0, 2000-01-01 12:00 UTC
  const meanLongitude = 280.46 + 0.9856474 * days;
  const anomaly = (357.528 + 0.9856003 * days) * RAD;
  const ecliptic = (meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * days) * RAD;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(ecliptic));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(ecliptic), Math.cos(ecliptic));
  const siderealTime = 280.46061837 + 360.98564736629 * days;
  return {
    latitude: declination / RAD,
    longitude: normalizeLongitude(rightAscension / RAD - siderealTime),
  };
}

/** Where the sun lies from Earth's centre at `time`, as a unit vector in the globe's frame. */
export function sunDirection(time: number): Vector {
  const { latitude, longitude } = subsolarPoint(time);
  return latLonToVector(latitude, longitude);
}

/** The sun's height above the horizon at a place, in degrees, ignoring refraction. */
export function solarElevation(latitude: number, longitude: number, time: number): number {
  const [a, b] = [latLonToVector(latitude, longitude), sunDirection(time)];
  const cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosine))) / RAD;
}

/**
 * How the sky reads where the sun stands `elevation` degrees above the horizon: daylight once its
 * upper edge has risen (−0.833° with refraction), civil twilight down to −6°, then night.
 */
export function daylight(elevation: number): { phase: 'day' | 'twilight' | 'night'; text: string } {
  if (!Number.isFinite(elevation)) return { phase: 'night', text: 'Sun position unknown' };
  if (elevation >= -0.833) {
    const up = Math.round(elevation);
    return {
      phase: 'day',
      text: up >= 1 ? `Daylight · sun ${up}° up` : 'Daylight · sun on the horizon',
    };
  }
  const below = `sun ${Math.max(1, Math.round(-elevation))}° below the horizon`;
  return elevation >= -6
    ? { phase: 'twilight', text: `Twilight · ${below}` }
    : { phase: 'night', text: `Night · ${below}` };
}

/**
 * Day and night on the globe, in linear light: the shader in GlobeView.tsx is SHADING_GLSL, built
 * from these numbers, and `shade` is the same curve for the tests. `light` is the cosine of the
 * sun's angle from the zenith (1 overhead, 0 on the terminator, negative at night).
 * - Day: an ambient share plus direct light that grows with the sun's height.
 * - Night: a dim, cool, partly desaturated copy of the surface, about a fifth of day's brightness
 *   on screen, so the dark side reads as night while continents and cloud stay faintly visible.
 * - The terminator: day gives way to night over a few degrees, edged with a violet twilight line.
 */
export const SHADING = {
  ambient: 0.3,
  direct: 0.78,
  dusk: -0.04,
  dawn: 0.1,
  night: [0.019, 0.023, 0.038] as Vector,
  nightGlow: 0.003,
  twilight: 0.08,
  twilightWidth: 0.045,
} as const;
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** The shaded colour of a `surface` (linear RGB) where the sun's light is `light`. */
export function shade(surface: Vector, light: number, violet: Vector): Vector {
  const { ambient, direct, dusk, dawn, night, nightGlow, twilight, twilightWidth } = SHADING;
  const day = smoothstep(dusk, dawn, light);
  const sunlit = ambient + direct * Math.sqrt(Math.max(light, 0));
  const grey = 0.2126 * surface[0] + 0.7152 * surface[1] + 0.0722 * surface[2];
  const line = twilight * Math.exp(-((light / twilightWidth) ** 2));
  return surface.map((channel, index) => {
    const dark = (grey + (channel - grey) * 0.6) * night[index] + violet[index] * nightGlow;
    return dark + (channel * sunlit - dark) * day + violet[index] * line;
  }) as Vector;
}
const glsl = (value: number) => value.toFixed(4);
/** `shade` in GLSL, for the globe's surface shader. */
export const SHADING_GLSL = /* glsl */ `
  vec3 shade(vec3 surface, float light, vec3 violet) {
    float day = smoothstep(${glsl(SHADING.dusk)}, ${glsl(SHADING.dawn)}, light);
    vec3 sunlit = surface * (${glsl(SHADING.ambient)} + ${glsl(SHADING.direct)} * sqrt(max(light, 0.0)));
    float grey = dot(surface, vec3(0.2126, 0.7152, 0.0722));
    vec3 dark = mix(vec3(grey), surface, 0.6) * vec3(${SHADING.night.map(glsl).join(', ')}) + violet * ${glsl(SHADING.nightGlow)};
    float line = ${glsl(SHADING.twilight)} * exp(-pow(light / ${glsl(SHADING.twilightWidth)}, 2.0));
    return mix(dark, sunlit, day) + violet * line;
  }
`;
/** A linear-light channel as the screen shows it (sRGB, 0 to 1). */
export function srgbEncode(linear: number): number {
  const value = clamp(linear, 0, 1);
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}
/** A linear-light sRGB channel from a display value (0 to 1). */
export function srgbDecode(display: number): number {
  return display <= 0.04045 ? display / 12.92 : ((display + 0.055) / 1.055) ** 2.4;
}

/** "13.08°N, 80.27°E", as the map names a selected point. */
export function coordinateLabel(latitude: number, longitude: number): string {
  return `${Math.abs(latitude).toFixed(2)}°${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(2)}°${longitude < 0 ? 'W' : 'E'}`;
}

/**
 * The place that a click on the map or the globe selects: the point itself, to four decimals. A
 * point has no country, so the warning panel asks for a named city instead of checking a source.
 */
export function pointPlace(latitude: number, longitude: number): Place {
  const lat = Number(latitude.toFixed(4));
  const lon = Number(normalizeLongitude(longitude).toFixed(4));
  return {
    id: `map:${lat}:${lon}`,
    name: coordinateLabel(lat, lon),
    latitude: lat,
    longitude: lon,
    country: 'Selected map point',
    countryCode: '',
  };
}

// NASA GIBS whole-Earth images (WMS 1.3.0, EPSG:4326). Verified 18 November 2026: both layers return
// a 2048×1024 JPEG of about 0.3 MB with `Access-Control-Allow-Origin: *` (docs/imagery.md).
export const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
export const GLOBE_IMAGE_WIDTH = 2048;
/** A static composite: relief and sea floor, no clouds and no date. */
export const GLOBE_BASE_LAYER = 'BlueMarble_ShadedRelief_Bathymetry';
/** The daily true-colour mosaic. Its dates come from the provider (imagery.ts fetchImageryFrames). */
export const GLOBE_DAILY: ImagerySource = {
  id: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
  name: 'NOAA-20 VIIRS · true colour',
  kind: 'daily',
  matrix: 'GoogleMapsCompatible_Level9',
  maxNativeZoom: 9,
  format: 'jpeg',
  resolution: 'Shown at about 20 km per pixel on the globe',
  coverage: 'Daytime passes worldwide; night, polar darkness and processing gaps stay blank.',
  cadence: 'Daily mosaic',
  attribution: 'NASA EOSDIS GIBS / NOAA-20 VIIRS',
};

function isUtcDate(text: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(text) &&
    !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) &&
    new Date(`${text}T00:00:00Z`).toISOString().startsWith(text)
  );
}
/** The UTC calendar date of `time`, as GIBS names daily mosaics. */
export function utcDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
/** "17 Nov 2026": a daily mosaic's date, read in UTC like the provider's. */
export function mosaicDateLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** A whole-Earth GIBS image of `layer`, on the advertised UTC `date` for a daily layer. */
export function globeImageUrl(layer: string, date?: string, width = GLOBE_IMAGE_WIDTH): string {
  if (!/^[A-Za-z0-9_-]+$/.test(layer)) throw new Error('Invalid imagery layer.');
  if (date !== undefined && !isUtcDate(date)) throw new Error('Invalid imagery date.');
  if (!Number.isInteger(width) || width < 256 || width > 4096 || width % 2)
    throw new Error('Invalid image size.');
  // WMS 1.3.0 gives EPSG:4326 bounds latitude first. GIBS' CGI reads literal separators (imagery.ts).
  return `${GIBS_WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${width}&HEIGHT=${width / 2}&FORMAT=image/jpeg${date ? `&TIME=${date}` : ''}`;
}

/**
 * The daily mosaics the globe may show, newest first: the newest advertised day that has ended in
 * UTC, whose passes should all be in, then the advertised day before it; or the newest advertised
 * day alone when no earlier one is listed. Never a day that is not advertised, and never one after
 * today's UTC date.
 */
export function globeDailyCandidates(
  frames: readonly string[],
  now = Date.now(),
  count = 2,
): string[] {
  const today = utcDate(now);
  const advertised = [...new Set(frames.filter((frame) => isUtcDate(frame) && frame <= today))]
    .sort()
    .reverse();
  const ended = advertised.filter((frame) => frame < today);
  return (ended.length ? ended : advertised).slice(0, count);
}
/** The daily mosaic the globe tries first (globeDailyCandidates). */
export function globeDailyDate(frames: readonly string[], now = Date.now()): string | null {
  return globeDailyCandidates(frames, now, 1)[0] ?? null;
}

/**
 * A mosaic that images less of Earth than this is partial (a late or interrupted day): the globe
 * tries the day before, and shows whichever covers more.
 */
export const MIN_DAILY_COVERAGE = 0.8;
/**
 * Which of the loaded mosaics (newest first) to show: the newest that covers enough of Earth, or
 * else whichever covers clearly more, the newer when they are close. A coverage that could not be
 * measured counts as enough, so it never sends the globe to an older day.
 */
export function pickDaily(
  loaded: readonly { coverage: number | null }[],
  min = MIN_DAILY_COVERAGE,
): number {
  const enough = loaded.findIndex(({ coverage }) => coverage === null || coverage >= min);
  if (enough >= 0 || !loaded.length) return enough;
  let best = 0;
  loaded.forEach(({ coverage }, index) => {
    if ((coverage ?? 0) > (loaded[best].coverage ?? 0) + 0.02) best = index;
  });
  return best;
}
/** How often a page left open looks again while the shown mosaic is not yet the full newest one. */
export const RECHECK_MS = 3_600_000;
/**
 * Whether a page left open should look for a newer daily mosaic, `checkedAt` being when it last
 * looked: once the UTC day of that check has ended, and hourly while the shown mosaic is partial,
 * is older than the newest one listed, or the last check failed. Never while a first load runs.
 */
export function mosaicRecheck(
  daily: DailyImagery,
  checkedAt: number | null,
  now = Date.now(),
): boolean {
  if (checkedAt === null || daily.state === 'loading') return false;
  if (utcDate(now) !== utcDate(checkedAt)) return true;
  // A clock set back since the check leaves the difference negative: wait for the next day.
  if (!(now - checkedAt >= RECHECK_MS)) return false;
  if (daily.state === 'failed') return true;
  return (
    daily.skipped !== null ||
    daily.refreshError !== null ||
    (daily.coverage !== null && daily.coverage < MIN_DAILY_COVERAGE)
  );
}
/** How often GlobeView's timer asks shouldLook. */
export const LOOK_TIMER_MS = 60_000;
/**
 * Whether GlobeView's minute timer looks for a newer mosaic now: only in a page that is shown and
 * online, and only when one is due (mosaicRecheck), so the timer itself downloads nothing.
 */
export function shouldLook({
  hidden,
  online,
  daily,
  checkedAt,
  now,
}: {
  hidden: boolean;
  online: boolean;
  daily: DailyImagery;
  checkedAt: number | null;
  now: number;
}): boolean {
  return !hidden && online && mosaicRecheck(daily, checkedAt, now);
}

/** GIBS fills missing pixels with black; anything brighter than this in some channel is imagery. */
export const GAP_LEVEL = 12;
/**
 * Where a daily mosaic has pixels: 1 for imagery, 0 for GIBS's black gap fill, from an
 * equirectangular RGBA copy whose rows run from north to south and columns east from 180° W.
 */
export interface ImageryMask {
  width: number;
  height: number;
  data: Uint8Array;
}
export function imageryMask(pixels: ArrayLike<number>, width: number, height: number): ImageryMask {
  const ok = width > 0 && height > 0 && pixels.length >= width * height * 4;
  const data = new Uint8Array(ok ? width * height : 0);
  for (let index = 0; index < data.length; index++) {
    const at = index * 4;
    data[index] = Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) > GAP_LEVEL ? 1 : 0;
  }
  return { width: ok ? width : 0, height: ok ? height : 0, data };
}
/**
 * The share of Earth's surface with imagery. Each row counts for the area it covers (the cosine of
 * its latitude), so polar rows weigh little.
 */
export function imageryCoverage({ width, height, data }: ImageryMask): number {
  if (!(width > 0 && height > 0) || data.length < width * height) return 0;
  let covered = 0;
  let total = 0;
  for (let row = 0; row < height; row++) {
    const weight = Math.cos((90 - ((row + 0.5) * 180) / height) * RAD);
    let count = 0;
    for (let column = 0; column < width; column++) count += data[row * width + column];
    covered += (weight * count) / width;
    total += weight;
  }
  return total ? covered / total : 0;
}
/**
 * Whether the mosaic has imagery at a place: the mask's pixel that holds it. Null for an empty
 * mask or a place without coordinates.
 */
export function imagedAt(mask: ImageryMask, latitude: number, longitude: number): boolean | null {
  const { width, height, data } = mask;
  if (!(width > 0 && height > 0) || data.length < width * height) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const column = Math.min(
    width - 1,
    Math.floor(((normalizeLongitude(longitude) + 180) / 360) * width),
  );
  const row = clamp(Math.floor(((90 - latitude) / 180) * height), 0, height - 1);
  return data[row * width + column] === 1;
}

// What the globe shows in each state, so that its copy is true in every one of them.
export type GlobeStatus = 'starting' | 'ready' | 'unsupported' | 'lost' | 'failed';
export type BaseImagery =
  { state: 'loading' } | { state: 'ready' } | { state: 'failed'; message: string };
export interface DailyMosaic {
  date: string;
  coverage: number | null;
  mask: ImageryMask | null;
  /** A newer mosaic the globe passed over: its coverage, or null when it did not load. */
  skipped: { date: string; coverage: number | null } | null;
}
export type DailyImagery =
  | { state: 'loading' }
  | ({
      state: 'ready';
      /** A later look for a newer mosaic failed; this one is still shown, with its date. */
      refreshError: string | null;
    } & DailyMosaic)
  | { state: 'failed'; message: string };
export type DailyEvent =
  { type: 'start' } | { type: 'loaded'; mosaic: DailyMosaic } | { type: 'failed'; message: string };
/**
 * The daily layer after a load starts, succeeds or fails. A mosaic on show stays on show, with its
 * date, while a newer one is looked for and when that look fails: the globe never keeps drawing
 * clouds that its copy calls missing, and never drops real observations for a failed check.
 */
export function nextDaily(previous: DailyImagery, event: DailyEvent): DailyImagery {
  if (event.type === 'loaded') return { state: 'ready', ...event.mosaic, refreshError: null };
  if (previous.state === 'ready')
    return event.type === 'start' ? previous : { ...previous, refreshError: event.message };
  return event.type === 'start'
    ? { state: 'loading' }
    : { state: 'failed', message: event.message };
}
/**
 * The mosaic on the globe, or null. GlobeView draws the daily layer from this alone, and the card
 * dates it from this alone, so the two always agree.
 */
export function shownMosaic(daily: DailyImagery, showDaily: boolean) {
  return showDaily && daily.state === 'ready' ? daily : null;
}
/** The base image the scene draws: the one loaded, and only while the base layer is ready. */
export function sceneBase<T>(base: BaseImagery, image: T | null): T | null {
  return base.state === 'ready' ? image : null;
}
/**
 * The mosaic the scene draws: the image loaded, and only while the daily state is ready with that
 * image's date. So the globe never keeps drawing clouds that the card does not date.
 */
export function sceneDaily<T>(
  daily: DailyImagery,
  kept: { date: string; source: T } | null,
): T | null {
  return daily.state === 'ready' && kept?.date === daily.date ? kept.source : null;
}
/** The layers that Try again asks NASA for: only one that failed, or whose last look failed. */
export function retryLayers(base: BaseImagery, daily: DailyImagery) {
  return {
    base: base.state === 'failed',
    daily: daily.state === 'failed' || (daily.state === 'ready' && !!daily.refreshError),
  };
}
/**
 * One imagery request for the scene. Its result is reported unless it was cancelled first (the
 * globe left, or a retry replaced it); a failure is reported as its message, or `fallback`.
 * Returns the cancel, for the effect's cleanup.
 */
export function requestImagery<T>(
  load: (signal: AbortSignal) => Promise<T>,
  report: { loaded(value: T): void; failed(message: string): void },
  fallback: string,
): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  let pending: Promise<T>;
  try {
    pending = load(signal);
  } catch (error) {
    pending = Promise.reject(error);
  }
  pending.then(
    (value) => {
      if (!signal.aborted) report.loaded(value);
    },
    (error: unknown) => {
      if (!signal.aborted)
        report.failed(error instanceof Error && error.message ? error.message : fallback);
    },
  );
  return () => controller.abort();
}
/** Whether the 3D view runs, or is about to: otherwise nothing is drawn. */
export const globeDraws = (status: GlobeStatus) => status === 'starting' || status === 'ready';

/**
 * What the card says where the 3D view does not draw, and whether Restart can bring it back; null
 * while it draws.
 */
export function globeFallback(
  status: GlobeStatus,
): { title: string; text: string; restart: boolean } | null {
  const still = 'Search, quick locations and the satellite map still select places.';
  if (status === 'unsupported')
    return {
      title: '3D view unavailable',
      text: `This browser could not start WebGL 2, so the globe is off. ${still}`,
      restart: false,
    };
  if (status === 'lost')
    return {
      title: 'The 3D view stopped',
      text: `The browser reset its graphics, so the globe paused. ${still}`,
      restart: true,
    };
  if (status === 'failed')
    return {
      title: 'The 3D view stopped',
      text: `The globe could not draw a frame, so it stopped. ${still}`,
      restart: true,
    };
  return null;
}

/** Where GlobeView moves keyboard focus once the globe's status changes. */
export type FocusTarget = 'restart' | 'surface';
/**
 * Where focus that was in the globe's card goes when the globe stops or comes back: to Restart
 * when it stops, as its controls go, so focus never drops to the page; to the globe when it is
 * drawing again. Focus elsewhere on the page is left alone: the move already `pending` stays.
 */
export function focusAfterStatus(
  focusInCard: boolean,
  next: GlobeStatus,
  pending: FocusTarget | null,
): FocusTarget | null {
  if (!focusInCard) return pending;
  if (next === 'ready') return 'surface';
  return globeFallback(next)?.restart ? 'restart' : pending;
}
/** The pending focus move that `status` allows now, when its target is on screen; else null. */
export function focusNow(target: FocusTarget | null, status: GlobeStatus): FocusTarget | null {
  if (target === 'restart') return globeFallback(status)?.restart ? 'restart' : null;
  return target === 'surface' && status === 'ready' ? 'surface' : null;
}

/** What startGlobe needs: GlobeView passes the browser's (globe-scene.ts), the tests fakes. */
export interface GlobeStarter<Probe, Kit, Scene extends { dispose(): void }> {
  /** A WebGL 2 context, or null where the browser has none. */
  openContext(): Probe | null;
  /** three.js, downloaded on demand. */
  loadThree(): Promise<Kit>;
  /** The scene on the probe's context, or null when three.js cannot start a renderer there. */
  create(three: Kit, probe: Probe): Scene | null;
  /** Gives the probe's context back to the browser. */
  release(probe: Probe): void;
}
/** What startGlobe reports. */
export interface GlobeStart<Scene> {
  status(status: 'starting' | 'unsupported'): void;
  ready(scene: Scene): void;
  /** three.js did not arrive: the card hands over to App's notice for an optional tool. */
  failed(error: Error): void;
}
/**
 * Starts a globe: the WebGL 2 context first, and three.js only once it is there, so a browser
 * without WebGL 2 never downloads it. Returns the stop for the effect's cleanup (the globe leaves
 * or restarts): it gives the context back while three.js is still on its way, or disposes the
 * scene once it exists, exactly once. A result that arrives after the stop is dropped.
 */
export function startGlobe<Probe, Kit, Scene extends { dispose(): void }>(
  starter: GlobeStarter<Probe, Kit, Scene>,
  on: GlobeStart<Scene>,
): () => void {
  const probe = starter.openContext();
  if (!probe) {
    on.status('unsupported');
    return () => {};
  }
  on.status('starting');
  let stopped = false;
  let released = false;
  let scene: Scene | null = null;
  const release = () => {
    if (released) return;
    released = true;
    starter.release(probe);
  };
  starter
    .loadThree()
    .then((three) => {
      if (stopped) return;
      scene = starter.create(three, probe);
      if (scene) on.ready(scene);
      else {
        release();
        on.status('unsupported');
      }
    })
    .catch((error: unknown) => {
      if (stopped || scene) return;
      release();
      on.failed(error instanceof Error ? error : new Error('The 3D globe could not load.'));
    });
  return () => {
    if (stopped) return;
    stopped = true;
    if (scene) scene.dispose();
    else release();
  };
}

/**
 * What the globe says when NASA imagery did not load, or a look for a newer mosaic failed, so a
 * missing layer never reads as a view of the weather and an older mosaic is never taken for a
 * newer one.
 */
export function imageryNotice(base: BaseImagery, daily: DailyImagery): string | null {
  if (base.state === 'failed' && daily.state === 'failed')
    return `NASA imagery did not load: ${base.message} The globe is a plain sphere; that is missing imagery, not a view of the weather.`;
  const parts: string[] = [];
  if (base.state === 'failed')
    parts.push(
      `The Blue Marble base image did not load: ${base.message} Outside the daily mosaic the globe is a plain sphere; that is missing imagery, not a view of the weather.`,
    );
  if (daily.state === 'failed')
    parts.push(
      `The daily satellite mosaic did not load: ${daily.message} Without it the globe shows the static Blue Marble base, which has no clouds and no date.`,
    );
  if (daily.state === 'ready' && daily.refreshError)
    parts.push(
      `NASA could not be checked for a newer daily mosaic: ${daily.refreshError} The globe still shows the ${mosaicDateLabel(daily.date)} mosaic.`,
    );
  return parts.length ? parts.join(' ') : null;
}

/**
 * The imagery to credit: the layers on the globe now, and whether one is still loading. Null when
 * no imagery is drawn or on its way, as when both images failed.
 */
export function imageryCredit(
  base: BaseImagery,
  daily: DailyImagery,
  showDaily: boolean,
): { base: boolean; daily: boolean; loading: boolean } | null {
  const credit = {
    base: base.state === 'ready',
    daily: !!shownMosaic(daily, showDaily),
    loading: base.state === 'loading' || (showDaily && daily.state === 'loading'),
  };
  return credit.base || credit.daily || credit.loading ? credit : null;
}

/** The line under the globe's title. */
export function globeSubtitle(
  status: GlobeStatus,
  base: BaseImagery,
  daily: DailyImagery,
  showDaily: boolean,
): string {
  if (status === 'unsupported') return 'The 3D view is not available in this browser.';
  if (!globeDraws(status)) return 'The 3D view stopped. Restart it to see the globe again.';
  const now = 'Day and night as they fall right now';
  const mosaic = shownMosaic(daily, showDaily);
  if (mosaic)
    return `${now}, over NASA's ${mosaicDateLabel(mosaic.date)} satellite mosaic.${base.state === 'failed' ? ' The base map did not load.' : ''}`;
  if (base.state === 'failed')
    return `${now}. ${daily.state === 'failed' ? 'NASA imagery did not load.' : 'The base map did not load.'}`;
  if (base.state === 'ready' && (!showDaily || daily.state === 'failed'))
    return `${now}, over NASA's cloud-free Blue Marble map.`;
  return `${now}, over NASA satellite imagery.`;
}

/** The note on official warning outlines, which never reads an empty globe as no warning. */
export function outlineNote(status: GlobeStatus, outlined: number, total: number): string {
  if (!globeDraws(status))
    return 'The 3D view cannot draw warning outlines here. The warning list and the satellite map show official warnings.';
  const more = total - outlined;
  if (outlined)
    return `${outlined} active official warning ${outlined === 1 ? 'area is' : 'areas are'} outlined in red.${more > 0 ? ` ${more} more ${more === 1 ? 'has' : 'have'} no outline to draw.` : ''}`;
  if (total) return 'Active warnings for this place have no outline to draw.';
  return 'Red outlines appear only for active official warnings supplied with one. No outline here does not mean there is no warning.';
}

/**
 * What the selected place's card says about imagery there: whether the daily mosaic has pixels at
 * the place, so a cloud-free base map is never read as clear weather.
 */
export function placeImagery(
  status: GlobeStatus,
  base: BaseImagery,
  daily: DailyImagery,
  showDaily: boolean,
  latitude: number,
  longitude: number,
): { kind: 'pending' | 'imaged' | 'gap' | 'none'; text: string } | null {
  if (!globeDraws(status)) return null;
  if (!showDaily)
    return base.state === 'failed'
      ? { kind: 'none', text: 'Daily mosaic hidden; no NASA imagery loaded' }
      : { kind: 'none', text: 'Daily mosaic hidden; the base map has no clouds' };
  const mosaic = shownMosaic(daily, showDaily);
  if (!mosaic) {
    if (daily.state === 'loading') return { kind: 'pending', text: 'Checking NASA imagery…' };
    return base.state === 'failed'
      ? { kind: 'none', text: 'No NASA imagery loaded' }
      : { kind: 'none', text: 'No daily imagery; the base map has no clouds' };
  }
  const day = mosaicDateLabel(mosaic.date).replace(/ \d{4}$/, '');
  const here = mosaic.mask ? imagedAt(mosaic.mask, latitude, longitude) : null;
  if (here === false)
    return { kind: 'gap', text: `No imagery here on ${day}: map shown without clouds` };
  if (here === true) return { kind: 'imaged', text: `Imaged by NOAA-20 on ${day}` };
  return { kind: 'imaged', text: `NOAA-20 mosaic of ${day}; coverage here unknown` };
}

/** Why the globe shows an older mosaic than the newest one NASA lists, or null. */
export function dailyNote(daily: DailyImagery): string | null {
  if (daily.state !== 'ready' || !daily.skipped) return null;
  const { date, coverage } = daily.skipped;
  return coverage === null
    ? `NASA's ${mosaicDateLabel(date)} mosaic did not load, so the globe shows ${mosaicDateLabel(daily.date)}.`
    : `NASA's ${mosaicDateLabel(date)} mosaic covers only ${Math.round(coverage * 100)}% of Earth, so the globe shows ${mosaicDateLabel(daily.date)}.`;
}

/** The largest response the globe reads as an image, and how long it waits for one. */
export const MAX_IMAGE_BYTES = 6_000_000;
export const IMAGE_TIMEOUT_MS = 30_000;
export interface DecodedImage<T> {
  source: T;
  width: number;
  height: number;
}
/** The network, connection state and image decoder that readGlobeImage uses. */
export interface ImageReader<T> {
  fetch(url: string, init: RequestInit): Promise<Response>;
  online(): boolean;
  decode(blob: Blob): Promise<DecodedImage<T>>;
  timeoutMs?: number;
  maxBytes?: number;
}
const TOO_LARGE = 'NASA imagery exceeded the size limit.';
/** A response body as a Blob of `type`, refusing more than `limit` bytes. */
export async function readCapped(response: Response, type: string, limit = MAX_IMAGE_BYTES) {
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error(TOO_LARGE);
  }
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > limit) throw new Error(TOO_LARGE);
    return blob;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(TOO_LARGE);
      parts.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new Blob(parts, { type });
}
/**
 * A GIBS whole-Earth image, read through CORS without credentials and decoded. Nothing is requested
 * while the browser is offline. Every failure becomes a message the globe can show as it is.
 */
export async function readGlobeImage<T>(
  url: string,
  signal: AbortSignal,
  reader: ImageReader<T>,
): Promise<DecodedImage<T>> {
  if (!reader.online()) throw new Error('Imagery waits for a connection.');
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, reader.timeoutMs ?? IMAGE_TIMEOUT_MS);
  try {
    const response = await reader.fetch(url, {
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
    });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !/^image\/(?:jpeg|png)\b/i.test(type)) {
      void response.body?.cancel().catch(() => {});
      throw new Error(
        response.ok
          ? 'NASA sent a message instead of an image.'
          : `NASA imagery is unavailable (${response.status}).`,
      );
    }
    const blob = await readCapped(response, type, reader.maxBytes ?? MAX_IMAGE_BYTES);
    const image = await reader.decode(blob).catch(() => {
      throw new Error('NASA sent an image that could not be read.');
    });
    if (!(image.height > 0) || image.width !== 2 * image.height)
      throw new Error('NASA sent an image of an unexpected shape.');
    return image;
  } catch (error) {
    if (signal.aborted) throw error;
    if (timedOut) throw new Error('NASA imagery timed out. Check your connection or try again.');
    if (error instanceof TypeError)
      throw new Error('NASA imagery could not be reached. Check your connection or try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/**
 * Decoded whole-Earth images, by address. They stay while a globe is open (`hold`) and for
 * `releaseAfter` ms after the last one closes (`release`), so a restored context or a quick switch
 * of connection mode downloads nothing again; then each is closed and forgotten. At most `limit`
 * are kept; older ones are only forgotten, since a globe may still show them.
 */
export function createImageCache<T>({
  close,
  releaseAfter = 60_000,
  limit = 3,
  // Called as functions, never as methods of this object: a browser refuses a detached
  // clearTimeout ("Illegal invocation").
  timers = {
    set: (run: () => void, ms: number) => setTimeout(run, ms),
    clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  },
}: {
  close(image: T): void;
  releaseAfter?: number;
  limit?: number;
  timers?: {
    set(run: () => void, ms: number): ReturnType<typeof setTimeout>;
    clear(timer: ReturnType<typeof setTimeout>): void;
  };
}) {
  const images = new Map<string, T>();
  let open = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };
  return {
    get: (url: string) => images.get(url),
    set(url: string, image: T) {
      images.delete(url);
      images.set(url, image);
      for (const old of [...images.keys()].slice(0, -limit)) images.delete(old);
    },
    forget: (url: string) => void images.delete(url),
    hold() {
      open++;
      cancel();
    },
    release() {
      open = Math.max(0, open - 1);
      if (open) return;
      cancel();
      timer = timers.set(() => {
        timer = undefined;
        for (const image of images.values()) close(image);
        images.clear();
      }, releaseAfter);
    },
    get size() {
      return images.size;
    },
  };
}

/**
 * A key for the markers on the globe: it changes when a saved place or the selected one changes
 * its name or position, so a click on a marker always selects the place as it is now.
 */
export function markersKey(saved: readonly Place[], selected: Place): string {
  return [...saved, selected]
    .map(({ id, name, latitude, longitude }) => JSON.stringify([id, name, latitude, longitude]))
    .join('|');
}

/** What loadDailyMosaic uses to reach NASA: GlobeView passes the real ones, tests fakes. */
export interface MosaicLoader<T> {
  online(): boolean;
  /** The daily layer's advertised dates (imagery.ts fetchImageryFrames); `force` skips its cache. */
  frames(signal: AbortSignal, force: boolean): Promise<string[]>;
  /** A whole-Earth image (readGlobeImage), from memory when the page holds it. */
  image(url: string, signal: AbortSignal): Promise<DecodedImage<T>>;
  /** The image the page holds in memory for `url`, if any: nothing is downloaded. */
  held(url: string): DecodedImage<T> | undefined;
  /** Where the image has pixels, or null when that cannot be measured. */
  measure(image: DecodedImage<T>): ImageryMask | null;
  /** Lets go of a held image, so the next read downloads it again. */
  forget(url: string): void;
}
export interface LoadedMosaic<T> extends DailyMosaic {
  image: DecodedImage<T>;
}
/** Whether the page holds `url` as a partial mosaic, one that may still fill in. */
function heldPartial<T>(loader: MosaicLoader<T>, url: string): boolean {
  const held = loader.held(url);
  const mask = held ? loader.measure(held) : null;
  return !!mask && imageryCoverage(mask) < MIN_DAILY_COVERAGE;
}
/**
 * The daily mosaic to show. The newest day that has ended in UTC comes first; when it images less
 * than MIN_DAILY_COVERAGE of Earth, or does not load, the day before is tried and the one that
 * covers more is shown (pickDaily), with the newer one named in the notes. Nothing is asked while
 * offline. A first load reads NASA's dates from the five-minute cache and any image the page still
 * holds, as after a quick switch of connection mode. A look (`refresh`, hourly or Try again) asks
 * NASA for its dates again and reads again each partial mosaic it holds, as one may have filled
 * in; a mosaic that covered enough is not downloaded again.
 */
export async function loadDailyMosaic<T>(
  loader: MosaicLoader<T>,
  signal: AbortSignal,
  { refresh = false, now = Date.now() }: { refresh?: boolean; now?: number } = {},
): Promise<LoadedMosaic<T>> {
  if (!loader.online()) throw new Error('Imagery waits for a connection.');
  const candidates = globeDailyCandidates(await loader.frames(signal, refresh), now);
  if (!candidates.length) throw new Error('NASA has not listed a recent daily mosaic.');
  const loaded: (DailyMosaic & { image: DecodedImage<T> })[] = [];
  let failure: unknown = null;
  for (const date of candidates) {
    const url = globeImageUrl(GLOBE_DAILY.id, date);
    if (refresh && heldPartial(loader, url)) loader.forget(url);
    let coverage: number | null;
    try {
      const image = await loader.image(url, signal);
      const mask = loader.measure(image);
      coverage = mask ? imageryCoverage(mask) : null;
      loaded.push({ date, image, mask, coverage, skipped: null });
    } catch (error) {
      if (signal.aborted) throw error;
      failure ??= error;
      // The newer mosaic loaded and the older one did not: show the newer one.
      if (loaded.length) break;
      continue;
    }
    // Partial: it is kept until the next look, and the day before is tried.
    if (coverage === null || coverage >= MIN_DAILY_COVERAGE) break;
  }
  if (!loaded.length) throw failure ?? new Error('The daily mosaic did not load.');
  const shown = loaded[pickDaily(loaded)];
  const newest = candidates[0];
  const skipped =
    shown.date === newest
      ? null
      : { date: newest, coverage: loaded.find(({ date }) => date === newest)?.coverage ?? null };
  return { ...shown, skipped };
}

export interface WarningOutline {
  alert: WeatherAlert;
  outline: { type: 'MultiPolygon'; coordinates: number[][][][] };
}
/**
 * The active warnings that come with an outline, each outlined beside `longitude` (data.ts
 * alertOutline). Expiry is judged on the clock of the source that answered (`clockOffset`), as in
 * the warning list. A malformed provider polygon is left out; the warning itself is still listed.
 */
export function warningOutlines(
  alerts: readonly WeatherAlert[],
  clockOffset: number | undefined,
  longitude: number,
  now = Date.now(),
): WarningOutline[] {
  const current = sourceClock(now, clockOffset);
  const outlines: WarningOutline[] = [];
  for (const alert of alerts) {
    if (alert.expires <= current || !alert.geometry || typeof alert.geometry !== 'object') continue;
    try {
      const outline = alertOutline(alert.geometry, longitude);
      if (outline) outlines.push({ alert, outline });
    } catch {
      /* A malformed provider polygon must not hide the other outlines. */
    }
  }
  return outlines;
}
/**
 * A key that changes whenever the outlines to draw do: a warning added or removed, or any point of
 * one moved, as when a provider reissues a warning under the same id with a new area.
 */
export function outlinesKey(outlines: readonly WarningOutline[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string) => {
    for (let index = 0; index < text.length; index++)
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  };
  for (const { alert, outline } of outlines) {
    mix(`${alert.id}|`);
    for (const polygon of outline.coordinates) {
      mix('P');
      for (const ring of polygon) {
        mix('R');
        for (const [longitude, latitude] of ring) mix(`${longitude},${latitude};`);
      }
    }
  }
  return `${outlines.length}:${hash.toString(36)}`;
}

/**
 * How the globe draws a warning outline: the map's red, on a dark casing that keeps the line at
 * 3:1 or more against white cloud as well as dark ocean. Widths are in CSS pixels.
 */
export const WARNING_LINE = {
  colour: '#ff6b75',
  width: 2,
  casing: '#070b16',
  casingOpacity: 0.82,
  casingWidth: 5,
} as const;

const onAntimeridian = (longitude: number) => ((longitude % 360) + 360) % 360 === 180;
/**
 * An outline as line segments on the sphere: pairs of points, flattened as x, y, z. Each edge is
 * divided into steps of at most `step` degrees so it follows the surface. Rings are continuous
 * across 180° (alertOutline), so one that crosses it stays where it is. An edge along 180° is
 * where the gateway cut an outline into parts, not a warning boundary, so it is left out.
 */
export function outlineSegments(
  outline: WarningOutline['outline'],
  radius = 1,
  step = 1,
): Float32Array {
  const points: number[] = [];
  for (const polygon of outline.coordinates)
    for (const ring of polygon)
      for (let index = 1; index < ring.length; index++) {
        const [lon0, lat0] = ring[index - 1];
        const [lon1, lat1] = ring[index];
        if (onAntimeridian(lon0) && onAntimeridian(lon1)) continue;
        const parts = Math.max(
          1,
          Math.ceil(Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0)) / step),
        );
        for (let part = 0; part < parts; part++)
          for (const t of [part / parts, (part + 1) / parts])
            points.push(
              ...latLonToVector(lat0 + (lat1 - lat0) * t, lon0 + (lon1 - lon0) * t, radius),
            );
      }
  return new Float32Array(points);
}

/**
 * What a key does on the focused globe, or null for keys it leaves to the page. Escape hides the
 * key help and the crosshair that focus shows (WCAG 1.4.13) until the globe is focused again.
 */
export type GlobeKey =
  | { kind: 'rotate'; latitude: number; longitude: number }
  | { kind: 'zoom'; factor: number }
  | { kind: 'select' }
  | { kind: 'reset' }
  | { kind: 'dismiss' };
export const ZOOM_STEP = 1.25;
export function globeKey(key: string, shift = false): GlobeKey | null {
  const step = shift ? 30 : 10;
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'rotate', latitude: 0, longitude: -step };
    case 'ArrowRight':
      return { kind: 'rotate', latitude: 0, longitude: step };
    case 'ArrowUp':
      return { kind: 'rotate', latitude: step, longitude: 0 };
    case 'ArrowDown':
      return { kind: 'rotate', latitude: -step, longitude: 0 };
    case '+':
    case '=':
    case 'Add':
      return { kind: 'zoom', factor: 1 / ZOOM_STEP };
    case '-':
    case '_':
    case 'Subtract':
      return { kind: 'zoom', factor: ZOOM_STEP };
    case 'Enter':
      return { kind: 'select' };
    case 'Home':
      return { kind: 'reset' };
    case 'Escape':
    case 'Esc':
      return { kind: 'dismiss' };
    default:
      return null;
  }
}
/**
 * What focus shows over the globe: the key help and the crosshair ('full'), the crosshair alone
 * once a globe key has been used, so the help never hides what the keys move, or nothing after
 * Escape. Focusing the globe again shows everything.
 */
export type GlobeAssist = 'full' | 'crosshair' | 'none';
export function nextAssist(assist: GlobeAssist, key: GlobeKey | null): GlobeAssist {
  if (!key) return assist;
  if (key.kind === 'dismiss') return 'none';
  return assist === 'full' ? 'crosshair' : assist;
}
/**
 * What a key press on the focused globe does, or null for one it leaves to the page and the
 * browser: with Alt, Ctrl or ⌘ held, a key the globe has no use for, or Escape once the help and
 * crosshair are hidden, so a second Escape reaches the page.
 */
export function globeKeyAction(
  key: string,
  held: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  assist: GlobeAssist,
): GlobeKey | null {
  if (held.altKey || held.ctrlKey || held.metaKey) return null;
  const action = globeKey(key, held.shiftKey);
  return action?.kind === 'dismiss' && assist === 'none' ? null : action;
}

/** The camera's view: the point at the centre of the globe and the camera's distance from it. */
export interface GlobeViewState extends LatLon {
  distance: number;
}
export interface ViewLimits {
  /** The furthest latitude the centre can reach: the camera orbits with north up. */
  maxLatitude: number;
  minDistance: number;
  maxDistance: number;
}
/** The view after one rotation or zoom step, within the limits. */
export function stepView(
  view: GlobeViewState,
  action: Extract<GlobeKey, { kind: 'rotate' | 'zoom' }>,
  limits: ViewLimits,
): GlobeViewState {
  if (action.kind === 'zoom')
    return {
      ...view,
      distance: Math.min(
        limits.maxDistance,
        Math.max(limits.minDistance, view.distance * action.factor),
      ),
    };
  return {
    latitude: Math.min(
      limits.maxLatitude,
      Math.max(-limits.maxLatitude, view.latitude + action.latitude),
    ),
    longitude: normalizeLongitude(view.longitude + action.longitude),
    distance: view.distance,
  };
}

/**
 * The on-screen rotate buttons: each takes the step of its arrow key, so turning the globe never
 * needs a drag (WCAG 2.5.7). The direction is where the view goes.
 */
export const ROTATE_BUTTONS = [
  { key: 'ArrowLeft', direction: 'west', label: 'Rotate globe west' },
  { key: 'ArrowUp', direction: 'north', label: 'Rotate globe north' },
  { key: 'ArrowDown', direction: 'south', label: 'Rotate globe south' },
  { key: 'ArrowRight', direction: 'east', label: 'Rotate globe east' },
] as const;

/** The angle between two points on the globe, in degrees. */
export function angularDistance(a: LatLon, b: LatLon): number {
  const [x0, y0, z0] = latLonToVector(a.latitude, a.longitude);
  const [x1, y1, z1] = latLonToVector(b.latitude, b.longitude);
  return Math.acos(clamp(x0 * x1 + y0 * y1 + z0 * z1, -1, 1)) / RAD;
}
/**
 * Whether the view still looks at `place`, or as near as it can come to a pole. Enter then keeps
 * the named place rather than replacing it with an anonymous point.
 */
export function isCentredOn(
  centre: LatLon,
  place: LatLon,
  maxLatitude: number,
  tolerance = 0.1,
): boolean {
  const target = {
    latitude: clamp(place.latitude, -maxLatitude, maxLatitude),
    longitude: place.longitude,
  };
  return angularDistance(centre, target) <= tolerance;
}
/**
 * Whether Enter selects the point at the centre: only once the user has turned the view there
 * (keys, buttons or a drag) since the place was chosen, and only if it is somewhere else. A view
 * that auto-rotation drifted never picks a point for them.
 */
export function selectsCentre(
  turned: boolean,
  centre: LatLon,
  place: LatLon,
  maxLatitude: number,
): boolean {
  return turned && !isCentredOn(centre, place, maxLatitude);
}

/**
 * How long the marker pulse and the star twinkle go on after the last change or interaction.
 * Then an idle globe stops drawing, which saves the battery.
 */
export const SETTLE_MS = 9_000;
/**
 * How long the globe turns by itself once it starts, or after Play, before it glides back to the
 * selected place and rests. A change such as a new mosaic restarts the pulse, not the turning.
 */
export const AUTO_ROTATE_MS = 60_000;
/** How long the glide back to the selected place takes once the turning ends. */
export const HOME_GLIDE_MS = 1_600;
export interface FrameState {
  /** On screen, in a visible tab, with a working context, not disposed. */
  running: boolean;
  /** The camera, a fly-to or the daily layer changed in this frame. */
  moving: boolean;
  /** Auto-rotation is wanted: the user has not taken the globe in hand, and no fly-to runs. */
  autoRotate: boolean;
  /** Motion is allowed: not reduced, not paused. */
  animate: boolean;
  /** Milliseconds since the last change or interaction. */
  idle: number;
  /** Milliseconds since auto-rotation began; Infinity when it has not. */
  turning: number;
}
/** Whether the globe turns by itself in this frame: never under reduced motion or Pause. */
export function autoRotating({ animate, autoRotate, turning }: FrameState): boolean {
  return animate && autoRotate && turning < AUTO_ROTATE_MS;
}
/**
 * Whether the globe glides back to the selected place in this frame: it was turning by itself in
 * the last frame, its minute is over, and nobody took the globe in hand meanwhile. A page left
 * open then rests on the place and its warning outlines, never on the far side of the planet.
 */
export function returnsHome(wasTurning: boolean, state: FrameState): boolean {
  return wasTurning && state.autoRotate && state.animate && !autoRotating(state);
}
/** Whether the pulse and twinkle move in this frame. */
export function cosmeticMotion(state: FrameState): boolean {
  return state.animate && (autoRotating(state) || state.idle < SETTLE_MS);
}
/** Whether the globe asks for another frame after this one. */
export function nextFrame(state: FrameState): boolean {
  return state.running && (state.moving || autoRotating(state) || cosmeticMotion(state));
}
/** Frames that carry only ambient motion (auto-rotation, the pulse and twinkle): 30 a second. */
export const AMBIENT_FRAME_MS = 1000 / 30;
/**
 * Whether the globe skips drawing at this display refresh, which saves the battery: only while
 * nothing but ambient motion moves, and only until a 30th of a second has passed since the last
 * frame drawn. A few milliseconds early is close enough, so a 60 Hz display draws every other
 * refresh. A drag and its glide, a fly-to or a fade draws at every refresh.
 */
export function skipsFrame(ambient: boolean, sinceDrawn: number): boolean {
  return ambient && sinceDrawn < AMBIENT_FRAME_MS - 4;
}
/**
 * How long ambient motion waits, `sinceDrawn` ms after the timestamp of the last frame drawn,
 * before it asks for a display refresh, so the page is not woken at every refresh in between:
 * until about 26 ms after that frame, past the refresh in between. Where a browser hands out a
 * refresh at the next one, that is the refresh a 30th of a second on: one asked for each frame
 * drawn. Chrome may hand it out at once, stamped with the refresh in between: too early to draw
 * (skipsFrame), so the globe asks again and draws at the next one, still 30 times a second.
 */
export function ambientWait(sinceDrawn: number): number {
  return Math.max(0, AMBIENT_FRAME_MS - 7 - sinceDrawn);
}
/** Whether the globe can draw at all. */
export interface DrawState {
  /** Its stage is on screen (IntersectionObserver). */
  inView: boolean;
  /** Its tab is shown. */
  pageVisible: boolean;
  /** The browser took its graphics context away, until it gives it back. */
  lost: boolean;
  /** A frame failed to draw: only Restart brings it back. */
  failed: boolean;
  disposed: boolean;
}
/** Whether the globe draws: on screen, in a shown tab, with its context, not stopped or gone. */
export function drawing({ inView, pageVisible, lost, failed, disposed }: DrawState): boolean {
  return inView && pageVisible && !lost && !failed && !disposed;
}
/** How opaque the daily mosaic is drawn over the base map where it has imagery. */
export const DAILY_OPACITY = 0.9;
/**
 * The daily layer once its image or visibility changes: the opacity it fades to, and the opacity
 * it has now. Without an image it is gone at once: nothing of a mosaic may stay on screen, faded
 * or not, once the card no longer dates it.
 */
export function dailyLayer(
  mix: number,
  { visible, image }: { visible: boolean; image: boolean },
): { target: number; mix: number } {
  return { target: visible && image ? DAILY_OPACITY : 0, mix: image ? mix : 0 };
}
/** The daily layer's opacity after `seconds` more of its fade; at once without motion. */
export function fadeDaily(mix: number, target: number, seconds: number, animate: boolean): number {
  if (!animate) return target;
  return target > mix
    ? Math.min(target, mix + seconds * 1.6)
    : Math.max(target, mix - seconds * 1.6);
}

/**
 * Everything one globe holds: things to dispose, listeners, timers and observers. `dispose()`
 * disposes the kept items, then runs the deferred undos newest first, exactly once.
 */
export interface Lifecycle {
  keep<T extends { dispose(): void }>(item: T): T;
  /** Disposes a kept item now, and forgets it. */
  drop(item: { dispose(): void } | null | undefined): void;
  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void;
  defer(undo: () => void): void;
  readonly disposed: boolean;
  dispose(): void;
}
export function createLifecycle(): Lifecycle {
  const items = new Set<{ dispose(): void }>();
  const undos: (() => void)[] = [];
  let disposed = false;
  const defer = (undo: () => void) => {
    if (disposed) undo();
    else undos.push(undo);
  };
  return {
    keep(item) {
      if (disposed) item.dispose();
      else items.add(item);
      return item;
    },
    drop(item) {
      if (!item) return;
      items.delete(item);
      item.dispose();
    },
    listen(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      defer(() => target.removeEventListener(type, listener, options));
    },
    defer,
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const item of items) item.dispose();
      items.clear();
      for (const undo of undos.reverse()) undo();
      undos.length = 0;
    },
  };
}

/**
 * Degrees between the stripes that hatch areas a mosaic did not image: about 14 px apart at the
 * globe's resting size, `radiusPixels` across its radius.
 */
export function hatchDegrees(radiusPixels: number): number {
  return radiusPixels > 0 ? clamp(14 / (radiusPixels * RAD), 2, 9) : 4;
}

/** Whether a press and release were a tap or click rather than the start and end of a drag. */
export function isTap(
  down: { x: number; y: number; time: number },
  up: { x: number; y: number; time: number },
  pointerType: string,
): boolean {
  const slop = pointerType === 'mouse' ? 5 : 12;
  return Math.hypot(up.x - down.x, up.y - down.y) <= slop && up.time - down.time <= 700;
}

/** Where a ray from `origin` along `direction` first meets the sphere of `radius` at the centre. */
export function raySphere(origin: Vector, direction: Vector, radius = 1): Vector | null {
  const length = Math.hypot(...direction);
  if (!(length > 0)) return null;
  const d = direction.map((value) => value / length) as Vector;
  const b = origin[0] * d[0] + origin[1] * d[1] + origin[2] * d[2];
  const c = origin[0] ** 2 + origin[1] ** 2 + origin[2] ** 2 - radius ** 2;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const t = -b - Math.sqrt(discriminant);
  if (t < 0) return null;
  return [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t];
}

/**
 * The camera distance at which a unit globe spans `fill` of the shorter side of a view with this
 * aspect ratio (width / height) and vertical field of view.
 */
export function fitDistance(aspect: number, fovDegrees: number, fill = 0.8): number {
  const vertical = (fovDegrees / 2) * RAD;
  const horizontal = Math.atan(Math.tan(vertical) * (aspect > 0 ? aspect : 1));
  return 1 / Math.sin(Math.atan(Math.tan(Math.min(vertical, horizontal)) * fill));
}

/** The index of the marker nearest to (x, y) within `reach` pixels, or −1. Hidden ones never. */
export function nearestMarker(
  markers: readonly { x: number; y: number; visible: boolean }[],
  x: number,
  y: number,
  reach = 14,
): number {
  let found = -1;
  let best = reach;
  markers.forEach((marker, index) => {
    const distance = Math.hypot(marker.x - x, marker.y - y);
    if (marker.visible && distance <= best) {
      best = distance;
      found = index;
    }
  });
  return found;
}

/** A design token's colour ("#3EE6C1" or "#3e6") as sRGB components from 0 to 1. */
export function hexColor(value: string | null | undefined, fallback: string): Vector {
  const parse = (text: string) => {
    const hex = text.trim().replace(/^#/, '');
    if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16) / 255) as Vector;
  };
  return parse(value ?? '') ?? parse(fallback) ?? [1, 1, 1];
}

/**
 * A fixed field of stars on a sphere of `radius`: positions, sizes in pixels and a tint for each
 * (0 white, 1 teal, 2 violet). The same seed always draws the same sky.
 */
export function starfield(count: number, seed = 2026, radius = 60) {
  let state = seed >>> 0;
  const random = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const tints = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const z = 2 * random() - 1;
    const angle = 2 * Math.PI * random();
    const ring = Math.sqrt(1 - z * z);
    positions.set(
      [radius * ring * Math.cos(angle), radius * z, radius * ring * Math.sin(angle)],
      index * 3,
    );
    sizes[index] = 0.9 + 2.4 * random() ** 3;
    const tint = random();
    tints[index] = tint < 0.78 ? 0 : tint < 0.9 ? 1 : 2;
  }
  return { positions, sizes, tints };
}
