import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector4 } from 'three';
import {
  DAILY_OPACITY,
  SHADING_GLSL,
  WARNING_LINE,
  latLonToVector,
  shade,
  srgbDecode,
  srgbEncode,
  starfield,
  sunDirection,
  type Vector,
} from '../src/globe';
import { OUTLINE_RADIUS } from '../src/globe-scene';
import { earthFragment, hideBeyondHorizon, starVertex } from '../src/globe-shaders';
import { glsl, type Sampler, type Value } from './support/glsl';

// The globe's surface shader, run on the CPU one fragment at a time (tests/support/glsl.ts): what
// colour a point of the globe gets by day and by night, where the daily mosaic has imagery and
// where it has none. Colours are in linear light, before three.js writes them out as sRGB.
const linear = (hex: string) =>
  [1, 3, 5].map((at) => srgbDecode(Number.parseInt(hex.slice(at, at + 2), 16) / 255)) as Vector;
/** sRGB luma of a linear colour as the screen shows it (0 to 1). */
const luma = ([r, g, b]: number[]) =>
  0.2126 * srgbEncode(r) + 0.7152 * srgbEncode(g) + 0.0722 * srgbEncode(b);
const teal = linear('#3ee6c1');
const violet = linear('#8b7cff');
const plain = linear('#131e33');
const flat =
  (colour: number[]): Sampler =>
  () => [...colour, 1];
const land = linear('#6b8a45');
const cloud = linear('#e8ecf2');
const earth = glsl(earthFragment);
const chennai = latLonToVector(13.0827, 80.2707);
/** One fragment of the globe: lit by `sun`, seen from straight above (no rim light). */
function fragment({
  normal = chennai,
  sun = chennai,
  uv = [0.5, 0.5],
  base = flat(land),
  daily = flat([0, 0, 0]),
  baseReady = 1,
  dailyMix = 0,
  dailyShown = 0,
  hatchStep = 4,
}: {
  normal?: Vector;
  sun?: Vector;
  uv?: number[];
  base?: Sampler;
  daily?: Sampler;
  baseReady?: number;
  dailyMix?: number;
  dailyShown?: number;
  hatchStep?: number;
}) {
  const colour = earth.run({
    baseMap: base,
    dailyMap: daily,
    baseReady,
    dailyMix,
    dailyShown,
    hatchStep,
    sun,
    teal,
    violet,
    plain,
    vUv: uv,
    vNormal: normal,
    vView: normal,
  });
  assert.ok(colour, 'the surface is never discarded');
  return colour.slice(0, 3);
}
const near = (a: number[], b: number[], tolerance = 1e-9) =>
  a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

test("the shader's day and night are the tested shading curve (globe.ts shade)", () => {
  const shader = glsl(`
    uniform vec3 surface;
    uniform float light;
    uniform vec3 violet;
    ${SHADING_GLSL}
    void main() {
      gl_FragColor = vec4(shade(surface, light, violet), 1.0);
    }
  `);
  for (const surface of [land, cloud, linear('#16365a')])
    for (const light of [-1, -0.3, -0.04, 0, 0.02, 0.1, 0.4, 1]) {
      const fromShader = shader.run({ surface, light, violet })!.slice(0, 3);
      const expected = shade(surface, light, violet);
      assert.ok(near(fromShader, expected, 1e-6), `light ${light}: ${fromShader} vs ${expected}`);
    }
});

test('the side of the globe that faces the sun is day, and the far side night', () => {
  // Chennai at 1 p.m. and at 3 a.m. local time (UTC+5:30), as the scene places the sun.
  const day = fragment({ sun: sunDirection(Date.parse('2026-11-19T07:30:00Z')) });
  const night = fragment({ sun: sunDirection(Date.parse('2026-11-18T21:30:00Z')) });
  assert.ok(luma(day) > 0.3, `day reads as day (luma ${luma(day).toFixed(3)})`);
  assert.ok(luma(night) <= luma(day) / 5, `night ${luma(night)} vs day ${luma(day)}`);
  assert.ok(luma(night) > 0, 'the land is still faintly there');
  // The terminator: lit just above the horizon, dark well below it.
  const sideways = latLonToVector(13.0827, 80.2707 + 95);
  const below = fragment({ sun: sideways });
  const above = fragment({ sun: latLonToVector(13.0827, 80.2707 + 80) });
  assert.ok(luma(above) > 2 * luma(below), 'day gives way to night across the terminator');
});

