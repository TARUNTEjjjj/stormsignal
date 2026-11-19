import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMBIENT_FRAME_MS,
  AUTO_ROTATE_MS,
  DAILY_OPACITY,
  GLOBE_BASE_LAYER,
  GLOBE_DAILY,
  HOME_GLIDE_MS,
  LOOK_TIMER_MS,
  MIN_DAILY_COVERAGE,
  RECHECK_MS,
  ROTATE_BUTTONS,
  SETTLE_MS,
  SHADING,
  SHADING_GLSL,
  ambientWait,
  angularDistance,
  autoRotating,
  coordinateLabel,
  cosmeticMotion,
  createImageCache,
  createLifecycle,
  dailyLayer,
  dailyNote,
  daylight,
  drawing,
  fadeDaily,
  fitDistance,
  focusAfterStatus,
  focusNow,
  globeDailyCandidates,
  globeDailyDate,
  globeFallback,
  globeImageUrl,
  globeKey,
  globeKeyAction,
  globeSubtitle,
  hatchDegrees,
  hexColor,
  imagedAt,
  imageryCoverage,
  imageryCredit,
  imageryMask,
  imageryNotice,
  isCentredOn,
  isTap,
  latLonToVector,
  loadDailyMosaic,
  markersKey,
  mosaicDateLabel,
  mosaicRecheck,
  nearestMarker,
  nextAssist,
  nextDaily,
  nextFrame,
  outlineNote,
  outlineSegments,
  outlinesKey,
  pickDaily,
  placeImagery,
  pointPlace,
  raySphere,
  readGlobeImage,
  requestImagery,
  retryLayers,
  returnsHome,
  sceneBase,
  sceneDaily,
  selectsCentre,
  shade,
  shouldLook,
  shownMosaic,
  skipsFrame,
  solarElevation,
  srgbDecode,
  srgbEncode,
  starfield,
  startGlobe,
  stepView,
  subsolarPoint,
  sunDirection,
  utcDate,
  vectorToLatLon,
  warningOutlines,
  type BaseImagery,
  type DailyEvent,
  type DailyImagery,
  type DailyMosaic,
  type FrameState,
  type GlobeStart,
  type GlobeStarter,
  type ImageryMask,
  type MosaicLoader,
  type Vector,
} from '../src/globe';
import { domainUrl, normalizeLongitude } from '../src/imagery';
import type { WeatherAlert } from '../src/types';

const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );
const closeVector = (actual: Vector, expected: Vector, what: string) =>
  actual.forEach((value, axis) => close(value, expected[axis], 1e-9, `${what} axis ${axis}`));
/** The angle between two directions, in degrees. */
const angle = (a: Vector, b: Vector) =>
  (Math.acos(
    Math.max(
      -1,
      Math.min(
        1,
        (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b)),
      ),
    ),
  ) *
    180) /
  Math.PI;

test('latitude and longitude round-trip through a position, at the poles and across 180°', () => {
  for (const latitude of [-90, -89.9999, -45, -0.0001, 0, 13.0827, 66.5, 89.9999, 90])
    for (const longitude of [-180, -179.9999, -120, -0.0001, 0, 80.2707, 179.9999, 180]) {
      const position = latLonToVector(latitude, longitude, 2.5);
      close(Math.hypot(...position), 2.5, 1e-12, 'radius');
      const back = vectorToLatLon(position);
      close(back.latitude, latitude, 1e-9, `latitude of ${latitude}, ${longitude}`);
      // Every longitude names the same pole; elsewhere 180° and −180° are one meridian.
      if (Math.abs(latitude) < 90)
        close(
          normalizeLongitude(back.longitude - longitude),
          0,
          1e-7,
          `longitude of ${latitude}, ${longitude}`,
        );
      closeVector(latLonToVector(back.latitude, back.longitude, 2.5), position, 'position');
      assert.ok(back.longitude >= -180 && back.longitude < 180, `${back.longitude} is in range`);
    }
  assert.deepEqual(vectorToLatLon([0, 3, 0]), { latitude: 90, longitude: 0 });
  assert.deepEqual(vectorToLatLon([0, -1, 0]), { latitude: -90, longitude: 0 });
  assert.throws(() => vectorToLatLon([0, 0, 0]));
});

test("positions follow three.js's sphere layout, so the equirectangular image lands in place", () => {
  // SphereGeometry: x = −cos(2πu)·sin(πv), y = cos(πv), z = sin(2πu)·sin(πv), with the image's
  // column u = (longitude + 180) / 360 and its row from the top v = (90 − latitude) / 180.
  for (const [latitude, longitude] of [
    [0, 0],
    [0, 90],
    [0, -90],
    [51.5, -0.13],
    [-33.9, 151.2],
    [64.1, -21.9],
  ]) {
    const u = (longitude + 180) / 360;
    const v = (90 - latitude) / 180;
    closeVector(
      latLonToVector(latitude, longitude),
      [
        -Math.cos(2 * Math.PI * u) * Math.sin(Math.PI * v),
        Math.cos(Math.PI * v),
        Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * v),
      ],
      `${latitude}, ${longitude}`,
    );
  }
  closeVector(latLonToVector(0, 0), [1, 0, 0], 'Greenwich on the equator');
  closeVector(latLonToVector(0, 90), [0, 0, -1], '90° E');
  closeVector(latLonToVector(90, 0), [0, 1, 0], 'north pole');
});

// Reference instants from the published 2026 equinox and solstice times (UTC), and the equation of
// time at its extremes and zeros. Stated tolerance: 0.05° of latitude, 0.25° of longitude.
test('the subsolar point matches the 2026 equinoxes, solstices and the equation of time', () => {
  const at = (iso: string) => subsolarPoint(Date.parse(iso));
  close(at('2026-03-20T14:46:00Z').latitude, 0, 0.05, 'March equinox');
  close(at('2026-06-21T08:24:00Z').latitude, 23.436, 0.05, 'June solstice');
  close(at('2026-09-23T00:05:00Z').latitude, 0, 0.05, 'September equinox');
  close(at('2026-12-21T20:50:00Z').latitude, -23.436, 0.05, 'December solstice');
  // At 12:00 UTC the sun is over 0° only when the equation of time is zero (mid-April); on
  // 3 November the sun runs 16.4 minutes fast (west of Greenwich), on 11 February 14.2 slow.
  close(at('2026-04-15T12:00:00Z').longitude, 0, 0.25, '15 April noon');
  close(at('2026-11-03T12:00:00Z').longitude, -4.1, 0.25, '3 November noon');
  close(at('2026-02-11T12:00:00Z').longitude, 3.55, 0.25, '11 February noon');
  // It moves west by 15° an hour, across 180° too.
  const noon = at('2026-11-18T12:00:00Z');
  const later = at('2026-11-18T18:00:00Z');
  close(normalizeLongitude(noon.longitude - later.longitude), 90, 0.05, 'six hours later');
  close(normalizeLongitude(at('2026-11-19T00:00:00Z').longitude - noon.longitude), -180, 0.1, '');
});

test('the sun stands overhead at the subsolar point and below the horizon at its antipode', () => {
  const time = Date.parse('2026-11-18T06:30:00Z');
  const sun = subsolarPoint(time);
  close(solarElevation(sun.latitude, sun.longitude, time), 90, 1e-6, 'overhead');
  close(solarElevation(-sun.latitude, sun.longitude + 180, time), -90, 1e-6, 'antipode');
  close(solarElevation(sun.latitude + 90, sun.longitude, time), 0, 1e-6, 'a quarter turn away');
  // Chennai at noon local time in November: about 90 − 13.1 − 19.2 degrees.
  close(solarElevation(13.0827, 80.2707, time), 57.6, 0.5, 'Chennai');
});

test('the place card names day, civil twilight and night by the height of the sun', () => {
  assert.deepEqual(daylight(42.4), { phase: 'day', text: 'Daylight · sun 42° up' });
  assert.deepEqual(daylight(-0.5), { phase: 'day', text: 'Daylight · sun on the horizon' });
  assert.deepEqual(daylight(-3.2), {
    phase: 'twilight',
    text: 'Twilight · sun 3° below the horizon',
  });
  assert.deepEqual(daylight(-41), { phase: 'night', text: 'Night · sun 41° below the horizon' });
  assert.equal(daylight(Number.NaN).text, 'Sun position unknown');
});

test('whole-Earth requests name the layer, latitude-first EPSG:4326 bounds and a UTC date', () => {
  assert.equal(
    globeImageUrl(GLOBE_BASE_LAYER),
    'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=BlueMarble_ShadedRelief_Bathymetry&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=2048&HEIGHT=1024&FORMAT=image/jpeg',
  );
  assert.equal(
    globeImageUrl(GLOBE_DAILY.id, '2026-11-17', 1024),
    'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=1024&HEIGHT=512&FORMAT=image/jpeg&TIME=2026-11-17',
  );
  for (const date of ['2026-02-30', '2026-11-17T00:00:00Z', 'latest', 'default', ''])
    assert.throws(() => globeImageUrl(GLOBE_DAILY.id, date), /date/, date);
  assert.throws(() => globeImageUrl('Layer&TIME=2026-01-01'), /layer/);
  assert.throws(() => globeImageUrl(GLOBE_BASE_LAYER, undefined, 2047), /size/);
  // The daily layer's dates come from the same DescribeDomains request as the map's layers.
  const describe = new URL(domainUrl(GLOBE_DAILY, Date.parse('2026-11-18T18:31:00Z')));
  assert.equal(describe.searchParams.get('LAYER'), GLOBE_DAILY.id);
  assert.equal(describe.searchParams.get('TIME'), '2026-11-11/2026-11-18');
});

test('the globe shows the newest daily mosaic whose UTC day has ended, wherever the viewer is', (t) => {
  const zone = process.env.TZ;
  t.after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const frames = ['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'];
  // UTC+14 and UTC−11: their local dates differ from the UTC date at these instants.
  for (const timezone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
    process.env.TZ = timezone;
    assert.equal(utcDate(Date.parse('2026-11-18T23:30:00Z')), '2026-11-18', timezone);
    assert.equal(globeDailyDate(frames, Date.parse('2026-11-18T23:30:00Z')), '2026-11-17');
    assert.equal(globeDailyDate(frames, Date.parse('2026-11-19T00:30:00Z')), '2026-11-18');
    assert.equal(mosaicDateLabel('2026-11-17'), '17 Nov 2026', timezone);
  }
  // Only today's mosaic listed: it is shown, and labelled by its date.
  assert.equal(globeDailyDate(['2026-11-18'], Date.parse('2026-11-18T05:00:00Z')), '2026-11-18');
  // Never a day the provider did not list, a malformed one, or one after today.
  assert.equal(globeDailyDate(['2026-11-19', 'latest'], Date.parse('2026-11-18T05:00:00Z')), null);
  assert.equal(globeDailyDate([], Date.now()), null);
  assert.equal(
    globeDailyDate(['2026-11-16', '2026-11-12'], Date.parse('2026-11-18T05:00:00Z')),
    '2026-11-16',
  );
});

