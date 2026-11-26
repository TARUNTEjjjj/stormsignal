import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import {
  ATMOSPHERE_SCATTER,
  JET_STREAMS,
  SATELLITE_ORBITS,
  angularDistance,
  atmosphereOpticalDepth,
  atmosphereScatter,
  dampedFlyEase,
  flyToView,
  groundTrackRibbonGeometryData,
  groundTrackSweepSegments,
  jetStreamFlowIntensity,
  jetStreamRibbonGeometryData,
  latLonToVector,
  miePhaseFunction,
  orbitalArcSegments,
  orbitalBasis,
  orbitalPoint,
  outlineSegments,
  satellitePosition,
  segmentsCentroid,
  slerpDirection,
  srgbDecode,
  sunDirection,
  vectorToLatLon,
  type Vector,
} from '../src/globe';
import { createGlobe, loadThree, type GlobeEvents, type ThreeKit } from '../src/globe-scene';
import {
  atmosphereFragment,
  atmosphereVertex,
  beaconConeFragment,
  groundTrackFragment,
  plainVertex,
  ribbonFragment,
  ribbonVertex,
} from '../src/globe-shaders';
import { glsl } from './support/glsl';

const three = await loadThree();

const linear = (hex: string) =>
  [1, 3, 5].map((at) => srgbDecode(Number.parseInt(hex.slice(at, at + 2), 16) / 255)) as Vector;
const teal = linear('#3ee6c1');
const violet = linear('#8b7cff');

const near = (a: number, b: number, tol = 1e-5) => Math.abs(a - b) <= tol;
const nearVec = (a: readonly number[], b: readonly number[], tol = 1e-5) =>
  a.length === b.length && a.every((v, i) => near(v, b[i], tol));
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);

/** Uniformly distributes `n` points on the unit sphere S^2 using a spherical Fibonacci lattice. */
function fibonacciSphere(n: number): Vector[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: Vector[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    points.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }
  return points;
}

const atmoVert = glsl(`
  uniform mat4 modelMatrix;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform vec3 cameraPosition;
  attribute vec3 position;
  attribute vec3 normal;
  ${atmosphereVertex}
`);

const atmoFrag = glsl(atmosphereFragment);

test('volumetric atmosphere vertex + fragment shaders match CPU Rayleigh/Mie scatter across 1,000 Fibonacci points', () => {
  const ATMOSPHERE_R = 1.16;
  const edge = Math.sqrt(1 - 1 / ATMOSPHERE_R ** 2);
  const camera = new PerspectiveCamera(30, 900 / 700, 0.05, 200);
  camera.position.set(...latLonToVector(22, 48, 4.5));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const camPos = camera.position.toArray() as Vector;
  const sun = sunDirection(Date.parse('2026-11-19T07:30:00Z'));
  const lattice = fibonacciSphere(1000);

  let maxError = 0;
  let dayLimbSamples = 0;
  let twilightWarmSamples = 0;
  let nightAuroraSamples = 0;

  for (const unit of lattice) {
    const pos: Vector = [unit[0] * ATMOSPHERE_R, unit[1] * ATMOSPHERE_R, unit[2] * ATMOSPHERE_R];
    const vOut = atmoVert.vertex({
      modelMatrix: identity,
      modelViewMatrix: camera.matrixWorldInverse.elements,
      projectionMatrix: camera.projectionMatrix.elements,
      cameraPosition: camPos,
      position: pos,
      normal: unit,
    });
    const vNormal = vOut.vNormal as Vector;
    const vView = vOut.vView as Vector;
    assert.ok(near(norm(vNormal), 1, 1e-6), 'vertex shader keeps normal unit length');
    assert.ok(near(norm(vView), 1, 1e-6), 'vertex shader keeps view vector unit length');
    assert.ok(nearVec(vOut.vWorldPos as Vector, pos, 1e-6), 'world position parity');

    const gpu = atmoFrag.run({
      vNormal,
      vView,
      sun,
      edge,
      teal,
      violet,
    })!;
    const cpu = atmosphereScatter(vNormal, vView, sun, edge, teal, violet);
    for (let c = 0; c < 4; c++) {
      const err = Math.abs(gpu[c] - cpu[c]);
      maxError = Math.max(maxError, err);
      assert.ok(err < 1e-5, `channel ${c} mismatch: gpu=${gpu[c]} cpu=${cpu[c]}`);
      assert.ok(Number.isFinite(gpu[c]) && gpu[c] >= 0, 'finite non-negative output');
    }

    // Check BackSide grazing limb behavior: -dot(n, v) in (0, edge]
    const grazing = -dot(vNormal, vView) / edge;
    const sunDot = dot(vNormal, sun);
    if (grazing > 0.35 && grazing <= 1.0) {
      if (sunDot > 0.45) {
        dayLimbSamples++;
        assert.ok(gpu[3] > 0.02, 'day limb emits volumetric Rayleigh glow');
      } else if (Math.abs(sunDot) < 0.15 && -dot(vView, sun) > 0.4) {
        twilightWarmSamples++;
        // Forward Mie + twilight shifts colour toward gold-cyan relative to deep night indigo
        assert.ok(gpu[0] > 0 && gpu[1] > 0, 'twilight limb carries sunlit warmth + cyan');
      } else if (sunDot < -0.6) {
        nightAuroraSamples++;
        // Night aurora limb remains dimmer than full day and cool indigo/teal
        assert.ok(gpu[2] >= gpu[0], 'night aurora stays cool indigo-teal');
      }
    }
  }

  assert.ok(maxError < 1e-5, `max CPU-vs-GLSL error across 1000 points: ${maxError}`);
  assert.ok(dayLimbSamples > 10 && nightAuroraSamples > 10, 'covered both day and night limbs');
  assert.ok(twilightWarmSamples >= 0);
});