test('where the shown mosaic has imagery, it is drawn; where it has none, the base is hatched', () => {
  const shown = { dailyMix: DAILY_OPACITY, dailyShown: 1 };
  // The hatch runs diagonally: a stripe where (u·360 + v·180) / step is half-way between whole
  // numbers, clear space where it is a whole number.
  const onStripe = [(4 * 30.5 - 90) / 360, 0.5];
  const between = [(4 * 30 - 90) / 360, 0.5];
  // Imagery (cloud) at the point: the mosaic replaces most of the base, by DAILY_OPACITY.
  const clouded = fragment({ ...shown, daily: flat(cloud), uv: onStripe });
  const expected = fragment({
    base: flat(land.map((value, index) => value + (cloud[index] - value) * DAILY_OPACITY)),
    uv: onStripe,
  });
  assert.ok(near(clouded, expected, 1e-6), `${clouded} vs ${expected}`);
  // No imagery (GIBS's black fill): the cloud-free base shows muted, with violet stripes.
  const stripe = fragment({ ...shown, uv: onStripe });
  const clear = fragment({ ...shown, uv: between });
  const hidden = fragment({ uv: onStripe });
  assert.ok(luma(stripe) > luma(clear) * 1.1, `stripes ${luma(stripe)} vs ${luma(clear)}`);
  assert.ok(stripe[2] > stripe[1], 'the stripes are violet');
  assert.ok(luma(clear) < luma(hidden) * 0.8, 'the base comes through muted, never as clear sky');
  // With the daily layer off there is nothing to hatch: the base map, as it is.
  assert.ok(near(fragment({ uv: between }), hidden, 1e-9), 'no hatch without the daily layer');
  assert.ok(near(fragment({ uv: between, daily: flat(cloud) }), hidden, 1e-9), 'nor any cloud');
});

test('without its base image the globe is a plain sphere, never a guessed surface', () => {
  const sea = flat(linear('#16365a'));
  const off = (base: Sampler) => fragment({ baseReady: 0, base, uv: [0.52, 0.47] });
  assert.ok(near(off(flat(land)), off(sea)), 'the missing image is not drawn at all');
  assert.ok(!near(fragment({ base: flat(land) }), fragment({ base: sea })), 'a loaded one is');
  // Its graticule: a faint teal line every 15°.
  const onLine = fragment({ baseReady: 0, uv: [90 / 360, 0.52] });
  const offLine = fragment({ baseReady: 0, uv: [97 / 360, 0.52] });
  assert.ok(onLine[1] > offLine[1], 'a meridian at 90° E');
});