/** An equirectangular RGBA copy with imagery where `lit` says, GIBS's gap fill elsewhere. */
const mosaic = (width: number, height: number, lit: (row: number, column: number) => boolean) => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++)
      // Dark ocean in true colour is imagery; GIBS's gap fill is black or JPEG noise near it.
      pixels.set(lit(row, column) ? [10, 22, 48, 255] : [3, 5, 2, 255], (row * width + column) * 4);
  return imageryMask(pixels, width, height);
};

test('daily coverage counts imaged area, so dark polar rows weigh little and gaps count as gaps', () => {
  assert.equal(imageryCoverage(mosaic(64, 32, () => true)), 1);
  assert.equal(imageryCoverage(mosaic(64, 32, () => false)), 0);
  close(imageryCoverage(mosaic(64, 32, (_, column) => column < 32)), 0.5, 1e-9, 'half');
  // Black north of 60° (polar night): 1 − (1 − sin 60°) / 2 of the surface is imaged.
  close(
    imageryCoverage(mosaic(64, 60, (row) => row >= 10)),
    1 - (1 - Math.sin(Math.PI / 3)) / 2,
    0.002,
    'polar night',
  );
  // Too few pixels for the stated size: nothing is counted as imaged.
  assert.equal(imageryCoverage(imageryMask(new Uint8ClampedArray(4), 64, 32)), 0);
});

test('the selected place is looked up in the mosaic, at the poles and on both sides of 180°', () => {
  // 18 Nov 2026's partial mosaic in miniature: imagery west of 18° W only, none in polar night.
  const partial = mosaic(360, 180, (row, column) => column < 162 && row >= 20);
  assert.equal(imagedAt(partial, 13.0827, 80.2707), false, 'Chennai, in the gap');
  assert.equal(imagedAt(partial, 51.5072, -0.1276), false, 'London, east of 18° W');
  assert.equal(imagedAt(partial, 40.7128, -74.006), true, 'New York');
  assert.equal(imagedAt(partial, -33.86, 151.21), false, 'Sydney');
  assert.equal(imagedAt(partial, 78.2, 15.6), false, 'Svalbard, polar night');
  // 180° and −180° are one meridian, in the first column; 179.99° is the last.
  const east = mosaic(360, 180, (_, column) => column === 359);
  const west = mosaic(360, 180, (_, column) => column === 0);
  assert.equal(imagedAt(east, 0, 179.99), true);
  assert.equal(imagedAt(west, 0, 180), true);
  assert.equal(imagedAt(west, 0, -180), true);
  assert.equal(imagedAt(west, 0, 540), true, 'a longitude past 180° wraps');
  // The poles are the first and last rows.
  const north = mosaic(360, 180, (row) => row === 0);
  assert.equal(imagedAt(north, 90, 0), true);
  assert.equal(imagedAt(north, -90, 0), false);
  assert.equal(
    imagedAt(
      mosaic(360, 180, (row) => row === 179),
      -90,
      45,
    ),
    true,
  );
  // No mask, or no place: unknown rather than imaged.
  assert.equal(imagedAt(imageryMask([], 0, 0), 10, 10), null);
  assert.equal(imagedAt(partial, Number.NaN, 10), null);
});

test('a partial newest mosaic sends the globe to the day before, which says why', () => {
  const frames = ['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'];
  const now = Date.parse('2026-11-19T07:30:00Z');
  assert.deepEqual(globeDailyCandidates(frames, now), ['2026-11-18', '2026-11-17']);
  assert.deepEqual(globeDailyCandidates([...frames, '2026-11-19'], now, 3), [
    '2026-11-18',
    '2026-11-17',
    '2026-11-16',
  ]);
  assert.deepEqual(globeDailyCandidates(['2026-11-19', '2026-11-19'], now), ['2026-11-19']);
  // The newest covers enough: it is shown and nothing older is needed.
  assert.equal(pickDaily([{ coverage: 0.93 }]), 0);
  assert.equal(pickDaily([{ coverage: MIN_DAILY_COVERAGE }]), 0);
  // It does not: the day before covers more, so it is shown.
  assert.equal(pickDaily([{ coverage: 0.46 }, { coverage: 0.94 }]), 1);
  // Both are partial: the one that covers clearly more, and the newer when they are close.
  assert.equal(pickDaily([{ coverage: 0.46 }, { coverage: 0.6 }]), 1);
  assert.equal(pickDaily([{ coverage: 0.6 }, { coverage: 0.61 }]), 0);
  // A coverage that could not be measured never sends the globe to an older day.
  assert.equal(pickDaily([{ coverage: null }, { coverage: 0.99 }]), 0);
  assert.equal(pickDaily([]), -1);
  const shown = (skipped: { date: string; coverage: number | null } | null): DailyImagery => ({
    state: 'ready',
    date: '2026-11-16',
    coverage: 0.94,
    mask: null,
    skipped,
    refreshError: null,
  });
  // A mosaic still at 45% a day after its UTC day ended is not "filling in": no "so far".
  assert.equal(
    dailyNote(shown({ date: '2026-11-17', coverage: 0.46 })),
    "NASA's 17 Nov 2026 mosaic covers only 46% of Earth, so the globe shows 16 Nov 2026.",
  );
  assert.equal(
    dailyNote(shown({ date: '2026-11-17', coverage: null })),
    "NASA's 17 Nov 2026 mosaic did not load, so the globe shows 16 Nov 2026.",
  );
  assert.equal(dailyNote(shown(null)), null);
});

test('a page left open looks again after UTC midnight, and hourly while the mosaic is partial', () => {
  const ready = (overrides: Partial<DailyMosaic & { refreshError: string | null }> = {}) =>
    ({
      state: 'ready',
      date: '2026-11-17',
      coverage: 0.93,
      mask: null,
      skipped: null,
      refreshError: null,
      ...overrides,
    }) as DailyImagery;
  const checked = Date.parse('2026-11-18T09:00:00Z');
  const later = (ms: number) => checked + ms;
  // A complete mosaic: nothing more to look for until the UTC day of the check ends.
  assert.equal(mosaicRecheck(ready(), checked, later(RECHECK_MS * 5)), false);
  assert.equal(mosaicRecheck(ready(), checked, Date.parse('2026-11-18T23:59:00Z')), false);
  assert.equal(mosaicRecheck(ready(), checked, Date.parse('2026-11-19T00:01:00Z')), true);
  // The day before is shown, the newest is partial, or the last look failed: hourly.
  for (const daily of [
    ready({ skipped: { date: '2026-11-18', coverage: 0.45 } }),
    ready({ coverage: 0.6 }),
    ready({ refreshError: 'NASA imagery metadata unavailable (503).' }),
    { state: 'failed', message: 'NASA imagery timed out.' } as DailyImagery,
  ]) {
    assert.equal(mosaicRecheck(daily, checked, later(RECHECK_MS - 60_000)), false);
    assert.equal(mosaicRecheck(daily, checked, later(RECHECK_MS)), true);
  }
  // Never while the first load runs or before any; a clock set back waits for the next day.
  assert.equal(mosaicRecheck({ state: 'loading' }, checked, later(RECHECK_MS * 30)), false);
  assert.equal(mosaicRecheck(ready({ coverage: 0.6 }), null, later(RECHECK_MS)), false);
  assert.equal(mosaicRecheck(ready({ coverage: 0.6 }), checked, checked - RECHECK_MS), false);
});

const place = { latitude: 13.0827, longitude: 80.2707 };
const imaged: DailyImagery = {
  state: 'ready',
  date: '2026-11-17',
  coverage: 0.46,
  mask: mosaic(360, 180, (_, column) => column < 162),
  skipped: null,
  refreshError: null,
};
test('the place card says whether NASA imaged the place, never showing missing data as clear', () => {
  const ready: BaseImagery = { state: 'ready' };
  const card = (daily: DailyImagery, show = true, base: BaseImagery = ready) => {
    const line = placeImagery('ready', base, daily, show, place.latitude, place.longitude);
    assert.ok(line, 'a running globe always says something about imagery');
    return line;
  };
  assert.deepEqual(card(imaged), {
    kind: 'gap',
    text: 'No imagery here on 17 Nov: map shown without clouds',
  });
  assert.deepEqual(placeImagery('ready', ready, imaged, true, 40.7128, -74.006), {
    kind: 'imaged',
    text: 'Imaged by NOAA-20 on 17 Nov',
  });
  assert.equal(
    card({ ...imaged, mask: null } as DailyImagery).text,
    'NOAA-20 mosaic of 17 Nov; coverage here unknown',
  );
  assert.equal(card({ state: 'loading' }).kind, 'pending');
  assert.match(card({ state: 'failed', message: 'x' }).text, /base map has no clouds/);
  assert.match(card(imaged, false).text, /hidden; the base map has no clouds/);
  assert.equal(
    card({ state: 'failed', message: 'x' }, true, { state: 'failed', message: 'y' }).text,
    'No NASA imagery loaded',
  );
  // Without a 3D view the card says nothing about imagery it is not showing.
  assert.equal(placeImagery('unsupported', ready, imaged, true, 13, 80), null);
});

test('the subtitle and the outline note stay true in every state of the globe', () => {
  const ready: BaseImagery = { state: 'ready' };
  const failed = (message: string) => ({ state: 'failed', message }) as const;
  assert.equal(
    globeSubtitle('ready', ready, imaged, true),
    "Day and night as they fall right now, over NASA's 17 Nov 2026 satellite mosaic.",
  );
  assert.equal(
    globeSubtitle('ready', failed('a'), failed('b'), true),
    'Day and night as they fall right now. NASA imagery did not load.',
  );
  assert.equal(
    globeSubtitle('ready', failed('a'), imaged, true),
    "Day and night as they fall right now, over NASA's 17 Nov 2026 satellite mosaic. The base map did not load.",
  );
  assert.equal(
    globeSubtitle('ready', ready, failed('b'), true),
    "Day and night as they fall right now, over NASA's cloud-free Blue Marble map.",
  );
  assert.equal(
    globeSubtitle('ready', ready, imaged, false),
    "Day and night as they fall right now, over NASA's cloud-free Blue Marble map.",
  );
  assert.equal(
    globeSubtitle('starting', { state: 'loading' }, { state: 'loading' }, true),
    'Day and night as they fall right now, over NASA satellite imagery.',
  );
  assert.match(globeSubtitle('unsupported', ready, imaged, true), /not available/);
  assert.match(globeSubtitle('lost', ready, imaged, true), /stopped/);
  assert.match(globeSubtitle('failed', ready, imaged, true), /stopped/);
  // Outlines: counted when drawn, never "no warning" when none is drawn, and without a 3D view
  // the reader is sent to the warning list and the map.
  assert.equal(outlineNote('ready', 1, 1), '1 active official warning area is outlined in red.');
  assert.equal(
    outlineNote('starting', 2, 5),
    '2 active official warning areas are outlined in red. 3 more have no outline to draw.',
  );
  assert.equal(
    outlineNote('ready', 0, 2),
    'Active warnings for this place have no outline to draw.',
  );
  assert.match(outlineNote('ready', 0, 0), /No outline here does not mean there is no warning/);
  for (const status of ['unsupported', 'lost', 'failed'] as const) {
    const note = outlineNote(status, 1, 2);
    assert.match(note, /cannot draw warning outlines/);
    assert.match(note, /warning list and the satellite map/);
    assert.doesNotMatch(note, /outlined in red/);
  }
});