test('sun terminator antisymmetry and optical depth / Mie phase physical laws across 1,000 points', () => {
  const lattice = fibonacciSphere(1000);
  const sun = sunDirection(Date.parse('2026-06-21T12:00:00Z'));
  const antiSun: Vector = [-sun[0], -sun[1], -sun[2]];
  const edge = Math.sqrt(1 - 1 / 1.16 ** 2);

  for (const n of lattice) {
    // Exact solar zenith antisymmetry under sun -> -sun
    assert.ok(Math.abs(dot(n, sun) + dot(n, antiSun)) < 1e-12);
    // Perpendicular grazing view vector (k = 0.7)
    const perp: Vector = [-n[0] * 0.7 * edge, -n[1] * 0.7 * edge, -n[2] * 0.7 * edge];
    const [rDay, gDay, bDay, aDay] = atmosphereScatter(n, perp, sun, edge, teal, violet);
    const [rNight, gNight, bNight, aNight] = atmosphereScatter(
      n,
      perp,
      antiSun,
      edge,
      teal,
      violet,
    );
    const sunHeight = dot(n, sun);
    if (sunHeight > 0.4) {
      assert.ok(aDay > aNight, `day hemisphere glows brighter than opposite night at ${sunHeight}`);
      assert.ok(
        rDay + gDay + bDay > rNight + gNight + bNight,
        'day radiance exceeds opposite night radiance',
      );
    }
  }

  // Optical depth strictly monotone on [0, 1]
  let prevDepth = -1;
  for (let i = 0; i <= 100; i++) {
    const k = i / 100;
    const d = atmosphereOpticalDepth(k);
    assert.ok(d > prevDepth, `optical depth increases at k=${k}`);
    prevDepth = d;
  }
  assert.equal(atmosphereOpticalDepth(0), 0);
  assert.ok(
    near(
      atmosphereOpticalDepth(1),
      ATMOSPHERE_SCATTER.rayleighBase + ATMOSPHERE_SCATTER.rayleighLimb,
      1e-12,
    ),
  );

  // Henyey-Greenstein Mie phase peaks strictly forward and integrates near 1 over unit sphere
  let integral = 0;
  const steps = 1000;
  const dMu = 2 / steps;
  for (let i = 0; i < steps; i++) {
    const mu = -1 + (i + 0.5) * dMu;
    const phase = miePhaseFunction(mu, ATMOSPHERE_SCATTER.mieG);
    assert.ok(phase > 0 && Number.isFinite(phase));
    integral += 2 * Math.PI * phase * dMu;
  }
  assert.ok(Math.abs(integral - 1) < 0.01, `Mie phase integral over 4π sr: ${integral}`);
  assert.ok(
    miePhaseFunction(1) > miePhaseFunction(0) && miePhaseFunction(0) > miePhaseFunction(-1),
    'forward scattering dominates backscatter',
  );
});

