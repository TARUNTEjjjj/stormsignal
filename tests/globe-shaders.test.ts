import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_OPACITY,
  SHADING_GLSL,
  latLonToVector,
  shade,
  srgbDecode,
  srgbEncode,
  sunDirection,
  type Vector,
} from '../src/globe';
import { earthFragment, hideBeyondHorizon } from '../src/globe-shaders';
import { glsl, type Sampler } from './support/glsl';

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