test('each stopped state says why, and only a stopped globe offers Restart', () => {
  for (const status of ['starting', 'ready'] as const) assert.equal(globeFallback(status), null);
  const unsupported = globeFallback('unsupported');
  assert.equal(unsupported?.restart, false, 'without WebGL 2 a restart cannot help');
  assert.match(unsupported?.text ?? '', /could not start WebGL 2/);
  const lost = globeFallback('lost');
  const failed = globeFallback('failed');
  assert.equal(lost?.restart, true);
  assert.equal(failed?.restart, true);
  assert.match(lost?.text ?? '', /browser reset its graphics/);
  // A drawing error is not a graphics reset.
  assert.doesNotMatch(failed?.text ?? '', /reset its graphics/);
  assert.match(failed?.text ?? '', /could not draw a frame/);
  for (const copy of [unsupported, lost, failed])
    assert.match(copy?.text ?? '', /Search, quick locations and the satellite map still select/);
});

/** Every daily state a globe can reach, and whether the daily layer is switched on. */
function dailyStates(): [string, DailyImagery][] {
  const mosaicOf = (date: string): DailyMosaic => ({
    date,
    coverage: 0.93,
    mask: null,
    skipped: null,
  });
  const run = (...events: DailyEvent[]) =>
    events.reduce<DailyImagery>(nextDaily, { state: 'loading' });
  const failed: DailyEvent = {
    type: 'failed',
    message: 'NASA imagery metadata unavailable (503).',
  };
  const start: DailyEvent = { type: 'start' };
  const loaded = (date: string): DailyEvent => ({ type: 'loaded', mosaic: mosaicOf(date) });
  return [
    ['first load', run(start)],
    ['first load failed', run(start, failed)],
    ['loaded', run(start, loaded('2026-11-16'))],
    ['looking again', run(start, loaded('2026-11-16'), start)],
    ['look failed', run(start, loaded('2026-11-16'), start, failed)],
    ['look failed twice', run(start, loaded('2026-11-16'), start, failed, start, failed)],
    ['newer found', run(start, loaded('2026-11-16'), start, failed, start, loaded('2026-11-17'))],
    ['retry after failure', run(start, failed, start)],
    ['retry worked', run(start, failed, start, loaded('2026-11-17'))],
  ];
}

test('a failed look for a newer mosaic keeps the shown one, dated, and never drops real clouds', () => {
  const states = Object.fromEntries(dailyStates());
  // While NASA is asked again, and when that fails, the mosaic on show stays, with its date.
  for (const name of ['looking again', 'look failed', 'look failed twice']) {
    const daily = states[name];
    assert.equal(daily.state, 'ready', name);
    assert.equal(shownMosaic(daily, true)?.date, '2026-11-16', name);
  }
  assert.equal(
    (states['look failed'] as { refreshError: string | null }).refreshError,
    'NASA imagery metadata unavailable (503).',
  );
  assert.equal((states['looking again'] as { refreshError: string | null }).refreshError, null);
  // A newer mosaic clears the failed look; a first load that fails shows nothing.
  assert.equal(shownMosaic(states['newer found'], true)?.date, '2026-11-17');
  assert.equal((states['newer found'] as { refreshError: string | null }).refreshError, null);
  assert.equal(states['first load failed'].state, 'failed');
  assert.equal(states['retry after failure'].state, 'loading');
  assert.equal(shownMosaic(states['retry worked'], true)?.date, '2026-11-17');
  // The notice names a failed look and the date still shown, with nothing claimed missing.
  const notice = imageryNotice({ state: 'ready' }, states['look failed']) ?? '';
  assert.match(notice, /could not be checked for a newer daily mosaic: NASA imagery metadata/);
  assert.match(notice, /still shows the 16 Nov 2026 mosaic/);
  assert.doesNotMatch(notice, /no clouds|did not load/);
  assert.equal(imageryNotice({ state: 'ready' }, states['newer found']), null);
});

test('whatever the daily state, the copy dates exactly the mosaic that is drawn', () => {
  const day = (date: string) => mosaicDateLabel(date).replace(/ \d{4}$/, '');
  const bases: BaseImagery[] = [
    { state: 'loading' },
    { state: 'ready' },
    { state: 'failed', message: 'NASA imagery is unavailable (503).' },
  ];
  for (const [name, daily] of dailyStates())
    for (const showDaily of [true, false])
      for (const base of bases) {
        const what = `${name}, daily ${showDaily ? 'on' : 'off'}, base ${base.state}`;
        // GlobeView draws the daily layer from shownMosaic alone.
        const drawn = shownMosaic(daily, showDaily);
        const subtitle = globeSubtitle('ready', base, daily, showDaily);
        const line = placeImagery('ready', base, daily, showDaily, 13, 80);
        const credit = imageryCredit(base, daily, showDaily);
        if (drawn) {
          assert.match(subtitle, new RegExp(mosaicDateLabel(drawn.date)), what);
          assert.match(line?.text ?? '', new RegExp(day(drawn.date)), what);
          assert.equal(credit?.daily, true, what);
          assert.doesNotMatch(line?.text ?? '', /No daily imagery|hidden/, what);
        } else {
          assert.doesNotMatch(subtitle, /\d{4}/, `${what}: no date without a mosaic`);
          assert.doesNotMatch(line?.text ?? '', /NOAA-20|Imaged/, what);
          assert.notEqual(credit?.daily, true, what);
        }
      }
});

test('only imagery that is drawn, or on its way, is credited', () => {
  const ready: BaseImagery = { state: 'ready' };
  const failedBase: BaseImagery = { state: 'failed', message: 'x' };
  const failedDaily: DailyImagery = { state: 'failed', message: 'y' };
  assert.deepEqual(imageryCredit(ready, imaged, true), { base: true, daily: true, loading: false });
  assert.deepEqual(imageryCredit(ready, imaged, false), {
    base: true,
    daily: false,
    loading: false,
  });
  assert.deepEqual(imageryCredit({ state: 'loading' }, { state: 'loading' }, true), {
    base: false,
    daily: false,
    loading: true,
  });
  assert.deepEqual(imageryCredit(failedBase, imaged, true), {
    base: false,
    daily: true,
    loading: false,
  });
  // Both images failed: the globe is a plain sphere, and no imagery is credited or described.
  assert.equal(imageryCredit(failedBase, failedDaily, true), null);
  assert.equal(imageryCredit(failedBase, imaged, false), null);
});

/** An image the fake NASA sent, with the share of Earth it had imaged when it was read. */
type FakeImage = { source: string; width: number; height: number; coverage?: number | null };
/**
 * A fake NASA for loadDailyMosaic: each date answers with a coverage, a failure or a hang. Like
 * the page, it keeps each image it read in `memory` until it is forgotten, and reads from there;
 * `asked.images` lists the downloads.
 */
function fakeNasa(
  answers: Record<string, number | null | Error>,
  dates = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
  memory = new Map<string, FakeImage>(),
) {
  const asked: { frames: boolean[]; images: string[]; forgotten: string[] } = {
    frames: [],
    images: [],
    forgotten: [],
  };
  const dateOf = (url: string) => /TIME=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? '';
  const loader: MosaicLoader<string> = {
    online: () => true,
    frames: async (_, force) => {
      asked.frames.push(force);
      return dates;
    },
    image: async (url) => {
      const kept = memory.get(url);
      if (kept) return kept;
      const date = dateOf(url);
      asked.images.push(date);
      const answer = answers[date];
      if (answer instanceof Error) throw answer;
      // What NASA had imaged when it was read: a copy held later does not fill in.
      const image = { source: date, width: 2048, height: 1024, coverage: answer };
      memory.set(url, image);
      return image;
    },
    held: (url) => memory.get(url),
    measure: (image) => {
      const { coverage } = image as FakeImage;
      if (typeof coverage !== 'number') return null;
      // Imagery in the first `coverage` share of the columns.
      const data = new Uint8Array(360 * 180);
      const columns = Math.round(coverage * 360);
      for (let row = 0; row < 180; row++) data.fill(1, row * 360, row * 360 + columns);
      return { width: 360, height: 180, data } satisfies ImageryMask;
    },
    forget: (url) => {
      memory.delete(url);
      asked.forgotten.push(dateOf(url));
    },
  };
  return { loader, asked, memory };
}
const MORNING = Date.parse('2026-11-19T07:30:00Z');