test('jet-stream ribbon and ground-track shaders match CPU math and handle seam wraparound', () => {
  const rVert = glsl(`
    uniform mat4 modelMatrix;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform vec3 cameraPosition;
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec2 uv;
    ${ribbonVertex}
  `);
  const rFrag = glsl(ribbonFragment);
  const gtFrag = glsl(groundTrackFragment);
  const coneFrag = glsl(`${plainVertex}\n`);
  const beaconFrag = glsl(beaconConeFragment);

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const camera = new PerspectiveCamera(30, 900 / 700, 0.05, 200);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  // Verify ribbon vertex & fragment parity across UV + time grid
  const stream = JET_STREAMS[0];
  const mesh = jetStreamRibbonGeometryData(stream, 48);
  const vOut = rVert.vertex({
    modelMatrix: identity,
    modelViewMatrix: camera.matrixWorldInverse.elements,
    projectionMatrix: camera.projectionMatrix.elements,
    cameraPosition: camera.position.toArray(),
    position: Array.from(mesh.positions.subarray(0, 3)),
    normal: Array.from(mesh.normals.subarray(0, 3)),
    uv: Array.from(mesh.uvs.subarray(0, 2)),
  });
  assert.ok(near(norm(vOut.vNormal as number[]), 1, 1e-5));
  assert.ok(coneFrag);

  for (let iu = 0; iu <= 10; iu++) {
    for (let iv = 0; iv <= 4; iv++) {
      const u = iu / 10;
      const v = iv / 4;
      for (const time of [0, 3.7, 19.4]) {
        const normal: Vector = [0, 0, 1];
        const view: Vector = [0, 0.3, 0.9539392];
        const opacity = 0.42;
        const gpu = rFrag.run({
          colour: teal,
          time,
          speed: stream.speed,
          opacity,
          vUv: [u, v],
          vNormal: normal,
          vView: view,
        })!;
        const expectedAlpha =
          jetStreamFlowIntensity(u, v, time, stream.speed, dot(normal, view)) * opacity;
        assert.ok(
          near(gpu[3], expectedAlpha, 1e-5),
          `ribbon alpha u=${u} v=${v}: ${gpu[3]} vs ${expectedAlpha}`,
        );
        for (let c = 0; c < 3; c++) assert.ok(near(gpu[c], teal[c] * expectedAlpha, 1e-5));
      }
    }
  }

  // Ground track sweep wraps seamlessly across u = 0 / 1 boundary when headPhase = 0.08
  const headPhase = 0.08;
  const arcFraction = 0.24;
  // u = 0.95 is 0.13 behind 0.08 (0.08 - 0.95 + 1 = 0.13 <= 0.24 -> visible!)
  const behindHit = gtFrag.run({
    colour: teal,
    headPhase,
    arcFraction,
    opacity: 0.52,
    vUv: [0.95, 0.5],
    vNormal: [0, 0, 1],
    vView: [0, 0, 1],
  });
  assert.ok(behindHit !== null && behindHit[3] > 0.1, 'trail wraps seamlessly across u=0');
  // u = 0.25 is 0.83 behind 0.08 (> 0.24 -> discarded!)
  const outsideTrail = gtFrag.run({
    colour: teal,
    headPhase,
    arcFraction,
    opacity: 0.52,
    vUv: [0.25, 0.5],
    vNormal: [0, 0, 1],
    vView: [0, 0, 1],
  });
  assert.equal(outsideTrail, null, 'fragments ahead/outside ground track are discarded');

  // Beacon cone fades smoothly to 0 at tip (vUv.y = 1)
  const base = beaconFrag.run({ colour: [1, 0.2, 0.2], pulse: 0, opacity: 0.56, vUv: [0.5, 0] })!;
  const mid = beaconFrag.run({ colour: [1, 0.2, 0.2], pulse: 0, opacity: 0.56, vUv: [0.5, 0.5] })!;
  const tip = beaconFrag.run({ colour: [1, 0.2, 0.2], pulse: 0, opacity: 0.56, vUv: [0.5, 1] })!;
  assert.ok(base[3] > 0.3 && mid[3] > 0 && mid[3] < base[3], 'beacon cone tapers upward');
  assert.equal(tip[3], 0, 'warning beacon cone tapers to zero at apex');
});

