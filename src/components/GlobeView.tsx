import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ImageOff,
  Layers,
  LocateFixed,
  MapPin,
  Minus,
  Moon,
  Plus,
  Rotate3d,
  Satellite,
  Sun,
  Sunset,
  TriangleAlert,
} from 'lucide-react';
import { sourceClock } from '../connectivity';
import { fetchImageryFrames } from '../imagery';
import {
  GLOBE_BASE_LAYER,
  GLOBE_DAILY,
  LOOK_TIMER_MS,
  ROTATE_BUTTONS,
  ZOOM_STEP,
  coordinateLabel,
  createImageCache,
  dailyNote,
  daylight,
  focusAfterStatus,
  focusNow,
  globeDraws,
  globeFallback,
  globeImageUrl,
  globeKey,
  globeKeyAction,
  globeSubtitle,
  imageryCredit,
  imageryMask,
  imageryNotice,
  loadDailyMosaic,
  markersKey,
  mosaicDateLabel,
  nextAssist,
  nextDaily,
  outlineNote,
  outlineSegments,
  outlinesKey,
  placeImagery,
  pointPlace,
  readGlobeImage,
  requestImagery,
  retryLayers,
  sceneBase,
  sceneDaily,
  selectsCentre,
  shouldLook,
  shownMosaic,
  solarElevation,
  startGlobe,
  subsolarPoint,
  warningOutlines,
  type BaseImagery,
  type DailyImagery,
  type DecodedImage,
  type FocusTarget,
  type GlobeAssist,
  type GlobeStatus,
  type ImageryMask,
  type MosaicLoader,
} from '../globe';
import {
  MAX_LATITUDE,
  OUTLINE_RADIUS,
  createGlobe,
  loadThree,
  openContext,
  releaseContext,
  type Globe,
  type GlobeEvents,
  type Probe,
  type RotateAction,
  type ThreeKit,
} from '../globe-scene';
import type { Place, WeatherAlert } from '../types';
import './GlobeView.css';

interface Props {
  place: Place;
  saved: Place[];
  /** Active official warnings; those with an outline are drawn. */
  alerts: WeatherAlert[];
  /** The warning check's clock offset (AlertResult.clockOffset); expiry is judged on its clock. */
  clockOffset: number | undefined;
  onSelect: (place: Place) => void;
  /** What the globe reaches outside React through; the app leaves it to the browser's own. */
  engine?: GlobeEngine;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Decoded whole-Earth images, kept while the globe is open and for a minute after it closes, so a
 * restored context or a quick switch of connection mode downloads nothing again: GIBS sends them
 * with `no-store`. A partial mosaic is kept too, until the next look reads it again
 * (loadDailyMosaic). After that minute (Data saver, say) they are closed (createImageCache).
 */
const decodedImages = createImageCache<DecodedImage<TexImageSource>>({
  close: ({ source }) => {
    if (typeof ImageBitmap === 'function' && source instanceof ImageBitmap) source.close();
    else if (source instanceof HTMLImageElement && source.src.startsWith('blob:'))
      URL.revokeObjectURL(source.src);
  },
});
/**
 * An ImageBitmap where the browser can make one: it stays decoded for re-uploads after a remount
 * or a restored context. The <img> fallback keeps its blob URL for the same reason.
 */
async function decodeImage(blob: Blob): Promise<DecodedImage<TexImageSource>> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      /* Fall back to an image element. */
    }
  }
  const image = new Image();
  image.src = URL.createObjectURL(blob);
  await image.decode();
  return { source: image, width: image.naturalWidth, height: image.naturalHeight };
}
async function loadImage(url: string, signal: AbortSignal) {
  const kept = decodedImages.get(url);
  if (kept) return kept;
  const image = await readGlobeImage(url, signal, {
    fetch: (address, init) => fetch(address, init),
    online: () => navigator.onLine,
    decode: decodeImage,
  });
  decodedImages.set(url, image);
  return image;
}
const masks = new WeakMap<object, ImageryMask | null>();
/** Where a daily mosaic has pixels, measured on a 512 × 256 copy (about 0.7° a pixel). */
function measureMask(image: DecodedImage<TexImageSource>): ImageryMask | null {
  const source = image.source as object;
  if (masks.has(source)) return masks.get(source) ?? null;
  let mask: ImageryMask | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context) {
      context.drawImage(image.source as CanvasImageSource, 0, 0, 512, 256);
      mask = imageryMask(context.getImageData(0, 0, 512, 256).data, 512, 256);
    }
  } catch {
    mask = null;
  }
  masks.set(source, mask);
  return mask;
}
/** How the globe reaches NASA for the daily mosaic (globe.ts loadDailyMosaic). */
const mosaicLoader: MosaicLoader<TexImageSource> = {
  online: () => navigator.onLine,
  frames: (signal, force) => fetchImageryFrames(GLOBE_DAILY, signal, force),
  image: loadImage,
  held: decodedImages.get,
  measure: measureMask,
  forget: decodedImages.forget,
};
/**
 * Everything GlobeView reaches outside React through: WebGL, three.js and the scene
 * (globe-scene.ts), NASA's images and the cache that holds them. The page uses the browser's;
 * tests pass stand-ins, so they can run the globe's effects without a GPU or a network.
 */