test('the daily loader shows the newest complete mosaic, or the day before with the reason', async () => {
  const signal = new AbortController().signal;
  const load = (answers: Record<string, number | null | Error>, refresh = false) => {
    const nasa = fakeNasa(answers);
    return {
      nasa,
      result: loadDailyMosaic(nasa.loader, signal, { refresh, now: MORNING }),
    };
  };
  // The newest ended day is complete: it alone is read.
  let { nasa, result } = load({ '2026-11-18': 0.95 });
  let mosaic = await result;
  assert.equal(mosaic.date, '2026-11-18');
  assert.equal(mosaic.skipped, null);
  assert.equal(mosaic.image.source, '2026-11-18');
  assert.deepEqual(nasa.asked.images, ['2026-11-18']);
  assert.deepEqual(nasa.asked.frames, [false], 'the dates come from the five-minute cache');
  assert.deepEqual(nasa.asked.forgotten, []);
  // It is partial: the day before covers more and is shown, and the notes name the newer one.
  ({ nasa, result } = load({ '2026-11-18': 0.45, '2026-11-17': 0.93 }, true));
  mosaic = await result;
  assert.equal(mosaic.date, '2026-11-17');
  assert.deepEqual(mosaic.skipped?.date, '2026-11-18');
  close(mosaic.skipped?.coverage ?? 0, 0.45, 0.01, 'skipped coverage');
  assert.deepEqual(nasa.asked.images, ['2026-11-18', '2026-11-17']);
  assert.deepEqual(nasa.asked.forgotten, [], 'nothing was held yet');
  assert.deepEqual(nasa.asked.frames, [true], 'a refresh asks NASA for its dates again');
  // The newest fails: the day before is shown, and the note says the newer one did not load.
  ({ result } = load({
    '2026-11-18': new Error('NASA imagery is unavailable (503).'),
    '2026-11-17': 0.9,
  }));
  mosaic = await result;
  assert.equal(mosaic.date, '2026-11-17');
  assert.deepEqual(mosaic.skipped, { date: '2026-11-18', coverage: null });
  // The newest is partial and the day before fails: the newest is shown rather than nothing.
  ({ result } = load({ '2026-11-18': 0.45, '2026-11-17': new Error('timed out') }));
  mosaic = await result;
  assert.equal(mosaic.date, '2026-11-18');
  assert.equal(mosaic.skipped, null);
  // Coverage that cannot be measured counts as enough: no older day is read.
  ({ nasa, result } = load({ '2026-11-18': null }));
  assert.equal((await result).date, '2026-11-18');
  assert.deepEqual(nasa.asked.images, ['2026-11-18']);
  // Both fail: the first failure is reported.
  ({ result } = load({ '2026-11-18': new Error('first'), '2026-11-17': new Error('second') }));
  await assert.rejects(result, /first/);
});

test('a partial mosaic is kept until the next look, which reads it again', async () => {
  const signal = new AbortController().signal;
  const memory = new Map<string, FakeImage>();
  const answers: Record<string, number> = { '2026-11-18': 0.45, '2026-11-17': 0.93 };
  const load = async (refresh: boolean) => {
    const nasa = fakeNasa(answers, undefined, memory);
    const mosaic = await loadDailyMosaic(nasa.loader, signal, { refresh, now: MORNING });
    return { mosaic, asked: nasa.asked };
  };
  let { mosaic, asked } = await load(false);
  assert.equal(mosaic.date, '2026-11-17');
  assert.deepEqual(asked.images, ['2026-11-18', '2026-11-17']);
  // A quick switch to Data saver and back: the globe starts again and downloads nothing, the
  // partial mosaic included (about 0.3 MB each time otherwise).
  for (let cycle = 0; cycle < 3; cycle++) {
    ({ mosaic, asked } = await load(false));
    assert.equal(mosaic.date, '2026-11-17');
    assert.equal(mosaic.skipped?.date, '2026-11-18');
    assert.deepEqual(asked.images, [], `return ${cycle + 1} downloaded nothing`);
    assert.deepEqual(asked.frames, [false]);
  }
  // The hourly look reads the partial one again, as it may have filled in; the complete one stays.
  ({ mosaic, asked } = await load(true));
  assert.deepEqual(asked.forgotten, ['2026-11-18']);
  assert.deepEqual(asked.images, ['2026-11-18']);
  assert.equal(mosaic.date, '2026-11-17', 'still partial, so the day before is still shown');
  // By the next look it has filled in: it is shown, and nothing older is read.
  answers['2026-11-18'] = 0.97;
  ({ mosaic, asked } = await load(true));
  assert.equal(mosaic.date, '2026-11-18');
  assert.equal(mosaic.skipped, null);
  assert.deepEqual(asked.images, ['2026-11-18']);
  // Complete now, it is not downloaded again by a later look.
  ({ asked } = await load(true));
  assert.deepEqual(asked.images, []);
  assert.deepEqual(asked.forgotten, []);
  // When both days are partial, a look reads both again (docs/privacy.md says so).
  memory.clear();
  Object.assign(answers, { '2026-11-18': 0.45, '2026-11-17': 0.6 });
  await load(false);
  ({ mosaic, asked } = await load(true));
  assert.deepEqual(asked.forgotten, ['2026-11-18', '2026-11-17']);
  assert.deepEqual(asked.images, ['2026-11-18', '2026-11-17']);
  assert.equal(mosaic.date, '2026-11-17', 'the one that covers clearly more');
});

test('the daily loader asks nothing offline, needs a listed day and stops when cancelled', async () => {
  const offline = fakeNasa({ '2026-11-18': 0.9 });
  offline.loader.online = () => false;
  await assert.rejects(
    loadDailyMosaic(offline.loader, new AbortController().signal, { now: MORNING }),
    /waits for a connection/,
  );
  assert.deepEqual(offline.asked, { frames: [], images: [], forgotten: [] });
  const unlisted = fakeNasa({}, ['2026-11-20', 'latest']);
  await assert.rejects(
    loadDailyMosaic(unlisted.loader, new AbortController().signal, { now: MORNING }),
    /not listed a recent daily mosaic/,
  );
  // Cancelled while the newest image loads: the cancellation, not a fallback day.
  const controller = new AbortController();
  const cancelled = fakeNasa({});
  cancelled.loader.image = async (url) => {
    cancelled.asked.images.push(url);
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  };
  await assert.rejects(
    loadDailyMosaic(cancelled.loader, controller.signal, { now: MORNING }),
    (error: Error) => error.name === 'AbortError',
  );
  assert.equal(cancelled.asked.images.length, 1, 'no older day after a cancel');
});

/** sRGB luma of a linear colour as the screen shows it (0 to 1). */
const displayLuma = (colour: Vector) => {
  const [r, g, b] = colour.map(srgbEncode);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const linear = (hex: string) =>
  [1, 3, 5].map((at) => srgbDecode(Number.parseInt(hex.slice(at, at + 2), 16) / 255)) as Vector;

test('night is at most a fifth of day on screen, and still shows land, sea and cloud', () => {
  const violet = linear('#8b7cff');
  const surfaces = {
    cloud: linear('#f2f4f8'),
    desert: linear('#c9a46c'),
    land: linear('#7a6a4c'),
    forest: linear('#2f4a2a'),
    ocean: linear('#0d2244'),
  };
  // `light` is the cosine of the sun's angle from the zenith: 0.4 is the sun 24° up.
  for (const [name, surface] of Object.entries(surfaces)) {
    const day = displayLuma(shade(surface, 0.4, violet));
    const night = displayLuma(shade(surface, -0.4, violet));
    assert.ok(night / day <= 0.2, `${name}: night ${night.toFixed(3)} / day ${day.toFixed(3)}`);
    assert.ok(night / day >= 0.08, `${name}: night is dim, not black`);
  }
  // Under the night sky, cloud is brighter than land and land than sea: they stay apart.
  const night = (surface: Vector) => displayLuma(shade(surface, -0.4, violet));
  assert.ok(night(surfaces.cloud) > 1.8 * night(surfaces.land));
  assert.ok(night(surfaces.land) > 1.8 * night(surfaces.ocean));
  // The terminator reads as a line: brighter than deep night on either side of it, and day
  // turns to night within a few degrees of sun height.
  for (const surface of Object.values(surfaces)) {
    const at = (light: number) => displayLuma(shade(surface, light, violet));
    assert.ok(at(0) > at(-0.4) * 1.5);
    assert.ok(at(-0.12) < at(0.4) * 0.22, 'night 7° below the horizon');
  }
  assert.ok(SHADING.dawn - SHADING.dusk <= 0.15, 'the change spans under 9° of sun height');
  // Encoding round-trips, and the shader is built from the same numbers.
  for (const value of [0, 0.002, 0.2, 0.5, 1])
    close(srgbDecode(srgbEncode(value)), value, 1e-9, '');
  for (const number of [SHADING.ambient, SHADING.direct, ...SHADING.night, SHADING.twilight])
    assert.ok(SHADING_GLSL.includes(number.toFixed(4)), String(number));
});

/** A fetch that answers once with `respond`, and records what it was asked. */
function network(respond: (init: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(init);
    },
  };
}
const jpeg = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': 'image/jpeg', ...headers } });
const decoded = (width: number, height: number) => async () => ({ source: 'image', width, height });
const url = globeImageUrl(GLOBE_BASE_LAYER);

test('the image reader asks nothing while offline and reads only a whole-Earth image', async () => {
  const signal = new AbortController().signal;
  const offline = network(() => jpeg('x'));
  await assert.rejects(
    readGlobeImage(url, signal, {
      fetch: offline.fetch,
      online: () => false,
      decode: decoded(2048, 1024),
    }),
    /Imagery waits for a connection/,
  );
  assert.equal(offline.calls.length, 0, 'no request while offline');
  const good = network(() => jpeg(new Uint8Array(64)));
  const image = await readGlobeImage(url, signal, {
    fetch: good.fetch,
    online: () => true,
    decode: decoded(2048, 1024),
  });
  assert.deepEqual(image, { source: 'image', width: 2048, height: 1024 });
  assert.equal(good.calls[0].url, url);
  assert.equal(good.calls[0].init.mode, 'cors');
  assert.equal(good.calls[0].init.credentials, 'omit');
  const read = (respond: () => Response, decode = decoded(2048, 1024), maxBytes?: number) =>
    readGlobeImage(url, signal, {
      fetch: network(respond).fetch,
      online: () => true,
      decode,
      maxBytes,
    });
  await assert.rejects(
    read(() => new Response('busy', { status: 503 })),
    /unavailable \(503\)/,
  );
  await assert.rejects(
    read(() => new Response('<ServiceException/>', { headers: { 'content-type': 'text/xml' } })),
    /a message instead of an image/,
  );
  await assert.rejects(
    read(() => jpeg('x'), decoded(1024, 1024)),
    /an unexpected shape/,
  );
  await assert.rejects(
    read(() => jpeg('x'), decoded(0, 0)),
    /an unexpected shape/,
  );
  await assert.rejects(
    read(
      () => jpeg('x'),
      async () => Promise.reject(new TypeError('bad JPEG')),
    ),
    /could not be read/,
  );
  // Too large, whether the server says so or the body only turns out to be.
  await assert.rejects(
    read(() => jpeg('x', { 'content-length': '7000000' })),
    /exceeded the size limit/,
  );
  await assert.rejects(
    read(() => jpeg(new Uint8Array(2000)), decoded(2, 1), 1000),
    /size limit/,
  );
  const streamed = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(600));
    },
  });
  await assert.rejects(
    read(() => jpeg(streamed), decoded(2, 1), 1000),
    /size limit/,
  );
  await assert.rejects(
    read(() => {
      throw new TypeError('Failed to fetch');
    }),
    /could not be reached/,
  );
});