test('orbital mechanics preserve radius, inclination, plane containment, and ground-track collinearity', () => {
  const customOrbits = [
    ...SATELLITE_ORBITS,
    {
      id: 'polar' as const,
      radius: 1.0,
      inclinationDeg: 0,
      raanDeg: 0,
      phaseOffset: 0,
      speed: 0.1,
    },
    {
      id: 'polar' as const,
      radius: 1.35,
      inclinationDeg: 51.6,
      raanDeg: -140,
      phaseOffset: 0.3,
      speed: 0.05,
    },
    {
      id: 'polar' as const,
      radius: 1.18,
      inclinationDeg: 90,
      raanDeg: 175,
      phaseOffset: 0.5,
      speed: 0.04,
    },
    {
      id: 'polar' as const,
      radius: 1.22,
      inclinationDeg: 145,
      raanDeg: 45,
      phaseOffset: 0.7,
      speed: 0.03,
    },
  ];

  for (const orbit of customOrbits) {
    const { u, v, normal } = orbitalBasis(orbit);
    assert.ok(near(norm(u), 1, 1e-12) && near(norm(v), 1, 1e-12) && near(norm(normal), 1, 1e-12));
    assert.ok(Math.abs(dot(u, v)) < 1e-12, 'basis vectors orthogonal');
    assert.ok(Math.abs(dot(u, normal)) < 1e-12 && Math.abs(dot(v, normal)) < 1e-12);

    // Inclination equals angle between orbital plane normal and north pole (0, 1, 0)
    const expectedAngle = Math.min(orbit.inclinationDeg, 180 - orbit.inclinationDeg);
    const measuredAngle = (Math.acos(Math.min(1, Math.abs(normal[1]))) * 180) / Math.PI;
    assert.ok(
      near(measuredAngle, expectedAngle, 1e-9),
      `inclination ${measuredAngle} vs ${expectedAngle}`,
    );

    // Ascending node check at anomaly = 0
    const asc = orbitalPoint(orbit, 0);
    assert.ok(Math.abs(asc[1]) < 1e-12, 'ascending node lies on equator');
    assert.ok(near(norm(asc), orbit.radius, 1e-12));

    // Arc segments preserve radius & orbital plane across 360 steps
    const arc = orbitalArcSegments(orbit, 120);
    assert.equal(arc.length, 120 * 6);
    for (let i = 0; i < arc.length; i += 3) {
      const p: Vector = [arc[i], arc[i + 1], arc[i + 2]];
      assert.ok(near(norm(p), orbit.radius, 1e-5), `arc radius invariant at ${i}`);
      assert.ok(Math.abs(dot(p, normal)) < 1e-5, `arc lies in orbital plane at ${i}`);
    }

    // Ground track sweep segments sit on surface radius
    const sweep = groundTrackSweepSegments(orbit, 0.42, Math.PI * 0.5, 48, 1.004);
    for (let i = 0; i < sweep.length; i += 3) {
      const p: Vector = [sweep[i], sweep[i + 1], sweep[i + 2]];
      assert.ok(near(norm(p), 1.004, 1e-5));
      assert.ok(Math.abs(dot(p, normal)) < 1e-5);
    }
  }

  for (const orbit of SATELLITE_ORBITS) {
    const pos = satellitePosition(orbit, 12.5, 1.004);
    assert.ok(near(norm(pos.orbital), orbit.radius, 1e-12));
    assert.ok(near(norm(pos.ground), 1.004, 1e-12));
    const dirOrb = pos.orbital.map((x) => x / norm(pos.orbital));
    const dirGnd = pos.ground.map((x) => x / norm(pos.ground));
    assert.ok(nearVec(dirOrb, dirGnd, 1e-12), 'satellite and nadir ground point are collinear');
  }
});