export interface GlobeEngine {
  openContext(): Probe | null;
  releaseContext(probe: Probe): void;
  loadThree(): Promise<ThreeKit>;
  createGlobe: typeof createGlobe;
  loadImage(url: string, signal: AbortSignal): Promise<DecodedImage<TexImageSource>>;
  mosaics: MosaicLoader<TexImageSource>;
  /** Held while a globe is open, so its decoded images stay (createImageCache). */
  images: { hold(): void; release(): void };
}
const browserEngine: GlobeEngine = {
  openContext,
  releaseContext,
  loadThree,
  createGlobe,
  loadImage,
  mosaics: mosaicLoader,
  images: decodedImages,
};

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(REDUCED_MOTION);
    const change = () => setReduced(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

const ROTATE_ICONS = {
  west: ChevronLeft,
  north: ChevronUp,
  south: ChevronDown,
  east: ChevronRight,
} as const;
export interface GlobeCardProps {
  id: string;
  place: Place;
  status: GlobeStatus;
  base: BaseImagery;
  daily: DailyImagery;
  showDaily: boolean;
  /** How many active warnings are outlined, and how many there are. */
  outlined: number;
  alertCount: number;
  reducedMotion: boolean;
  paused: boolean;
  closer: boolean;
  wheelHint: boolean;
  /** What focus shows over the globe: the key help and the crosshair, or less (nextAssist). */
  assist: GlobeAssist;
  announcement: string;
  now: number;
  sectionRef?: RefObject<HTMLElement | null>;
  stageRef?: RefObject<HTMLDivElement | null>;
  hostRef?: RefObject<HTMLDivElement | null>;
  labelRef?: RefObject<HTMLDivElement | null>;
  restartRef?: RefObject<HTMLButtonElement | null>;
  onSurfaceFocus?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onRotate?: (key: (typeof ROTATE_BUTTONS)[number]['key']) => void;
  onZoom?: (factor: number) => void;
  onReset?: () => void;
  onToggleDaily?: () => void;
  onTogglePause?: () => void;
  onRestart?: () => void;
  onRetryImagery?: () => void;
}

/**
 * The globe's card in a given state, with no effects: GlobeView supplies the state and the scene.
 * Its outer size comes from GlobeView.css alone, the same for every state and for App's skeleton,
 * except in a browser without WebGL 2, where the card is a short notice instead of an empty stage.
 */
export function GlobeCard({
  id,
  place,
  status,
  base,
  daily,
  showDaily,
  outlined,
  alertCount,
  reducedMotion,
  paused,
  closer,
  wheelHint,
  assist,
  announcement,
  now,
  sectionRef,
  stageRef,
  hostRef,
  labelRef,
  restartRef,
  onSurfaceFocus,
  onKeyDown,
  onRotate,
  onZoom,
  onReset,
  onToggleDaily,
  onTogglePause,
  onRestart,
  onRetryImagery,
}: GlobeCardProps) {
  const headingId = `${id}heading`;
  const helpId = `${id}help`;
  const ready = status === 'ready';
  const draws = globeDraws(status);
  const fallback = globeFallback(status);
  const overhead = subsolarPoint(now);
  const sunHere = daylight(solarElevation(place.latitude, place.longitude, now));
  const imagery = placeImagery(status, base, daily, showDaily, place.latitude, place.longitude);
  const mosaic = shownMosaic(daily, showDaily);
  const gaps = !!mosaic && (mosaic.coverage === null || mosaic.coverage < 0.999);
  const notice = draws ? imageryNotice(base, daily) : null;
  const note = draws ? dailyNote(daily) : null;
  const credit = draws ? imageryCredit(base, daily, showDaily) : null;
  const coordinates = coordinateLabel(place.latitude, place.longitude);
  // Active warnings stay one step away while the globe fills the screen. A narrow card shows only
  // the count and the noun, which begin the link's name: said aloud, the words shown reach it.
  // The name is set whole, as the text reads on a wider card: a name taken from the text would
  // gain a stray space before the comma where its last words are hidden.
  const count = `${alertCount} ${alertCount === 1 ? 'warning' : 'warnings'}`;
  const more = ', active and official';
  const warnings = alertCount > 0 && (
    <a className="globe-alerts" href="#alerts" aria-label={`${count}${more}`}>
      <TriangleAlert size={14} aria-hidden="true" />
      <span>
        {count}
        <span className="globe-more-label">{more}</span>
      </span>
      <ChevronRight size={14} aria-hidden="true" />
    </a>
  );
  const coverage =
    mosaic && mosaic.coverage !== null ? `${Math.round(mosaic.coverage * 100)}%` : null;
  const placeCard = (
    <div className="globe-place">
      <span className="globe-place-kicker">
        <MapPin size={12} aria-hidden="true" /> SELECTED PLACE
      </span>
      <span className="globe-place-name">
        <strong>{place.name}</strong>
        {/* A point chosen on the map or the globe is named by its coordinates already. */}
        {place.name !== coordinates && <span className="globe-place-coords">{coordinates}</span>}
      </span>
      <span className={`globe-place-line is-${sunHere.phase}`}>
        {sunHere.phase === 'day' ? (
          <Sun size={13} aria-hidden="true" />
        ) : sunHere.phase === 'twilight' ? (
          <Sunset size={13} aria-hidden="true" />
        ) : (
          <Moon size={13} aria-hidden="true" />
        )}
        {sunHere.text}
      </span>
      {imagery && (
        <span className={`globe-place-line is-${imagery.kind}`}>
          {imagery.kind === 'gap' || imagery.kind === 'none' ? (
            <ImageOff size={13} aria-hidden="true" />
          ) : (
            <Satellite size={13} aria-hidden="true" />
          )}
          {imagery.text}
        </span>
      )}
    </div>
  );
  const eyebrow = (
    <span className="globe-eyebrow">
      <span className="globe-terminator" aria-hidden="true" />
      3D EARTH · SUNLIGHT NOW
    </span>
  );
  return (
    <div className="globe-slot">
      <section
        ref={sectionRef}
        className={`globe-view is-${status}${closer ? ' is-closer' : ''}`}
        aria-labelledby={headingId}
      >
        <div className="globe-frame">
          {status === 'unsupported' ? (
            <div className="globe-compact">
              <span className="globe-orb" aria-hidden="true" />
              <div className="globe-compact-text">
                {eyebrow}
                <h2 id={headingId}>{fallback?.title}</h2>
                <p role="status">{fallback?.text}</p>
                {warnings}
              </div>
              {placeCard}
            </div>
          ) : (
            <>
              {/* First in the tab order, so the active warnings are reached before the globe and
                  its controls. It is positioned over the scene, so the order moves nothing. */}
              <div className="globe-hud globe-hud-top">
                <div className="globe-title">
                  {eyebrow}
                  <h2 id={headingId}>
                    Your place on the <span className="globe-accent">planet.</span>
                  </h2>
                  <p>{globeSubtitle(status, base, daily, showDaily)}</p>
                </div>
                {(warnings || draws) && (
                  <div className="globe-side">
                    {warnings}
                    {draws && (
                      // A label's words are one flex item: the gap parts the icon from them, not
                      // one word from the next.
                      <dl className="globe-facts">
                        <div>
                          <dt>
                            <Satellite size={13} aria-hidden="true" />{' '}
                            <span>
                              <span className="globe-more">Daily </span>mosaic
                            </span>
                          </dt>
                          <dd>
                            {!showDaily ? (
                              'Hidden'
                            ) : mosaic ? (
                              <>
                                <time dateTime={mosaic.date}>
                                  {mosaicDateLabel(mosaic.date).replace(/ \d{4}$/, '')}
                                  <span className="globe-more"> {mosaic.date.slice(0, 4)}</span>
                                </time>
                                {coverage && (
                                  <span className="globe-narrow"> · {coverage} imaged</span>
                                )}
                              </>
                            ) : daily.state === 'failed' ? (
                              'Unavailable'
                            ) : (
                              'Checking NASA…'
                            )}
                          </dd>
                        </div>
                        {coverage && (
                          <div className="globe-coverage">
                            <dt>
                              <span>
                                Imaged<span className="globe-more"> that day</span>
                              </span>
                            </dt>
                            <dd>
                              {coverage}
                              <span className="globe-more"> of Earth</span>
                            </dd>
                          </div>
                        )}
                        <div>
                          <dt>
                            <Sun size={13} aria-hidden="true" /> <span>Sun overhead</span>
                          </dt>
                          <dd>{coordinateLabel(overhead.latitude, overhead.longitude)}</dd>
                        </div>
                      </dl>
                    )}
                  </div>
                )}
              </div>
              <div className="globe-stage">
                <div className="globe-viewport">
                  <div
                    ref={stageRef}
                    className="globe-surface"
                    // Focus waits here while a restarted globe starts, so it never drops to the page.
                    tabIndex={ready ? 0 : -1}
                    role={ready ? 'application' : 'img'}
                    aria-label={
                      ready
                        ? `3D globe. Selected place: ${place.name}.`
                        : status === 'starting'
                          ? '3D globe, starting.'
                          : '3D globe, stopped.'
                    }
                    aria-describedby={ready ? helpId : undefined}
                    data-assist={assist}
                    onFocus={onSurfaceFocus}
                    onKeyDown={onKeyDown}
                  >
                    <div ref={hostRef} className="globe-canvas" aria-hidden="true" />
                  </div>
                  <div ref={labelRef} className="globe-pin" aria-hidden="true" data-hidden="true">
                    <span>{place.name}</span>
                  </div>
                  <div className="globe-crosshair" aria-hidden="true" />
                  <div className="globe-help" aria-hidden="true">
                    <span>
                      <kbd>←</kbd>
                      <kbd>→</kbd>
                      <kbd>↑</kbd>
                      <kbd>↓</kbd> rotate
                    </span>
                    <span>
                      <kbd>+</kbd>
                      <kbd>−</kbd> zoom
                    </span>
                    <span>
                      <kbd>Enter</kbd> select centre
                    </span>
                    <span>
                      <kbd>Home</kbd> back to place
                    </span>
                    <span>
                      <kbd>Esc</kbd> hide help
                    </span>
                  </div>
                  {status === 'starting' && (
                    <p className="globe-loading" role="status">
                      <span className="globe-orb" aria-hidden="true" />
                      Starting the 3D globe…
                    </p>
                  )}
                  {fallback && (
                    <div className="globe-fallback" role="status">
                      <span className="globe-orb" aria-hidden="true" />
                      <h3>{fallback.title}</h3>
                      <p>{fallback.text}</p>
                      {fallback.restart && (
                        <button
                          ref={restartRef}
                          type="button"
                          className="globe-text-button"
                          onClick={onRestart}
                        >
                          Restart globe
                        </button>
                      )}
                    </div>
                  )}
                  {wheelHint && (
                    <p className="globe-wheel-hint" aria-hidden="true">
                      Hold Ctrl and scroll, or pinch, to zoom the globe
                    </p>
                  )}
                </div>
                {/* Named by aria-label alone, as the map's tools are: a title as well would be read
                    a second time, as the description. */}
                <div
                  className="globe-tools"
                  role="group"
                  aria-label="Globe controls"
                  hidden={!ready}
                >
                  <div className="globe-pad" role="group" aria-label="Rotate globe">
                    {ROTATE_BUTTONS.map(({ key, direction, label }) => {
                      const Icon = ROTATE_ICONS[direction];
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`is-${direction}`}
                          aria-label={label}
                          onClick={() => onRotate?.(key)}
                        >
                          <Icon size={17} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                  <div className="globe-buttons">
                    <button
                      type="button"
                      aria-label="Zoom in globe"
                      onClick={() => onZoom?.(1 / ZOOM_STEP)}
                    >
                      <Plus size={18} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="Zoom out globe"
                      onClick={() => onZoom?.(ZOOM_STEP)}
                    >
                      <Minus size={18} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="Return globe to selected place"
                      onClick={onReset}
                    >
                      <LocateFixed size={17} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="Daily satellite mosaic"
                      aria-pressed={showDaily}
                      onClick={onToggleDaily}
                    >
                      <Layers size={17} aria-hidden="true" />
                    </button>
                    {/* A switch for the globe's own motion, not a play button: on, the globe may
                        turn for a minute and pulse after a change; off, nothing moves by itself.
                        Its name stays the same, so a globe already at rest is never offered a
                        Pause that would change nothing to be seen. */}
                    {!reducedMotion && (
                      <button
                        type="button"
                        aria-label="Globe motion"
                        aria-pressed={!paused}
                        onClick={onTogglePause}
                      >
                        <Rotate3d size={17} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <p id={helpId} className="globe-visually-hidden">
                Arrow keys rotate the globe; hold Shift for larger steps. Plus and minus zoom. Enter
                selects the point at the centre. Home returns to the selected place. Escape hides
                the key help. The buttons beside the globe do the same, and search and the quick
                locations select places too.
              </p>
              <div className="globe-hud globe-hud-bottom">{placeCard}</div>
            </>
          )}
        </div>
        <div className="globe-notes">
          {draws && (
            <ul className="globe-legend" aria-label="Globe key">
              <li>
                <span className="globe-key is-selected" aria-hidden="true" />
                Selected place
              </li>
              <li>
                <span className="globe-key is-saved" aria-hidden="true" />
                Saved places
              </li>
              <li>
                <span className="globe-key is-warning" aria-hidden="true" />
                Official warning outline
              </li>
              {gaps && (
                <li>
                  <span className="globe-key is-gap" aria-hidden="true" />
                  Not imaged that day
                </li>
              )}
            </ul>
          )}
          <p>
            {outlineNote(status, outlined, alertCount)}{' '}
            <a href="#alerts">Read warnings &amp; local guidance</a>
          </p>
          {note && <p>{note}</p>}
          {/* Only imagery that is drawn, or on its way, is described and credited. */}
          {credit && (
            <p>
              Satellite imagery, not radar or a live camera, and never a sign that a place is safe.
              {/* On a narrow card the key and the place card say this; the rest stays. */}
              <span className="globe-more">
                {' '}
                Night is drawn from the sun&rsquo;s position now.
                {gaps
                  ? ' Hatched areas had no imagery that day: they show the cloud-free base map.'
                  : ''}
              </span>
              {!mosaic && credit.base
                ? ' The Blue Marble base map is a static composite with no clouds.'
                : ''}
            </p>
          )}
          {credit && (
            <p className="globe-credit">
              Imagery:{' '}
              <a
                href="https://nasa-gibs.github.io/gibs-api-docs/access-basics/"
                target="_blank"
                rel="noreferrer"
              >
                NASA EOSDIS GIBS ↗
              </a>
              {credit.base && (
                <>
                  {' '}
                  · Blue Marble<span className="globe-more">
                    {' '}
                    shaded relief and bathymetry
                  </span>{' '}
                  (static)
                </>
              )}
              {credit.daily && (
                <>
                  {' '}
                  · NOAA-20 VIIRS<span className="globe-more"> corrected reflectance</span> (daily)
                </>
              )}
              {!credit.base && !credit.daily && ' · loading'}
            </p>
          )}
          {notice && (
            <p className="globe-warning" role="status">
              <TriangleAlert size={15} aria-hidden="true" />
              <span>{notice}</span>
              <button type="button" className="globe-text-button" onClick={onRetryImagery}>
                Try again
              </button>
            </p>
          )}
        </div>
        <p className="globe-visually-hidden" aria-live="polite">
          {announcement}
        </p>
      </section>
    </div>
  );
}

/**
 * The 3D globe: GlobeCard in the state its effects keep. Each effect hands its decision to a
 * helper in globe.ts (startGlobe, requestImagery, sceneDaily, shouldLook, retryLayers,
 * globeKeyAction, focusAfterStatus and focusNow) and reaches the browser only through `engine`,
 * so tests/globe-view-effects.test.ts runs these effects with stand-ins.
 */
export default function GlobeView({
  place,
  saved,
  alerts,
  clockOffset,
  onSelect,
  engine = browserEngine,
}: Props) {
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  const globe = useRef<Globe | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  // The globe keeps the warning source's time where a check has measured it, as the warning list
  // does: a device clock that is wrong moves neither the sun nor the choice of mosaic.
  const offset = useRef(clockOffset);
  offset.current = clockOffset;
  const clock = useCallback(() => sourceClock(Date.now(), offset.current), []);
  const [attempt, setAttempt] = useState(0);
  /** How many scenes have started: the effects that drive the scene wait for one. */
  const [built, setBuilt] = useState(0);
  const [status, setStatus] = useState<GlobeStatus>('starting');
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [base, setBase] = useState<BaseImagery>({ state: 'loading' });
  const [daily, setDaily] = useState<DailyImagery>({ state: 'loading' });
  // Each layer is loaded again only when it is the one that failed, or is due for a newer copy.
  const [baseTry, setBaseTry] = useState(0);
  const [dailyCheck, setDailyCheck] = useState({ count: 0, refresh: false });
  const [showDaily, setShowDaily] = useState(true);
  const reducedMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [rotating, setRotating] = useState(true);
  const [assist, setAssist] = useState<GlobeAssist>('full');
  const [announcement, setAnnouncement] = useState('');
  const [wheelHint, setWheelHint] = useState(false);
  const [closer, setCloser] = useState(false);
  const animate = !reducedMotion && !paused;
  const announce = useCallback(
    (text: string) => setAnnouncement((shown) => (shown === text ? `${text} ` : text)),
    [],
  );
  const timers = useRef<{ centre?: number; hint?: number }>({});
  /**
   * The decoded images behind `base` and `daily`. The scene draws these and nothing else, through
   * the two effects that follow those states, so what is drawn always matches what the card says.
   */
  const images = useRef<{
    base: TexImageSource | null;
    daily: { date: string; source: TexImageSource } | null;
  }>({ base: null, daily: null });
  /** When the globe last asked NASA for the daily mosaic (mosaicRecheck). */
  const checkedAt = useRef<number | null>(null);
  const latestDaily = useRef(daily);
  latestDaily.current = daily;
  /** Where keyboard focus goes once the status allows it (focusAfterStatus, focusNow). */
  const focusAfter = useRef<FocusTarget | null>(null);
  /** Whether the user has turned the view since the place was chosen (selectsCentre). */
  const turned = useRef(false);

  useEffect(() => {
    engine.images.hold();
    return engine.images.release;
  }, [engine]);

  useEffect(() => {
    const holder = stage.current;
    const canvasHost = host.current;
    if (!holder || !canvasHost) return;
    // A stopped globe takes its controls away: focus on them moves to Restart, not to the page.
    const settle = (next: GlobeStatus) => {
      const inCard = !!section.current?.contains(document.activeElement);
      focusAfter.current = focusAfterStatus(inCard, next, focusAfter.current);
      setStatus(next);
    };
    const events: GlobeEvents = {
      interact: () => setRotating(false),
      turned: () => {
        turned.current = true;
      },
      pick: (picked) => {
        select.current(picked);
        announce(`Selected ${picked.name}.`);
      },
      zoomed: setCloser,
      wheel: () => {
        setWheelHint(true);
        window.clearTimeout(timers.current.hint);
        timers.current.hint = window.setTimeout(() => setWheelHint(false), 2200);
      },
      lost: () => settle('lost'),
      restored: () => settle('ready'),
      failed: () => settle('failed'),
    };
    const stop = startGlobe(
      {
        openContext: engine.openContext,
        loadThree: engine.loadThree,
        create: (three, probe) =>
          engine.createGlobe(three, probe, holder, canvasHost, label.current, events, { clock }),
        release: engine.releaseContext,
      },
      {
        status: setStatus,
        ready: (scene) => {
          globe.current = scene;
          setStatus('ready');
          setBuilt((count) => count + 1);
        },
        // OptionalPanel then says the optional tool could not load, as for the map.
        failed: setLoadError,
      },
    );
    const pending = timers.current;
    return () => {
      stop();
      window.clearTimeout(pending.hint);
      window.clearTimeout(pending.centre);
      globe.current = null;
    };
  }, [attempt, announce, clock, engine]);

  useEffect(() => {
    const target = focusNow(focusAfter.current, status);
    if (!target) return;
    focusAfter.current = null;
    (target === 'restart' ? restartButton.current : stage.current)?.focus();
  }, [status]);

  // Each effect below waits for `built`, so it acts once per scene, after the scene exists, and
  // reads the latest props through refs where only some of them should start it again.
  const live = () => (built ? globe.current : null);
  useEffect(() => {
    turned.current = false;
    if (live()?.setPlace(place)) setRotating(false);
  }, [built, place.latitude, place.longitude, place.name]);

  // Renamed places too: a click on a marker selects the place as it is now.
  const savedKey = markersKey(saved, place);
  const latest = useRef({ saved, place });
  latest.current = { saved, place };
  useEffect(() => {
    live()?.setSaved(latest.current.saved, latest.current.place);
  }, [built, savedKey]);

  const outlines = warningOutlines(alerts, clockOffset, place.longitude);
  const outlineKey = outlinesKey(outlines);
  const drawn = useRef(outlines);
  drawn.current = outlines;
  useEffect(() => {
    live()?.setOutlines(
      drawn.current.map(({ outline }) => outlineSegments(outline, OUTLINE_RADIUS)),
    );
  }, [built, outlineKey]);

  useEffect(() => {
    live()?.setMotion(animate, animate && rotating);
  }, [built, animate, rotating]);

  useEffect(() => {
    live()?.setDailyVisible(showDaily);
  }, [built, showDaily]);

  // Imagery is requested once the globe can draw it, and again only as retries and checks ask.
  const started = built > 0;
  useEffect(() => {
    if (!started) return;
    setBase({ state: 'loading' });
    return requestImagery(
      (signal) => engine.loadImage(globeImageUrl(GLOBE_BASE_LAYER), signal),
      {
        loaded: (image) => {
          images.current.base = image.source;
          setBase({ state: 'ready' });
        },
        failed: (message) => setBase({ state: 'failed', message }),
      },
      'The base image did not load.',
    );
  }, [started, baseTry, engine]);

  useEffect(() => {
    if (!started) return;
    checkedAt.current = clock();
    setDaily((previous) => nextDaily(previous, { type: 'start' }));
    // The first load reads NASA's dates from the five-minute cache; a look asks NASA again.
    const { refresh } = dailyCheck;
    return requestImagery(
      (signal) => loadDailyMosaic(engine.mosaics, signal, { refresh, now: clock() }),
      {
        loaded: ({ image, ...mosaic }) => {
          images.current.daily = { date: mosaic.date, source: image.source };
          setDaily((previous) => nextDaily(previous, { type: 'loaded', mosaic }));
        },
        failed: (message) =>
          setDaily((previous) => nextDaily(previous, { type: 'failed', message })),
      },
      'The daily mosaic did not load.',
    );
  }, [started, dailyCheck, clock, engine]);

  // The scene follows the imagery states, on every scene (a restart included).
  useEffect(() => {
    live()?.setImage('base', sceneBase(base, images.current.base));
  }, [built, base]);
  useEffect(() => {
    live()?.setImage('daily', sceneDaily(daily, images.current.daily));
  }, [built, daily]);

  // A page left open looks for a newer mosaic after UTC midnight, and hourly while the one shown
  // is partial or older than the newest listed: only while the page is shown and online.
  useEffect(() => {
    if (!started) return;
    const timer = window.setInterval(() => {
      const due = shouldLook({
        hidden: document.visibilityState === 'hidden',
        online: navigator.onLine,
        daily: latestDaily.current,
        checkedAt: checkedAt.current,
        now: clock(),
      });
      if (due) setDailyCheck(({ count }) => ({ count: count + 1, refresh: true }));
    }, LOOK_TIMER_MS);
    return () => window.clearInterval(timer);
  }, [started, clock]);

  const retryImagery = () => {
    const retry = retryLayers(base, daily);
    if (retry.base) setBaseTry((value) => value + 1);
    if (retry.daily) setDailyCheck(({ count }) => ({ count: count + 1, refresh: true }));
  };
  const stopRotating = () => setRotating(false);
  const zoom = (factor: number) => {
    const result = globe.current?.zoom(factor);
    stopRotating();
    if (result)
      announce(
        result === 'closest'
          ? 'Closest view.'
          : result === 'furthest'
            ? 'Furthest view.'
            : result === 'in'
              ? 'Zoomed in.'
              : 'Zoomed out.',
      );
  };
  const reset = () => {
    globe.current?.reset();
    turned.current = false;
    stopRotating();
    announce(`View returned to ${place.name}.`);
  };
  const turn = (action: RotateAction) => {
    const current = globe.current;
    if (!current) return;
    const centre = current.rotate(action);
    turned.current = true;
    stopRotating();
    // Holding a key moves several steps: only where it stops is read out.
    window.clearTimeout(timers.current.centre);
    timers.current.centre = window.setTimeout(
      () => announce(`Centred on ${coordinateLabel(centre.latitude, centre.longitude)}.`),
      350,
    );
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = globe.current;
    // Keys with modifiers, keys the globe has no use for, and Escape once nothing is left to hide
    // are the page's (globeKeyAction).
    const action = globeKeyAction(event.key, event, assist);
    if (!current || !action) return;
    event.preventDefault();
    setAssist((shown) => nextAssist(shown, action));
    if (action.kind === 'dismiss') return;
    if (action.kind === 'rotate') turn(action);
    else if (action.kind === 'zoom') zoom(action.factor);
    else if (action.kind === 'reset') reset();
    else {
      const centre = current.centre();
      stopRotating();
      // Not turned there by the user, or still on the selected place: keep its name and checks.
      if (!selectsCentre(turned.current, centre, place, MAX_LATITUDE)) {
        announce(
          `${place.name} is still selected. Turn the globe to another point, then press Enter.`,
        );
        return;
      }
      const picked = pointPlace(centre.latitude, centre.longitude);
      onSelect(picked);
      announce(`Selected ${picked.name}.`);
    }
  };

  if (loadError) throw loadError;
  return (
    <GlobeCard
      id={id}
      place={place}
      status={status}
      base={base}
      daily={daily}
      showDaily={showDaily}
      outlined={outlines.length}
      alertCount={alerts.length}
      reducedMotion={reducedMotion}
      paused={paused}
      closer={closer}
      wheelHint={wheelHint}
      assist={assist}
      announcement={announcement}
      now={clock()}
      sectionRef={section}
      stageRef={stage}
      hostRef={host}
      labelRef={label}
      restartRef={restartButton}
      onSurfaceFocus={() => setAssist('full')}
      onKeyDown={onKeyDown}
      onRotate={(key) => {
        const action = globeKey(key);
        if (action?.kind === 'rotate') turn(action);
      }}
      onZoom={zoom}
      onReset={reset}
      onToggleDaily={() => setShowDaily((shown) => !shown)}
      onTogglePause={() => {
        if (paused) setRotating(true);
        setPaused(!paused);
      }}
      onRestart={() => {
        // Focus waits on the globe while it starts again, and stays there once it is back.
        focusAfter.current = 'surface';
        stage.current?.focus();
        setAttempt((value) => value + 1);
      }}
      onRetryImagery={retryImagery}
    />
  );
}