test('the image reader gives up after its timeout, and a cancelled request stays cancelled', async () => {
  const hang = (init: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      ),
    );
  await assert.rejects(
    readGlobeImage(url, new AbortController().signal, {
      fetch: network(hang).fetch,
      online: () => true,
      decode: decoded(2048, 1024),
      timeoutMs: 20,
    }),
    /timed out/,
  );
  const controller = new AbortController();
  const pending = readGlobeImage(url, controller.signal, {
    fetch: network(hang).fetch,
    online: () => true,
    decode: decoded(2048, 1024),
  });
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
});

const frame = (overrides: Partial<FrameState>): FrameState => ({
  running: true,
  moving: false,
  autoRotate: false,
  animate: true,
  idle: 0,
  turning: Infinity,
  ...overrides,
});

test('the globe draws only while something moves, and an idle globe settles and stops', () => {
  // Off screen, in a hidden tab, with a lost context or disposed: nothing is drawn.
  assert.equal(nextFrame(frame({ running: false, moving: true, autoRotate: true })), false);
  assert.equal(nextFrame(frame({ moving: true, animate: false })), true, 'a fly-to or a glide');
  assert.equal(nextFrame(frame({ autoRotate: true, turning: 30_000 })), true, 'turning by itself');
  // The pulse and twinkle run for a while after the last change, then the globe rests.
  assert.equal(nextFrame(frame({ idle: SETTLE_MS - 1 })), true);
  assert.equal(nextFrame(frame({ idle: SETTLE_MS })), false);
  assert.equal(cosmeticMotion(frame({ idle: SETTLE_MS })), false);
  assert.equal(cosmeticMotion(frame({ idle: SETTLE_MS, autoRotate: true, turning: 30_000 })), true);
  // Reduced motion or Pause: no pulse at all, and nothing is drawn until something changes.
  assert.equal(cosmeticMotion(frame({ animate: false })), false);
  assert.equal(nextFrame(frame({ animate: false })), false);
});

test('whether the globe can draw: on screen, in a shown tab, with its context, not stopped', () => {
  const can = { inView: true, pageVisible: true, lost: false, failed: false, disposed: false };
  assert.equal(drawing(can), true);
  assert.equal(drawing({ ...can, inView: false }), false, 'scrolled out of view');
  assert.equal(drawing({ ...can, pageVisible: false }), false, 'a hidden tab');
  assert.equal(drawing({ ...can, lost: true }), false, 'the context was taken away');
  assert.equal(drawing({ ...can, failed: true }), false, 'a frame failed: until Restart');
  assert.equal(drawing({ ...can, disposed: true }), false, 'the globe left');
});

test('the globe turns by itself for a minute after it starts, then glides back to the place', () => {
  const turning = (overrides: Partial<FrameState>) =>
    frame({ autoRotate: true, turning: 0, ...overrides });
  assert.equal(autoRotating(turning({ turning: AUTO_ROTATE_MS - 1 })), true);
  assert.equal(autoRotating(turning({ turning: AUTO_ROTATE_MS })), false);
  // A change (a new mosaic, the daily layer) restarts the pulse, not the turning.
  assert.equal(autoRotating(turning({ turning: AUTO_ROTATE_MS, idle: 0 })), false);
  assert.equal(autoRotating(turning({ turning: Infinity })), false, 'never started');
  // Its minute over, it glides back to the selected place, once, unless the user took the globe
  // in hand, paused it or a fly-to runs.
  assert.equal(returnsHome(true, turning({ turning: AUTO_ROTATE_MS })), true);
  assert.equal(returnsHome(false, turning({ turning: AUTO_ROTATE_MS + 16 })), false, 'once');
  assert.equal(returnsHome(true, turning({ turning: AUTO_ROTATE_MS - 1 })), false, 'still turning');
  assert.equal(returnsHome(true, turning({ autoRotate: false, turning: 9e9 })), false, 'in hand');
  assert.equal(returnsHome(true, turning({ animate: false, turning: 9e9 })), false, 'paused');
  // A globe left alone then stops drawing: no rotation, pulse or twinkle, 0 frames a second.
  assert.equal(nextFrame(turning({ turning: AUTO_ROTATE_MS, idle: AUTO_ROTATE_MS })), false);
  assert.equal(cosmeticMotion(turning({ turning: AUTO_ROTATE_MS, idle: SETTLE_MS })), false);
  // Never under reduced motion or Pause, and never once the user has taken the globe in hand.
  assert.equal(autoRotating(turning({ animate: false })), false);
  assert.equal(autoRotating(turning({ autoRotate: false })), false);
  assert.equal(nextFrame(turning({ animate: false, idle: 1000 })), false);
  // The glide takes long enough to follow (about 70° at 1.2° a second), and still settles soon.
  assert.ok(HOME_GLIDE_MS >= 1000 && HOME_GLIDE_MS <= 2500, `${HOME_GLIDE_MS} ms`);
});

test('turning by itself and the pulse are drawn 30 times a second; a drag or a glide, at every one', () => {
  assert.equal(Math.round(1000 / AMBIENT_FRAME_MS), 30);
  // At 60 Hz every other refresh is drawn, at 120 Hz every fourth, at 30 Hz every one.
  const drawn = (refresh: number, ambient = true) => {
    let at = 0;
    let last = -Infinity;
    let count = 0;
    for (let tick = 0; tick < refresh; tick++, at += 1000 / refresh)
      if (!skipsFrame(ambient, at - last)) {
        count++;
        last = at;
      }
    return count;
  };
  assert.equal(drawn(60), 30);
  assert.equal(drawn(120), 30);
  assert.equal(drawn(30), 30);
  assert.equal(drawn(144), 29, 'every fifth refresh at 144 Hz, never more than 30 a second');
  assert.equal(drawn(60, false), 60, 'a drag, a glide or a fade');
  assert.equal(skipsFrame(true, Infinity), false, 'the first frame after a rest');
  // After a frame it waits, then asks for a refresh. Whether the browser hands one out at the next
  // refresh, or at once stamped with the last unused one (Chrome), it gets the refresh a 30th of a
  // second after the last frame: one asked for each frame drawn. A second simulated at each rate.
  const simulate = (hz: number, prompt: boolean) => {
    const interval = 1000 / hz;
    let drawnAt = -Infinity;
    let used = -1;
    let asked = 0;
    let callbacks = 0;
    let draws = 0;
    while (asked < 1000) {
      const latest = Math.floor(asked / interval);
      const index = prompt && latest > used ? latest : Math.max(latest, used) + 1;
      const stamp = index * interval;
      const ran = Math.max(asked, stamp) + 0.5;
      used = index;
      callbacks++;
      if (!skipsFrame(true, stamp - drawnAt)) {
        draws++;
        drawnAt = stamp;
      }
      // After a frame drawn it waits; after a refresh too early to draw it asks again at once.
      asked = ran + (drawnAt === stamp ? ambientWait(ran - drawnAt) : 0);
    }
    return { callbacks, draws };
  };
  for (const prompt of [false, true])
    for (const hz of [60, 120, 144]) {
      const { callbacks, draws } = simulate(hz, prompt);
      const what = `${hz} Hz${prompt ? ', handed out at once' : ''}`;
      assert.ok(draws >= 28 && draws <= 31, `${what}: ${draws} frames drawn`);
      // Never more refreshes than the display has. Where the next one is handed out, one asked for
      // each frame drawn; at 144 Hz, or handed out at once, the refresh after the wait can come a
      // little early, and it asks again.
      assert.ok(callbacks <= hz + 1, `${what}: ${callbacks} refreshes in a second`);
      if (!prompt && hz !== 144)
        assert.ok(callbacks <= draws + 1, `${what}: ${callbacks} refreshes for ${draws} frames`);
    }
});

test('the daily layer fades with motion, at once without, and vanishes with its image', () => {
  assert.deepEqual(dailyLayer(0, { visible: true, image: true }), {
    target: DAILY_OPACITY,
    mix: 0,
  });
  assert.deepEqual(dailyLayer(0.5, { visible: false, image: true }), { target: 0, mix: 0.5 });
  // Without an image nothing of a mosaic may stay on screen, faded or not.
  assert.deepEqual(dailyLayer(DAILY_OPACITY, { visible: true, image: false }), {
    target: 0,
    mix: 0,
  });
  close(fadeDaily(0, DAILY_OPACITY, 0.25, true), 0.4, 1e-9, 'a quarter second of fade');
  assert.equal(fadeDaily(0.85, DAILY_OPACITY, 0.25, true), DAILY_OPACITY, 'never past the target');
  assert.equal(fadeDaily(0.4, 0, 0.1, true), 0.24);
  assert.equal(fadeDaily(0.1, 0, 0.25, true), 0);
  assert.equal(fadeDaily(0.2, DAILY_OPACITY, 0.01, false), DAILY_OPACITY, 'reduced motion');
});

test('Escape hides what focus shows over the globe, and a globe key hides the help', () => {
  assert.deepEqual(globeKey('Escape'), { kind: 'dismiss' });
  assert.deepEqual(globeKey('Esc'), { kind: 'dismiss' });
  // Focus shows the help and the crosshair; using a globe key leaves the crosshair, which marks
  // what Enter selects; Escape hides both until the globe is focused again (GlobeView).
  assert.equal(nextAssist('full', globeKey('ArrowLeft')), 'crosshair');
  assert.equal(nextAssist('full', globeKey('+')), 'crosshair');
  assert.equal(nextAssist('full', globeKey('Enter')), 'crosshair');
  assert.equal(nextAssist('crosshair', globeKey('Home')), 'crosshair');
  assert.equal(nextAssist('full', globeKey('Escape')), 'none');
  assert.equal(nextAssist('crosshair', globeKey('Escape')), 'none');
  assert.equal(nextAssist('none', globeKey('ArrowUp')), 'none');
  // Keys the globe leaves to the page change nothing.
  assert.equal(nextAssist('full', globeKey('Tab')), 'full');
});

test('the outlines are redrawn when a warning keeps its id but changes its area', () => {
  const now = Date.parse('2026-11-18T06:00:00Z');
  const square = alert({});
  const moved = alert({
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [80, 13],
          [81.5, 13],
          [81.5, 14],
          [80, 14],
          [80, 13],
        ],
      ],
    },
  });
  const key = (alerts: WeatherAlert[]) => outlinesKey(warningOutlines(alerts, undefined, 80, now));
  assert.equal(key([square]), key([alert({})]), 'the same outline, the same key');
  assert.notEqual(key([square]), key([moved]), 'same id, new area');
  assert.notEqual(key([square]), key([]));
  assert.notEqual(key([square]), key([square, alert({ id: 'urn:test:2' })]));
  assert.notEqual(
    key([square, alert({ id: 'urn:test:2' })]),
    key([alert({ id: 'urn:test:2' }), square]),
  );
});