test("warning outlines fade at the horizon and are cut beyond it, in three.js's line shader", async () => {
  // The patch replaces lines of three.js's own line shader: each must still be there.
  await import('three/examples/jsm/lines/LineMaterial.js');
  const { ShaderLib } = await import('three');
  const line = ShaderLib['line'] as { vertexShader: string; fragmentShader: string };
  const shader = { vertexShader: line.vertexShader, fragmentShader: line.fragmentShader };
  hideBeyondHorizon(shader);
  assert.match(line.vertexShader, /attribute vec3 instanceStart;/);
  assert.match(line.vertexShader, /attribute vec3 instanceEnd;/);
  assert.match(shader.vertexShader, /varying float vFacing;\s*void main\(\) \{/);
  assert.match(
    shader.vertexShader,
    /vFacing = dot\(normalize\(surfacePoint\), normalize\(cameraPosition - surfacePoint\)\);/,
  );
  assert.match(
    shader.fragmentShader,
    /varying float vFacing;\s*void main\(\) \{\s*if \(vFacing < 0\.0\) discard;/,
  );
  assert.match(
    shader.fragmentShader,
    /gl_FragColor = vec4\( diffuseColor\.rgb, alpha \* smoothstep\( 0\.0, 0\.07, vFacing \) \);/,
  );
  assert.doesNotMatch(shader.fragmentShader, /gl_FragColor = vec4\( diffuseColor\.rgb, alpha \);/);
  // The patched lines, run on the CPU: beyond the horizon nothing, at it a fade, then full.
  const cut = /void main\(\) \{\s*(if \(vFacing < 0\.0\) discard;)/.exec(shader.fragmentShader);
  const fade = /gl_FragColor = vec4\( diffuseColor\.rgb, alpha \*[^;]*;/.exec(
    shader.fragmentShader,
  );
  assert.ok(cut && fade);
  const patched = glsl(`
    varying float vFacing;
    void main() {
      ${cut[1]}
      vec4 diffuseColor = vec4(1.0, 0.42, 0.46, 1.0);
      float alpha = 1.0;
      ${fade[0]}
    }
  `);
  assert.equal(patched.run({ vFacing: -0.01 }), null);
  assert.equal(patched.run({ vFacing: 0.035 })![3], 0.5);
  assert.equal(patched.run({ vFacing: 0.5 })![3], 1);
});

test('a warning outline that crosses the horizon is drawn up to it and cut beyond it', async () => {
  // three.js's own line shader, patched, run for each corner of one segment of an outline as the
  // scene draws it: in screen pixels and undashed, on the 900 × 700 stage, from the camera at rest
  // five radii out. From there the horizon, at the outlines' height, lies 78.4° from the point
  // under the camera; the segment runs along the equator from 77.5° to 79.5° across it.
  await import('three/examples/jsm/lines/LineMaterial.js');
  const { LineSegmentsGeometry } = await import('three/examples/jsm/lines/LineSegmentsGeometry.js');
  const { ShaderLib } = await import('three');
  const line = ShaderLib['line'] as { vertexShader: string; fragmentShader: string };
  const shader = { vertexShader: line.vertexShader, fragmentShader: line.fragmentShader };
  hideBeyondHorizon(shader);
  // three.js declares these ahead of a material's own code.
  const vertex = glsl(`
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform vec3 cameraPosition;
    attribute vec3 position;
    attribute vec2 uv;
    ${shader.vertexShader}
  `);
  const camera = new PerspectiveCamera(30, 900 / 700, 0.05, 200);
  camera.position.set(...latLonToVector(0, 0, 5));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const ends = {
    start: latLonToVector(0, 77.5, OUTLINE_RADIUS),
    end: latLonToVector(0, 79.5, OUTLINE_RADIUS),
  };
  const clip = (point: Vector) =>
    new Vector4(...point, 1)
      .applyMatrix4(camera.matrixWorldInverse)
      .applyMatrix4(camera.projectionMatrix);
  // A segment is drawn as a quad of eight corners (LineSegmentsGeometry), each at one of its ends.
  const quad = new LineSegmentsGeometry();
  const corners = quad.getAttribute('position');
  const uvs = quad.getAttribute('uv');
  const facing = { start: [] as number[], end: [] as number[] };
  for (let corner = 0; corner < corners.count; corner++) {
    const drawn = vertex.vertex({
      modelViewMatrix: camera.matrixWorldInverse.elements,
      projectionMatrix: camera.projectionMatrix.elements,
      cameraPosition: camera.position.toArray(),
      position: [corners.getX(corner), corners.getY(corner), corners.getZ(corner)],
      uv: [uvs.getX(corner), uvs.getY(corner)],
      instanceStart: ends.start,
      instanceEnd: ends.end,
      linewidth: WARNING_LINE.width,
      resolution: [900, 700],
    });
    // The end a corner is drawn at: it keeps that end's depth, moved only across the screen.
    const [, , z, w] = drawn.gl_Position as number[];
    const at = (['start', 'end'] as const).filter((name) => {
      const { z: endZ, w: endW } = clip(ends[name]);
      return Math.abs(z - endZ) < 1e-9 && Math.abs(w - endW) < 1e-9;
    });
    assert.equal(at.length, 1, `corner ${corner} lies at one end of the segment`);
    facing[at[0]].push(drawn.vFacing as number);
  }
  // Each corner fades by its own end's side of the horizon: the near end is drawn, the far one
  // cut, and the fragments between are cut at the horizon.
  assert.equal(facing.start.length, 4);
  assert.equal(facing.end.length, 4);
  const [near, far] = [facing.start[0], facing.end[0]];
  assert.ok(near > 0 && facing.start.every((value) => value === near), `${facing.start}`);
  assert.ok(far < 0 && facing.end.every((value) => value === far), `${facing.end}`);
  const horizon = (Math.acos(OUTLINE_RADIUS / 5) * 180) / Math.PI;
  const cut = 77.5 + (2 * near) / (near - far);
  assert.ok(Math.abs(cut - horizon) < 0.05, `cut at ${cut}° E, the horizon at ${horizon}° E`);
});

// The stars' vertex shader, run one star at a time over the scene's own sky. three.js declares
// the camera's matrices and the vertex's position ahead of a ShaderMaterial's own code: the
// shader is given here those of them it uses.
const stars = glsl(`
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  attribute vec3 position;
  ${starVertex}
`);
const sky = starfield(1800);
/** Column-major, as three.js hands a matrix to a shader. */
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** What the shader makes of star `index`: its place, its size in pixels, colour and brightness. */
const star = (index: number, uniforms: Record<string, Value> = {}) =>
  stars.vertex({
    position: Array.from(sky.positions.subarray(index * 3, index * 3 + 3)),
    size: sky.sizes[index],
    tint: sky.tints[index],
    pixelRatio: 1,
    time: 0,
    twinkle: 0,
    teal,
    violet,
    modelViewMatrix: identity,
    projectionMatrix: identity,
    ...uniforms,
  });

test('the sky is mostly white stars, with a few in the aurora teal and violet', () => {
  const counts: Record<string, number> = {};
  for (let index = 0; index < sky.sizes.length; index++) {
    const colour = star(index).vColour as number[];
    const name = near(colour, teal)
      ? 'teal'
      : near(colour, violet)
        ? 'violet'
        : Math.min(...colour) > 0.8
          ? 'white'
          : `${colour}`;
    counts[name] = (counts[name] ?? 0) + 1;
    // Each star is drawn in the colour its tint names (globe.ts starfield): 0 white, 1 the aurora
    // teal, 2 its violet.
    assert.equal(name, ['white', 'teal', 'violet'][sky.tints[index]], `star ${index}`);
  }
  assert.deepEqual(Object.keys(counts).sort(), ['teal', 'violet', 'white']);
  const share = (name: string) => counts[name] / sky.sizes.length;
  assert.ok(share('white') > 0.7, `${counts.white} white stars of ${sky.sizes.length}`);
  for (const name of ['teal', 'violet'])
    assert.ok(share(name) > 0.05 && share(name) < 0.2, `${counts[name]} ${name} stars`);
});

test('a star looks the same size on every screen, and is placed by the camera like the globe', () => {
  // Its size is in device pixels: twice as many across on a 2× screen (globe-scene.ts sets the
  // ratio to the renderer's).
  assert.equal(star(0).gl_PointSize, sky.sizes[0]);
  assert.equal(star(0, { pixelRatio: 2 }).gl_PointSize, 2 * sky.sizes[0]);
  // A camera five units back along z sees it five units further off.
  const [x, y, z] = sky.positions.subarray(0, 3);
  const back = [...identity.slice(0, 14), -5, 1];
  assert.deepEqual(star(0, { modelViewMatrix: back }).gl_Position, [x, y, z - 5, 1]);
  // Through the scene's own lens (30° tall, on the 900 × 700 stage), at rest over Chennai: every
  // star lands where three.js places any point the camera sees, the globe's own included, and
  // those in the frame are drawn. Without the lens, or with its matrices the wrong way round, the
  // sky would be empty or scattered.
  const camera = new PerspectiveCamera(30, 900 / 700, 0.05, 200);
  camera.position.set(...latLonToVector(13.0827, 80.2707, 5));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const lens = {
    modelViewMatrix: camera.matrixWorldInverse.elements,
    projectionMatrix: camera.projectionMatrix.elements,
  };
  let framed = 0;
  for (let index = 0; index < sky.sizes.length; index++) {
    const point = new Vector4(...sky.positions.subarray(index * 3, index * 3 + 3), 1);
    const expected = point
      .applyMatrix4(camera.matrixWorldInverse)
      .applyMatrix4(camera.projectionMatrix)
      .toArray();
    const placed = star(index, lens).gl_Position as number[];
    placed.forEach((value, axis) =>
      assert.ok(
        Math.abs(value - expected[axis]) < 1e-9,
        `star ${index}, axis ${axis}: ${value} vs ${expected[axis]}`,
      ),
    );
    const [px, py, pz, pw] = placed;
    if (pw > 0 && Math.max(Math.abs(px), Math.abs(py), Math.abs(pz)) <= pw) framed++;
  }
  // The frame takes in some 3% of the sky: about 50 of its 1800 stars.
  assert.ok(framed > 30, `${framed} stars in the frame`);
});