test('jet-stream & ground-track ribbon differential geometry: normal orthogonality and seam closure', () => {
  for (const stream of JET_STREAMS) {
    const segs = 144;
    const { positions, normals, uvs, indices } = jetStreamRibbonGeometryData(stream, segs);
    assert.equal(positions.length, (segs + 1) * 2 * 3);
    assert.equal(normals.length, (segs + 1) * 2 * 3);
    assert.equal(uvs.length, (segs + 1) * 2 * 2);
    assert.equal(indices.length, segs * 6);

    for (let i = 0; i <= segs; i++) {
      for (let side = 0; side < 2; side++) {
        const vIdx = i * 2 + side;
        const p: Vector = [positions[vIdx * 3], positions[vIdx * 3 + 1], positions[vIdx * 3 + 2]];
        const n: Vector = [normals[vIdx * 3], normals[vIdx * 3 + 1], normals[vIdx * 3 + 2]];
        assert.ok(near(norm(p), stream.altitude, 1e-5), 'ribbon lies on altitude shell');
        assert.ok(near(norm(n), 1, 1e-5), 'ribbon normal is unit vector');
        assert.ok(
          nearVec(
            n,
            [p[0] / stream.altitude, p[1] / stream.altitude, p[2] / stream.altitude],
            1e-5,
          ),
        );
      }
      // Check cross-ribbon chord orthogonality to radial normal at centerline
      const pL: Vector = [positions[i * 6], positions[i * 6 + 1], positions[i * 6 + 2]];
      const pR: Vector = [positions[i * 6 + 3], positions[i * 6 + 4], positions[i * 6 + 5]];
      const chord: Vector = [pR[0] - pL[0], pR[1] - pL[1], pR[2] - pL[2]];
      const midNormal: Vector = [
        0.5 * (normals[i * 6] + normals[i * 6 + 3]),
        0.5 * (normals[i * 6 + 1] + normals[i * 6 + 4]),
        0.5 * (normals[i * 6 + 2] + normals[i * 6 + 5]),
      ];
      assert.ok(
        Math.abs(dot(chord, midNormal)) < 1e-5,
        'ribbon width vector orthogonal to radial normal',
      );
    }

    // Seam closure: vertex i=0 and vertex i=segs match bit-for-bit in position & normal while UV spans 0..1
    for (let k = 0; k < 6; k++) {
      assert.equal(positions[k], positions[segs * 6 + k], `seam position ${k}`);
      assert.equal(normals[k], normals[segs * 6 + k], `seam normal ${k}`);
    }
    assert.equal(uvs[0], 0);
    assert.equal(uvs[segs * 4], 1);
  }

  for (const orbit of SATELLITE_ORBITS) {
    const track = groundTrackRibbonGeometryData(orbit, 96);
    assert.equal(track.indices.length, 96 * 6);
    assert.ok(
      near(norm([track.positions[0], track.positions[1], track.positions[2]]), 1.004, 1e-5),
    );
  }
});