test('Enter selects a point only after the user has turned the view to it', () => {
  const elsewhere = { latitude: 13.08, longitude: 50.27 };
  assert.equal(selectsCentre(true, elsewhere, place, 80), true, 'turned to another point');
  // Auto-rotation drifted the view 4.6° west, but the user chose nothing: Chennai stays.
  assert.equal(selectsCentre(false, { latitude: 13.08, longitude: 75.68 }, place, 80), false);
  // Turned away and back again: still Chennai.
  assert.equal(selectsCentre(true, { latitude: 13.0827, longitude: 80.2707 }, place, 80), false);
});

test('Enter keeps the named place while the view still looks at it', () => {
  assert.equal(isCentredOn({ latitude: 13.0827, longitude: 80.2707 }, place, 80), true);
  assert.equal(isCentredOn({ latitude: 13.1, longitude: 80.3 }, place, 80), true, 'within 0.1°');
  assert.equal(isCentredOn({ latitude: 23.08, longitude: 80.27 }, place, 80), false, 'one step');
  // Near a pole the view stops at 80°: that is as centred as it gets.
  assert.equal(
    isCentredOn({ latitude: 80, longitude: 15 }, { latitude: 88, longitude: 15 }, 80),
    true,
  );
  // Across 180°.
  assert.equal(
    isCentredOn({ latitude: -17, longitude: -179.99 }, { latitude: -17, longitude: 179.99 }, 80),
    true,
  );
  close(
    angularDistance({ latitude: 0, longitude: 179.5 }, { latitude: 0, longitude: -179.5 }),
    1,
    1e-9,
    '',
  );
});

test('the rotate buttons take their arrow key’s step, named by where the view goes', () => {
  const steps = ROTATE_BUTTONS.map(({ key, direction, label }) => {
    const action = globeKey(key);
    assert.equal(action?.kind, 'rotate', key);
    assert.match(label, new RegExp(`^Rotate globe ${direction}$`));
    return [direction, action];
  });
  assert.deepEqual(Object.fromEntries(steps), {
    west: { kind: 'rotate', latitude: 0, longitude: -10 },
    north: { kind: 'rotate', latitude: 10, longitude: 0 },
    south: { kind: 'rotate', latitude: -10, longitude: 0 },
    east: { kind: 'rotate', latitude: 0, longitude: 10 },
  });
});

/** A stand-in for what startGlobe needs, recording what was asked of it and in what order. */
function fakeStarter({ context = true, scene = true } = {}) {
  const calls: string[] = [];
  let arrive: (kit: string) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const made: { disposed: number }[] = [];
  const starter: GlobeStarter<string, string, { dispose(): void }> = {
    openContext: () => {
      calls.push('context');
      return context ? 'probe' : null;
    },
    loadThree: () => {
      calls.push('three');
      return new Promise((resolve, reject) => {
        arrive = resolve;
        fail = reject;
      });
    },
    create: (kit, probe) => {
      calls.push(`create ${kit} on ${probe}`);
      if (!scene) return null;
      const made1 = { disposed: 0 };
      made.push(made1);
      return { dispose: () => void made1.disposed++ };
    },
    release: (probe) => void calls.push(`release ${probe}`),
  };
  const reported: string[] = [];
  const on: GlobeStart<{ dispose(): void }> = {
    status: (status) => void reported.push(status),
    ready: () => void reported.push('ready'),
    failed: (error) => void reported.push(`failed: ${error.message}`),
  };
  return {
    starter,
    on,
    calls,
    reported,
    made,
    arrive: (kit = 'three') => arrive(kit),
    fail: (error: unknown) => fail(error),
  };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the globe asks for three.js only once WebGL 2 is there, and never without it', async () => {
  let fake = fakeStarter({ context: false });
  startGlobe(fake.starter, fake.on);
  await settled();
  assert.deepEqual(fake.calls, ['context'], 'no three.js download without WebGL 2');
  assert.deepEqual(fake.reported, ['unsupported']);
  // With WebGL 2: the context is opened first, then three.js is asked for.
  fake = fakeStarter();
  const stop = startGlobe(fake.starter, fake.on);
  assert.deepEqual(fake.calls, ['context', 'three']);
  assert.deepEqual(fake.reported, ['starting']);
  fake.arrive();
  await settled();
  assert.deepEqual(fake.calls, ['context', 'three', 'create three on probe']);
  assert.deepEqual(fake.reported, ['starting', 'ready']);
  // The globe leaves (a switch to Data saver): its scene is disposed once, and only once.
  stop();
  stop();
  assert.deepEqual(
    fake.made.map(({ disposed }) => disposed),
    [1],
  );
  assert.ok(!fake.calls.some((call) => call.startsWith('release')), 'the scene owns the context');
});

test('leaving while three.js loads gives the context back, and nothing is made after', async () => {
  const fake = fakeStarter();
  const stop = startGlobe(fake.starter, fake.on);
  stop();
  assert.deepEqual(fake.calls, ['context', 'three', 'release probe']);
  fake.arrive();
  await settled();
  assert.deepEqual(fake.calls, ['context', 'three', 'release probe'], 'no scene once stopped');
  assert.deepEqual(fake.reported, ['starting']);
  stop();
  assert.equal(fake.calls.filter((call) => call === 'release probe').length, 1);
});

test('three.js that cannot start a renderer, or does not arrive, is said, not left on Starting', async () => {
  // No renderer on this context: the context goes back and the card says WebGL 2 is unavailable.
  let fake = fakeStarter({ scene: false });
  let stop = startGlobe(fake.starter, fake.on);
  fake.arrive();
  await settled();
  assert.deepEqual(fake.calls.slice(-1), ['release probe']);
  assert.deepEqual(fake.reported, ['starting', 'unsupported']);
  stop();
  assert.equal(fake.calls.filter((call) => call === 'release probe').length, 1);
  // The three.js download fails: the error reaches App's notice for an optional tool.
  fake = fakeStarter();
  stop = startGlobe(fake.starter, fake.on);
  fake.fail(new Error('Failed to fetch dynamically imported module'));
  await settled();
  assert.deepEqual(fake.reported, [
    'starting',
    'failed: Failed to fetch dynamically imported module',
  ]);
  assert.deepEqual(fake.calls.slice(-1), ['release probe']);
  stop();
  assert.equal(fake.calls.filter((call) => call === 'release probe').length, 1);
  // Anything thrown is still an Error; one that arrives after the globe left is not reported.
  fake = fakeStarter();
  startGlobe(fake.starter, fake.on);
  fake.fail('offline');
  await settled();
  assert.deepEqual(fake.reported, ['starting', 'failed: The 3D globe could not load.']);
  fake = fakeStarter();
  stop = startGlobe(fake.starter, fake.on);
  stop();
  fake.fail(new Error('late'));
  await settled();
  assert.deepEqual(fake.reported, ['starting']);
});

test('Try again asks NASA only for the layer that failed, or whose last look failed', () => {
  const ready: DailyImagery = {
    state: 'ready',
    date: '2026-11-17',
    coverage: 0.93,
    mask: null,
    skipped: null,
    refreshError: null,
  };
  const failed = { state: 'failed', message: 'NASA imagery is unavailable (503).' } as const;
  assert.deepEqual(retryLayers(failed, ready), { base: true, daily: false });
  assert.deepEqual(retryLayers({ state: 'ready' }, failed), { base: false, daily: true });
  assert.deepEqual(retryLayers(failed, failed), { base: true, daily: true });
  assert.deepEqual(retryLayers({ state: 'ready' }, { ...ready, refreshError: 'timed out' }), {
    base: false,
    daily: true,
  });
  assert.deepEqual(retryLayers({ state: 'loading' }, { state: 'loading' }), {
    base: false,
    daily: false,
  });
  assert.deepEqual(retryLayers({ state: 'ready' }, ready), { base: false, daily: false });
});

test('the scene draws a mosaic only while the card dates it, and the base only once loaded', () => {
  const kept = { date: '2026-11-17', source: 'image of 17 Nov' };
  const ready: DailyImagery = {
    state: 'ready',
    date: '2026-11-17',
    coverage: 0.93,
    mask: null,
    skipped: null,
    refreshError: null,
  };
  assert.equal(sceneDaily(ready, kept), 'image of 17 Nov');
  // A failed look keeps the mosaic on show with its date (nextDaily), so it is still drawn.
  assert.equal(sceneDaily({ ...ready, refreshError: 'timed out' }, kept), 'image of 17 Nov');
  // The state left 'ready', or dates another day: no clouds the card does not date.
  assert.equal(sceneDaily({ state: 'loading' }, kept), null);
  assert.equal(sceneDaily({ state: 'failed', message: 'x' }, kept), null);
  assert.equal(sceneDaily({ ...ready, date: '2026-11-18' }, kept), null);
  assert.equal(sceneDaily(ready, null), null);
  assert.equal(sceneBase({ state: 'ready' }, 'blue marble'), 'blue marble');
  assert.equal(sceneBase({ state: 'loading' }, 'blue marble'), null);
  assert.equal(sceneBase({ state: 'failed', message: 'x' }, 'blue marble'), null);
});

test('the minute timer looks for a newer mosaic only when one is due, shown and online', () => {
  const partial: DailyImagery = {
    state: 'ready',
    date: '2026-11-17',
    coverage: 0.6,
    mask: null,
    skipped: null,
    refreshError: null,
  };
  const checkedAt = Date.parse('2026-11-18T09:00:00Z');
  const look = (overrides: Partial<Parameters<typeof shouldLook>[0]>) =>
    shouldLook({
      hidden: false,
      online: true,
      daily: partial,
      checkedAt,
      now: checkedAt + RECHECK_MS,
      ...overrides,
    });
  assert.equal(LOOK_TIMER_MS, 60_000);
  assert.equal(look({}), true, 'an hour after the last look at a partial mosaic');
  // The timer runs every minute, but a look is hourly: 59 minutes in, nothing is asked.
  for (let minute = 1; minute < 60; minute++)
    assert.equal(look({ now: checkedAt + minute * 60_000 }), false, `minute ${minute}`);
  assert.equal(look({ hidden: true }), false, 'a hidden page');
  assert.equal(look({ online: false }), false, 'offline');
  assert.equal(
    look({ daily: { ...partial, coverage: 0.95 } }),
    false,
    'complete: nothing to look for',
  );
  assert.equal(look({ daily: { state: 'loading' } }), false, 'while the first load runs');
});

test('Escape is left to the page once the help is hidden, and so are keys with modifiers', () => {
  assert.deepEqual(globeKeyAction('Escape', {}, 'full'), { kind: 'dismiss' });
  assert.deepEqual(globeKeyAction('Escape', {}, 'crosshair'), { kind: 'dismiss' });
  // Nothing left to hide: Escape is not taken from the page (it may close a dialog there).
  assert.equal(globeKeyAction('Escape', {}, 'none'), null);
  assert.equal(globeKeyAction('Esc', {}, 'none'), null);
  // Other keys still work once the help is hidden.
  assert.deepEqual(globeKeyAction('ArrowLeft', {}, 'none'), {
    kind: 'rotate',
    latitude: 0,
    longitude: -10,
  });
  assert.deepEqual(globeKeyAction('ArrowUp', { shiftKey: true }, 'full'), {
    kind: 'rotate',
    latitude: 30,
    longitude: 0,
  });
  for (const held of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }])
    assert.equal(globeKeyAction('ArrowLeft', held, 'full'), null, JSON.stringify(held));
  assert.equal(globeKeyAction('Tab', {}, 'full'), null);
  assert.equal(globeKeyAction('a', {}, 'full'), null);
});

test('focus in the card moves to Restart when the globe stops, and back once it draws', () => {
  // A lost context or a failed frame takes the controls away: focus goes to Restart.
  assert.equal(focusAfterStatus(true, 'lost', null), 'restart');
  assert.equal(focusAfterStatus(true, 'failed', null), 'restart');
  assert.equal(focusNow('restart', 'lost'), 'restart');
  assert.equal(focusNow('restart', 'failed'), 'restart');
  // The context comes back: focus returns to the globe once it is drawing.
  assert.equal(focusAfterStatus(true, 'ready', 'restart'), 'surface');
  assert.equal(focusNow('surface', 'ready'), 'surface');
  // Restart parks focus on the globe while it starts: it moves once the globe is ready.
  assert.equal(focusNow('surface', 'starting'), null);
  assert.equal(focusNow('restart', 'starting'), null);
  assert.equal(focusNow('restart', 'ready'), null, 'Restart is gone');
  // Focus elsewhere on the page is left alone, and a pending move is kept.
  assert.equal(focusAfterStatus(false, 'lost', null), null);
  assert.equal(focusAfterStatus(false, 'ready', 'surface'), 'surface');
  assert.equal(focusNow(null, 'lost'), null);
});

test('an imagery request reports its result unless it was cancelled first', async () => {
  const reports: string[] = [];
  const report = {
    loaded: (value: string) => void reports.push(`loaded ${value}`),
    failed: (message: string) => void reports.push(`failed ${message}`),
  };
  requestImagery(async () => 'image', report, 'fallback');
  requestImagery(
    async () => {
      throw new Error('NASA imagery timed out.');
    },
    report,
    'fallback',
  );
  requestImagery(
    async () => {
      throw new Error('');
    },
    report,
    'The base image did not load.',
  );
  requestImagery(
    () => {
      throw new Error('Invalid imagery layer.');
    },
    report,
    'fallback',
  );
  await settled();
  assert.deepEqual(reports, [
    'loaded image',
    'failed NASA imagery timed out.',
    'failed The base image did not load.',
    'failed Invalid imagery layer.',
  ]);
  // Cancelled (the globe left, or Try again replaced it): nothing is reported, and the request
  // sees its signal aborted.
  reports.length = 0;
  let seen: AbortSignal | null = null;
  const cancel = requestImagery(
    (signal) => {
      seen = signal;
      return new Promise((resolve) => setTimeout(() => resolve('late'), 1));
    },
    report,
    'fallback',
  );
  cancel();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(reports, []);
  assert.equal((seen as AbortSignal | null)?.aborted, true);
});

test('the sun is placed over the subsolar point', () => {
  for (const time of [
    Date.parse('2026-03-20T14:46:00Z'),
    Date.parse('2026-06-21T08:24:00Z'),
    Date.parse('2026-11-19T07:30:00Z'),
  ]) {
    const { latitude, longitude } = subsolarPoint(time);
    closeVector(
      sunDirection(time),
      latLonToVector(latitude, longitude),
      new Date(time).toISOString(),
    );
    close(Math.hypot(...sunDirection(time)), 1, 1e-12, 'a unit vector');
  }
});

test('a globe releases everything it holds once, and later additions at once', () => {
  const life = createLifecycle();
  const order: string[] = [];
  const item = (name: string) => ({ dispose: () => order.push(name) });
  const target = new EventTarget();
  let heard = 0;
  life.defer(() => order.push('renderer'));
  life.keep(item('texture'));
  const geometry = life.keep(item('geometry'));
  life.listen(target, 'resize', () => heard++);
  life.defer(() => order.push('timer'));
  target.dispatchEvent(new Event('resize'));
  life.drop(geometry);
  assert.deepEqual(order, ['geometry']);
  life.dispose();
  life.dispose();
  // Kept things first, then the undos newest first: the renderer goes last.
  assert.deepEqual(order, ['geometry', 'texture', 'timer', 'renderer']);
  target.dispatchEvent(new Event('resize'));
  assert.equal(heard, 1, 'the listener is gone');
  assert.equal(life.disposed, true);
  life.keep(item('late'));
  life.defer(() => order.push('late undo'));
  assert.deepEqual(order.slice(-2), ['late', 'late undo']);
});

test('decoded images stay while a globe is open and a minute after, then are closed', () => {
  // A hand-wound clock: each set() returns a number; run() fires the latest timer.
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers = {
    set: (run: () => void) => {
      pending.set(++next, run);
      return next as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (timer: ReturnType<typeof setTimeout>) =>
      void pending.delete(timer as unknown as number),
  };
  const fire = () => {
    for (const [timer, run] of [...pending]) {
      pending.delete(timer);
      run();
    }
  };
  const closed: string[] = [];
  const cache = createImageCache<string>({ close: (image) => closed.push(image), timers });
  // React's strict mode mounts, unmounts and mounts again: nothing is released in between.
  cache.hold();
  cache.release();
  cache.hold();
  cache.set('base', 'base image');
  cache.set('daily', 'daily image');
  fire();
  assert.equal(cache.get('base'), 'base image');
  assert.deepEqual(closed, []);
  // The globe closes (Data saver, say) and opens again within the minute: everything is kept.
  cache.release();
  assert.equal(pending.size, 1, 'a release is scheduled');
  cache.hold();
  assert.equal(pending.size, 0, 'and cancelled by the next globe');
  fire();
  assert.equal(cache.size, 2);
  // Two globes open; only the last one to close schedules the release.
  cache.hold();
  cache.release();
  assert.equal(pending.size, 0);
  cache.release();
  fire();
  assert.deepEqual(closed.sort(), ['base image', 'daily image']);
  assert.equal(cache.size, 0);
  assert.equal(cache.get('base'), undefined);
  // At most three are kept; an older one is forgotten, not closed, since a globe may show it.
  for (const name of ['a', 'b', 'c', 'd']) cache.set(name, `${name} image`);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 3);
  assert.equal(closed.length, 2);
  cache.forget('d');
  assert.equal(cache.get('d'), undefined);
});

test('the image cache calls the real timers as a browser requires', (t) => {
  // Browsers refuse window.clearTimeout called as a method of another object ("Illegal
  // invocation"); Node does not, so this stands in for the browser's check.
  const real = globalThis.clearTimeout;
  const strict = function (this: unknown, timer?: ReturnType<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    real(timer);
  };
  globalThis.clearTimeout = strict as typeof clearTimeout;
  t.after(() => {
    globalThis.clearTimeout = real;
  });
  const closed: string[] = [];
  const cache = createImageCache<string>({ close: (image) => closed.push(image) });
  cache.set('base', 'base image');
  cache.hold();
  cache.release();
  // Open again within the minute: the pending release is cleared, without throwing.
  assert.doesNotThrow(() => cache.hold());
  cache.release();
  assert.doesNotThrow(() => cache.hold());
  assert.equal(cache.get('base'), 'base image');
  assert.deepEqual(closed, []);
  cache.release();
  cache.hold();
});

test('markers are redrawn when a place keeps its position but changes its name', () => {
  const chennai = {
    id: 'chennai',
    name: 'Chennai',
    country: 'India',
    countryCode: 'IN',
    latitude: 13.0827,
    longitude: 80.2707,
  };
  const point = pointPlace(13.0827, 80.2707);
  const tokyo = { ...chennai, id: 'tokyo', name: 'Tokyo', latitude: 35.6895, longitude: 139.6917 };
  const key = markersKey([tokyo], chennai);
  assert.equal(markersKey([tokyo], { ...chennai }), key, 'the same places, the same key');
  // The map point at Chennai's coordinates is another place: clicking its marker selects it.
  assert.notEqual(markersKey([tokyo], point), key);
  assert.notEqual(markersKey([{ ...tokyo, name: 'Tōkyō' }], chennai), key);
  assert.notEqual(markersKey([{ ...tokyo, latitude: 35.7 }], chennai), key);
  assert.notEqual(markersKey([], chennai), key);
});

test('the hatch on unimaged areas keeps about the same spacing on screen', () => {
  close(hatchDegrees(200), 14 / ((200 * Math.PI) / 180), 1e-9, 'resting globe');
  assert.equal(hatchDegrees(2000), 2);
  assert.equal(hatchDegrees(20), 9);
  assert.equal(hatchDegrees(0), 4);
});

test('a missing imagery layer is named as missing, never shown as weather', () => {
  const failed = (message: string) => ({ state: 'failed', message }) as const;
  const ready: BaseImagery = { state: 'ready' };
  assert.equal(imageryNotice(ready, imaged), null);
  assert.equal(imageryNotice({ state: 'loading' }, { state: 'loading' }), null);
  const both =
    imageryNotice(failed('NASA imagery is unavailable (503).'), failed('Timed out.')) ?? '';
  assert.match(both, /^NASA imagery did not load: NASA imagery is unavailable \(503\)\./);
  assert.match(both, /plain sphere; that is missing imagery, not a view of the weather/);
  assert.doesNotMatch(both, /base image only|Blue Marble base, which/);
  assert.match(
    imageryNotice(failed('Offline.'), imaged) ?? '',
    /Outside the daily mosaic the globe is a plain/,
  );
  assert.match(
    imageryNotice(ready, failed('NASA has not listed a recent daily mosaic.')) ?? '',
    /^The daily satellite mosaic did not load: .*static Blue Marble base, which has no clouds/,
  );
});

const alert = (overrides: Partial<WeatherAlert>): WeatherAlert => ({
  id: 'urn:test:1',
  title: 'Flood Warning',
  event: 'Flood Warning',
  severity: 'Severe',
  area: 'Testland coast',
  description: '',
  instruction: '',
  sent: Date.parse('2026-11-18T00:00:00Z'),
  effective: Date.parse('2026-11-18T00:00:00Z'),
  expires: Date.parse('2026-11-18T12:00:00Z'),
  source: 'Test authority',
  url: 'https://example.invalid/warning',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [80, 13],
        [81, 13],
        [81, 14],
        [80, 14],
        [80, 13],
      ],
    ],
  },
  ...overrides,
});