test('geodesic SLERP satisfies unit-norm, coplanarity, shortest-path additivity, and antipodal stability', () => {
  const lattice = fibonacciSphere(40);
  const angle = (a: Vector, b: Vector) => Math.acos(Math.min(1, Math.max(-1, dot(a, b))));

  for (let i = 0; i < lattice.length; i++) {
    const u = lattice[i];
    const v = lattice[(i * 13 + 7) % lattice.length];
    const total = angle(u, v);
    const p1 = slerpDirection(u, v, 0.25);
    const p2 = slerpDirection(u, v, 0.65);
    assert.ok(near(norm(p1), 1, 1e-12) && near(norm(p2), 1, 1e-12), 'unit norm preserved');

    // Triangle equality along shortest geodesic: d(u, p1) + d(p1, p2) + d(p2, v) === d(u, v)
    const sum = angle(u, p1) + angle(p1, p2) + angle(p2, v);
    assert.ok(Math.abs(sum - total) < 1e-9, `geodesic additivity ${sum} vs ${total}`);

    // Coplanarity: det([u, v, p1]) == 0
    const crossUV: Vector = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    assert.ok(Math.abs(dot(crossUV, p1)) < 1e-11, 'slerp stays in great-circle plane');

    // Reversal symmetry for non-antipodal pairs
    if (total < Math.PI - 1e-3) {
      assert.ok(nearVec(slerpDirection(u, v, 0.35), slerpDirection(v, u, 0.65), 1e-11));
    }
  }

  // Exact antipodal stability
  for (const axis of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as Vector[]) {
    const opp: Vector = [-axis[0], -axis[1], -axis[2]];
    const mid = slerpDirection(axis, opp, 0.5);
    assert.ok(near(norm(mid), 1, 1e-12));
    assert.ok(Math.abs(dot(mid, axis)) < 1e-12, 'antipodal midpoint is perpendicular');
  }

  // flyToView crosses 180° antimeridian along shortest geodesic path
  const from = { latitude: 35, longitude: 172, distance: 4 };
  const to = { latitude: 35, longitude: -172, distance: 3 };
  const mid = flyToView(from, to, 0.5, 80);
  assert.ok(
    angularDistance(mid, { latitude: 35, longitude: 180 }) < 10,
    `crosses antimeridian directly (got lon ${mid.longitude})`,
  );
  assert.deepEqual(flyToView(from, to, 0), from);
  assert.deepEqual(flyToView(from, to, 1), to);
  assert.ok(dampedFlyEase(0) === 0 && dampedFlyEase(1) === 1);
  assert.ok(dampedFlyEase(0.5) > 0.5 && dampedFlyEase(0.5) < 0.7);
});

test('warning outline centroid + full GPU resource disposal completeness', () => {
  // Centroid of antimeridian-crossing box centered at (20°N, 178°E)
  const box = {
    type: 'MultiPolygon' as const,
    coordinates: [
      [
        [
          [173, 15],
          [183, 15],
          [183, 25],
          [173, 25],
          [173, 15],
        ],
      ],
    ],
  };
  const segs = outlineSegments(box, 1.003, 1);
  const centroid = segmentsCentroid(segs, 1.003);
  assert.ok(centroid, 'centroid computed');
  assert.ok(near(norm(centroid), 1.003, 1e-5));
  const ll = vectorToLatLon(centroid);
  assert.ok(
    Math.abs(ll.latitude - 20) < 0.5 && Math.abs(ll.longitude - 178) < 0.5,
    `${ll.latitude}, ${ll.longitude}`,
  );

  // Spy on every geometry, material, texture, and renderer created during createGlobe
  const createdResources: { kind: string; disposed: number }[] = [];
  const track = (kind: string, Ctor: unknown) =>
    class extends (Ctor as new (...args: unknown[]) => object) {
      disposed = 0;
      constructor(...args: unknown[]) {
        super(...args);
        const entry = { kind, disposed: 0 };
        createdResources.push(entry);
        const orig = (this as unknown as { dispose?: () => void }).dispose?.bind(this);
        (this as unknown as { dispose: () => void }).dispose = () => {
          entry.disposed++;
          orig?.();
        };
      }
    };

  let rendererDisposed = 0;
  class TrackedRenderer {
    capabilities = { getMaxAnisotropy: () => 16 };
    setClearColor() {}
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {
      rendererDisposed++;
    }
    forceContextLoss() {}
  }

  const restore: (() => void)[] = [];
  const install = (name: string, val: unknown) => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value: val, configurable: true, writable: true });
    restore.push(() => {
      if (prev) Object.defineProperty(globalThis, name, prev);
      else delete (globalThis as Record<string, unknown>)[name];
    });
  };
  try {
    const target = () =>
      Object.assign(new EventTarget(), {
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      });
    install('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    install('window', {
      devicePixelRatio: 1,
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
    });
    install('requestAnimationFrame', () => 1);
    install('cancelAnimationFrame', () => {});
    install('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    install(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    install(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );

    const canvas = Object.assign(target(), {
      style: {},
      ownerDocument: document,
      clientHeight: 600,
      setPointerCapture() {},
      releasePointerCapture() {},
      remove() {},
    });
    const trackedKit = {
      ...three,
      WebGLRenderer: TrackedRenderer,
      BufferGeometry: track('BufferGeometry', three.BufferGeometry),
      SphereGeometry: track('SphereGeometry', three.SphereGeometry),
      CircleGeometry: track('CircleGeometry', three.CircleGeometry),
      RingGeometry: track('RingGeometry', three.RingGeometry),
      CylinderGeometry: track('CylinderGeometry', three.CylinderGeometry),
      ShaderMaterial: track('ShaderMaterial', three.ShaderMaterial),
      DataTexture: track('DataTexture', three.DataTexture),
      Texture: track('Texture', three.Texture),
      LineMaterial: track('LineMaterial', three.LineMaterial),
      LineSegmentsGeometry: track('LineSegmentsGeometry', three.LineSegmentsGeometry),
    } as unknown as ThreeKit;

    const events: GlobeEvents = {
      interact() {},
      turned() {},
      pick() {},
      wheel() {},
      zoomed() {},
      lost() {},
      restored() {},
      failed() {},
    };
    const globe = createGlobe(
      trackedKit,
      { canvas, context: { isContextLost: () => false } } as never,
      target() as never,
      { append() {} } as never,
      null,
      events,
      { clock: () => Date.UTC(2026, 10, 19, 12) },
    )!;
    assert.ok(globe);
    globe.setOutlines([segs]);
    globe.setOutlines([segs]); // replace outlines: old ones must dispose immediately
    globe.setImage('base', { width: 2048, height: 1024 } as unknown as TexImageSource);
    globe.setImage('daily', { width: 2048, height: 1024 } as unknown as TexImageSource);
    globe.dispose();

    assert.ok(createdResources.length >= 20, `tracked ${createdResources.length} GPU resources`);
    for (const resource of createdResources) {
      assert.equal(
        resource.disposed,
        1,
        `${resource.kind} disposed exactly once (got ${resource.disposed})`,
      );
    }
    assert.equal(rendererDisposed, 1, 'renderer disposed once');
  } finally {
    for (const undo of restore.reverse()) undo();
  }
});