test('only unexpired warnings with an outline are drawn, judged on the warning source clock', () => {
  const expires = Date.parse('2026-11-18T12:00:00Z');
  const ids = (alerts: WeatherAlert[], offset: number | undefined, now: number) =>
    warningOutlines(alerts, offset, 80, now).map(({ alert }) => alert.id);
  const shown = alert({ expires });
  // Five minutes before expiry on the device clock, but the device runs ten minutes fast: the
  // source's clock is five minutes before expiry too, so the warning is drawn.
  assert.deepEqual(ids([shown], 10 * 60_000, expires + 5 * 60_000), [shown.id]);
  // The device clock runs slow: the warning has expired on the source's clock.
  assert.deepEqual(ids([shown], -10 * 60_000, expires - 5 * 60_000), []);
  assert.deepEqual(ids([shown], undefined, expires), []);
  const others = [
    alert({ id: 'no-geometry', geometry: undefined }),
    alert({ id: 'malformed', geometry: { type: 'Polygon', coordinates: [[[500, 13]]] } }),
    alert({ id: 'kept', expires: expires + 60_000 }),
  ];
  assert.deepEqual(ids(others, undefined, expires), ['kept']);
  // A provider polygon that throws as it is read is left out; the other outlines are drawn.
  const throwing = alert({
    id: 'throws',
    expires: expires + 60_000,
    geometry: {
      get type(): string {
        throw new Error('A malformed provider polygon.');
      },
    } as unknown as WeatherAlert['geometry'],
  });
  assert.deepEqual(ids([throwing, ...others], undefined, expires), ['kept']);
  assert.deepEqual(ids([others[2], throwing], undefined, expires), ['kept']);
});

test('an outline across 180° stays at 180° on the globe, and the gateway cut is not drawn', () => {
  const longitudes = (segments: Float32Array) => {
    const found: number[] = [];
    for (let at = 0; at < segments.length; at += 3)
      found.push(vectorToLatLon([segments[at], segments[at + 1], segments[at + 2]]).longitude);
    return found;
  };
  const crossing = alert({
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [178.5, -18],
          [-178.5, -18],
          [-178.5, -15],
          [178.5, -15],
          [178.5, -18],
        ],
      ],
    },
  });
  // Seen beside a place on either side of the meridian, every point is within 1.5° of it.
  for (const near of [179, -179]) {
    const [{ outline }] = warningOutlines([crossing], undefined, near, 0);
    const segments = outlineSegments(outline, 1, 1);
    assert.equal(segments.length % 6, 0, 'pairs of points');
    // Four 3°-or-shorter edges in steps of at most 1°: 3 + 3 + 3 + 3 segments.
    assert.equal(segments.length / 6, 12);
    for (const longitude of longitudes(segments))
      assert.ok(Math.abs(normalizeLongitude(longitude - 180)) <= 1.5 + 1e-6, `${longitude}`);
  }
  // The gateway sends the same area cut along 180° into two parts. Their shared edge is not a
  // warning boundary, so no segment runs along the meridian.
  const cut = alert({
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [178.5, -18],
            [180, -18],
            [180, -15],
            [178.5, -15],
            [178.5, -18],
          ],
        ],
        [
          [
            [-180, -18],
            [-178.5, -18],
            [-178.5, -15],
            [-180, -15],
            [-180, -18],
          ],
        ],
      ],
    },
  });
  const [{ outline }] = warningOutlines([cut], undefined, 179, 0);
  const segments = outlineSegments(outline, 1.003, 1);
  for (let at = 0; at < segments.length; at += 6) {
    const ends = [
      vectorToLatLon([segments[at], segments[at + 1], segments[at + 2]]),
      vectorToLatLon([segments[at + 3], segments[at + 4], segments[at + 5]]),
    ];
    assert.ok(
      !ends.every(({ longitude }) => Math.abs(Math.abs(longitude) - 180) < 1e-4),
      'a segment along 180°',
    );
    for (const { longitude } of ends)
      assert.ok(Math.abs(normalizeLongitude(longitude - 180)) <= 1.5 + 1e-4, `${longitude}`);
  }
  // Each part keeps its three real edges: 1.5° in two steps, 3° in three, 1.5° in two.
  assert.equal(segments.length / 6, 2 * (2 + 3 + 2));
  // Points lie on the requested radius, just above the surface.
  close(Math.hypot(segments[0], segments[1], segments[2]), 1.003, 1e-6, 'radius');
});

test('a click on the globe selects the same place as a click on the map', () => {
  assert.deepEqual(pointPlace(13.08271234, 80.27069876), {
    id: 'map:13.0827:80.2707',
    name: '13.08°N, 80.27°E',
    latitude: 13.0827,
    longitude: 80.2707,
    country: 'Selected map point',
    countryCode: '',
  });
  // Longitudes are normalised as the map's are, and southern/western points named as such.
  assert.deepEqual(pointPlace(-33.86787, 211.2093), {
    id: 'map:-33.8679:-148.7907',
    name: '33.87°S, 148.79°W',
    latitude: -33.8679,
    longitude: -148.7907,
    country: 'Selected map point',
    countryCode: '',
  });
  assert.equal(coordinateLabel(-0.004, -0.004), '0.00°S, 0.00°W');
});

test('keys rotate, zoom, select and reset the view within its limits', () => {
  assert.deepEqual(globeKey('ArrowRight'), { kind: 'rotate', latitude: 0, longitude: 10 });
  assert.deepEqual(globeKey('ArrowLeft', true), { kind: 'rotate', latitude: 0, longitude: -30 });
  assert.deepEqual(globeKey('ArrowUp'), { kind: 'rotate', latitude: 10, longitude: 0 });
  assert.deepEqual(globeKey('ArrowDown'), { kind: 'rotate', latitude: -10, longitude: 0 });
  for (const key of ['+', '=', 'Add']) assert.equal(globeKey(key)?.kind, 'zoom', key);
  assert.ok((globeKey('+') as { factor: number }).factor < 1, 'plus moves closer');
  assert.ok((globeKey('-') as { factor: number }).factor > 1, 'minus moves away');
  assert.deepEqual(globeKey('Enter'), { kind: 'select' });
  assert.deepEqual(globeKey('Home'), { kind: 'reset' });
  for (const key of ['Tab', ' ', 'a', 'PageDown']) assert.equal(globeKey(key), null, key);
  const limits = { maxLatitude: 80, minDistance: 1.3, maxDistance: 8 };
  const view = { latitude: 75, longitude: 175, distance: 4 };
  assert.deepEqual(stepView(view, { kind: 'rotate', latitude: 10, longitude: 10 }, limits), {
    latitude: 80,
    longitude: -175,
    distance: 4,
  });
  assert.equal(stepView(view, { kind: 'zoom', factor: 0.1 }, limits).distance, 1.3);
  assert.equal(stepView(view, { kind: 'zoom', factor: 10 }, limits).distance, 8);
});

test('a short press is a selection; a drag, a long hold or a moved finger is not', () => {
  const down = { x: 100, y: 100, time: 0 };
  assert.equal(isTap(down, { x: 103, y: 104, time: 150 }, 'mouse'), true);
  assert.equal(isTap(down, { x: 106, y: 100, time: 150 }, 'mouse'), false);
  assert.equal(isTap(down, { x: 108, y: 106, time: 150 }, 'touch'), true);
  assert.equal(isTap(down, { x: 100, y: 120, time: 150 }, 'touch'), false);
  assert.equal(isTap(down, { x: 100, y: 100, time: 900 }, 'mouse'), false);
});

test('a ray from the camera finds the near side of the globe, or misses it', () => {
  closeVector(raySphere([0, 0, 5], [0, 0, -2]) as Vector, [0, 0, 1], 'straight on');
  assert.equal(raySphere([0, 0, 5], [0, 1, -1]), null);
  assert.equal(raySphere([0, 0, 5], [0, 0, 1]), null, 'pointing away');
  const grazing = raySphere([0, 0.6, 5], [0, 0, -1]) as Vector;
  close(Math.hypot(...grazing), 1, 1e-12, 'on the surface');
  assert.ok(grazing[2] > 0, 'the near side');
});

test('the globe fits the shorter side of a wide or tall view', () => {
  for (const aspect of [0.6, 1, 2.4]) {
    const distance = fitDistance(aspect, 30, 0.8);
    const vertical = (15 * Math.PI) / 180;
    const limit = Math.min(Math.tan(vertical), Math.tan(vertical) * aspect);
    // The silhouette's half-width on the image plane, as a share of the shorter half-side.
    close(Math.tan(Math.asin(1 / distance)) / limit, 0.8, 1e-9, `aspect ${aspect}`);
  }
});

test('a click near a visible marker selects its place; hidden markers never', () => {
  const markers = [
    { x: 10, y: 10, visible: true },
    { x: 20, y: 10, visible: true },
    { x: 15, y: 10, visible: false },
  ];
  assert.equal(nearestMarker(markers, 16, 10), 1);
  assert.equal(nearestMarker(markers, 12, 11), 0);
  assert.equal(nearestMarker(markers, 60, 60), -1);
  assert.equal(nearestMarker([markers[2]], 15, 10), -1);
});

test('design tokens are read as colours, with the fallback for anything else', () => {
  assert.deepEqual(hexColor(' #3EE6C1 ', '#000000'), [62 / 255, 230 / 255, 193 / 255]);
  assert.deepEqual(hexColor('#fff', '#000000'), [1, 1, 1]);
  assert.deepEqual(hexColor('', '#8B7CFF'), [139 / 255, 124 / 255, 1]);
  assert.deepEqual(hexColor('var(--x)', '#8B7CFF'), [139 / 255, 124 / 255, 1]);
});

test('the starfield is the same sky every time, on its sphere, mostly white', () => {
  const one = starfield(500, 7, 60);
  const two = starfield(500, 7, 60);
  assert.deepEqual(one, two);
  assert.notDeepEqual(starfield(500, 8, 60).positions, one.positions);
  for (let index = 0; index < 500; index++) {
    const [x, y, z] = one.positions.subarray(index * 3, index * 3 + 3);
    close(Math.hypot(x, y, z), 60, 1e-3, 'radius');
    assert.ok(one.sizes[index] >= 0.9 && one.sizes[index] <= 3.3);
  }
  const white = one.tints.filter((tint) => tint === 0).length;
  assert.ok(white > 300 && white < 480, `${white} white stars`);
  // Not every star lies in one direction.
  assert.ok(angle([one.positions[0], one.positions[1], one.positions[2]], [0, 1, 0]) > 0);
});