test('boundary and NaN/Infinity resilience across all 3D math primitives', () => {
  const badVec: Vector = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const zeroVec: Vector = [0, 0, 0];

  assert.equal(atmosphereOpticalDepth(Number.NaN), 0);
  assert.equal(atmosphereOpticalDepth(-10), 0);
  assert.equal(atmosphereOpticalDepth(999), 1);

  assert.ok(Number.isFinite(miePhaseFunction(Number.NaN)));
  assert.ok(Number.isFinite(miePhaseFunction(Number.POSITIVE_INFINITY)));

  const scatterBad = atmosphereScatter(badVec, zeroVec, badVec, 0, teal, violet);
  assert.ok(scatterBad.every((x) => Number.isFinite(x) && x >= 0));

  const slerpBad = slerpDirection(badVec, zeroVec, Number.NaN);
  assert.ok(slerpBad.every(Number.isFinite) && near(norm(slerpBad), 1, 1e-12));

  assert.equal(dampedFlyEase(Number.NaN), 0);
  assert.equal(dampedFlyEase(-5), 0);
  assert.equal(dampedFlyEase(5), 1);

  const badOrbit = {
    id: 'polar' as const,
    radius: 1.13,
    inclinationDeg: 90,
    raanDeg: 0,
    phaseOffset: 0,
    speed: 0.1,
  };
  assert.ok(orbitalPoint(badOrbit, Number.NaN).every(Number.isFinite));
  assert.ok(orbitalArcSegments(badOrbit, 2).every(Number.isFinite));
  assert.ok(groundTrackSweepSegments(badOrbit, Number.NaN, Number.NaN, 1).every(Number.isFinite));
  assert.ok(satellitePosition(badOrbit, Number.NaN).orbital.every(Number.isFinite));
  assert.ok(
    jetStreamRibbonGeometryData(JET_STREAMS[0], 4, Number.NaN).positions.every(Number.isFinite),
  );

  assert.equal(segmentsCentroid(new Float32Array(0)), null);
  assert.equal(segmentsCentroid(new Float32Array([Number.NaN, 0, 0, 1, 0, 0])), null);
  assert.equal(segmentsCentroid(new Float32Array([1, 0, 0, 1, 0, 0]), -1), null);
});
