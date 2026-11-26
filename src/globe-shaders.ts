/**
 * The 3D globe's shaders (globe-scene.ts), kept apart from three.js so the tests can run them:
 * tests/globe-shaders.test.ts evaluates the surface shader for points on the globe, and checks the
 * warning-outline patch against three.js's own line shader.
 */
import { ATMOSPHERE_SCATTER_GLSL, SHADING, SHADING_GLSL } from './globe';

export const surfaceVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
export const atmosphereVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vWorldPos;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
export const earthFragment = /* glsl */ `
  uniform sampler2D baseMap;
  uniform sampler2D dailyMap;
  uniform float baseReady;
  uniform float dailyMix;
  uniform float dailyShown;
  uniform float hatchStep;
  uniform vec3 sun;
  uniform vec3 teal;
  uniform vec3 violet;
  uniform vec3 plain;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  ${SHADING_GLSL}
  float grid(float degrees, float spacing) {
    float distance = abs(fract(degrees / spacing + 0.5) - 0.5) * spacing;
    return 1.0 - smoothstep(0.0, fwidth(degrees) * 1.2, distance);
  }
  float stripes(float phase) {
    float distance = abs(fract(phase) - 0.5);
    float blur = fwidth(phase);
    return 1.0 - smoothstep(0.15 - blur, 0.15 + blur, distance);
  }
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    // The images are uploaded as they are, north in the top row (setImage: flipY off).
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    // Without its base image the globe is a plain sphere with a graticule, never a guessed surface.
    float lines = max(grid(vUv.y * 180.0, 15.0), grid(vUv.x * 360.0, 15.0));
    vec3 base = mix(plain + teal * lines * 0.12, texture2D(baseMap, uv).rgb, baseReady);
    // GIBS fills missing pixels with black (globe.ts GAP_LEVEL).
    vec4 daily = texture2D(dailyMap, uv);
    float observed = smoothstep(0.0024, 0.0052, max(daily.r, max(daily.g, daily.b)));
    // Where the shown mosaic has no pixels, the base map comes through muted and hatched, so its
    // cloud-free surface never passes for clear weather ("Not imaged that day" in the key).
    float gap = dailyShown * (1.0 - observed);
    float hatch = stripes((vUv.x * 360.0 + vUv.y * 180.0) / hatchStep);
    float tone = dot(base, vec3(0.2126, 0.7152, 0.0722));
    vec3 muted = mix(vec3(tone), base, 0.25) * 0.5 + violet * (0.03 + 0.13 * hatch);
    vec3 surface = mix(mix(base, muted, gap), daily.rgb, dailyMix * observed);
    // Day, night and the twilight line between them (globe.ts SHADING): night is about a fifth
    // of day's brightness on screen, dim enough to read as night, with continents still visible.
    float light = dot(n, sun);
    vec3 colour = shade(surface, light, violet);
    float day = smoothstep(${SHADING.dusk.toFixed(4)}, ${SHADING.dawn.toFixed(4)}, light);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    colour += mix(teal, violet, rim) * rim * (0.1 + 0.32 * day);
    gl_FragColor = vec4(colour, 1.0);
    #include <colorspace_fragment>
  }
`;
export const atmosphereFragment = /* glsl */ `
  uniform vec3 teal;
  uniform vec3 violet;
  uniform vec3 sun;
  uniform float edge;
  varying vec3 vNormal;
  varying vec3 vView;
  ${ATMOSPHERE_SCATTER_GLSL}
  void main() {
    gl_FragColor = atmosphereScatter(vNormal, vView, sun, edge, teal, violet);
    #include <colorspace_fragment>
  }
`;
export const ribbonVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
export const ribbonFragment = /* glsl */ `
  uniform vec3 colour;
  uniform float time;
  uniform float speed;
  uniform float opacity;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float band = exp(-pow((vUv.y - 0.5) * 3.1, 2.0));
    float packet = 0.5 + 0.5 * sin(6.2831853 * (vUv.x * 6.0 - time * speed));
    float stream = 0.28 + 0.72 * packet * packet;
    float horizon = smoothstep(0.0, 0.14, dot(normalize(vNormal), normalize(vView)));
    float alpha = clamp(band * stream * horizon * 0.72, 0.0, 1.0) * opacity;
    gl_FragColor = vec4(colour * alpha, alpha);
    #include <colorspace_fragment>
  }
`;
export const groundTrackFragment = /* glsl */ `
  uniform vec3 colour;
  uniform float headPhase;
  uniform float arcFraction;
  uniform float opacity;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float behind = mod(headPhase - vUv.x + 1.0, 1.0);
    if (behind > arcFraction) discard;
    float trail = smoothstep(arcFraction, 0.0, behind);
    float band = exp(-pow((vUv.y - 0.5) * 2.8, 2.0));
    float horizon = smoothstep(0.0, 0.08, dot(normalize(vNormal), normalize(vView)));
    float alpha = trail * band * horizon * opacity;
    if (alpha <= 0.001) discard;
    gl_FragColor = vec4(colour * alpha, alpha);
    #include <colorspace_fragment>
  }
`;
export const beaconConeFragment = /* glsl */ `
  uniform vec3 colour;
  uniform float pulse;
  uniform float opacity;
  varying vec2 vUv;
  void main() {
    float heightFade = vUv.y >= 1.0 ? 0.0 : pow(max(1.0 - vUv.y, 0.0), 1.45);
    float wave = 0.65 + 0.35 * sin(6.2831853 * (vUv.y * 1.5 - pulse));
    float alpha = clamp(heightFade * wave * opacity, 0.0, 1.0);
    gl_FragColor = vec4(colour * alpha, alpha);
    #include <colorspace_fragment>
  }
`;
export const starVertex = /* glsl */ `
  attribute float size;
  attribute float tint;
  uniform float pixelRatio;
  uniform float time;
  uniform float twinkle;
  uniform vec3 teal;
  uniform vec3 violet;
  varying vec3 vColour;
  varying float vAlpha;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * pixelRatio;
    vColour = tint < 0.5 ? vec3(0.86, 0.9, 1.0) : tint < 1.5 ? teal : violet;
    float seed = fract(sin(dot(position.xy, vec2(12.9898, 78.233))) * 43758.5453);
    vAlpha = (0.5 + 0.5 * seed) * (1.0 - twinkle * 0.4 * (0.5 + 0.5 * sin(time * (0.6 + seed) + seed * 40.0)));
  }
`;
export const starFragment = /* glsl */ `
  varying vec3 vColour;
  varying float vAlpha;
  void main() {
    float a = smoothstep(0.5, 0.05, length(gl_PointCoord - 0.5)) * vAlpha;
    gl_FragColor = vec4(vColour * a, a);
    #include <colorspace_fragment>
  }
`;
export const glowFragment = /* glsl */ `
  uniform vec3 colour;
  uniform float opacity;
  varying vec2 vUv;
  void main() {
    float a = smoothstep(0.5, 0.0, length(vUv - 0.5)) * opacity;
    gl_FragColor = vec4(colour * a, a);
    #include <colorspace_fragment>
  }
`;
export const flatFragment = /* glsl */ `
  uniform vec3 colour;
  uniform float opacity;
  void main() {
    gl_FragColor = vec4(colour * opacity, opacity);
    #include <colorspace_fragment>
  }
`;
export const beamFragment = /* glsl */ `
  uniform vec3 colour;
  varying vec2 vUv;
  void main() {
    float a = pow(1.0 - vUv.y, 1.6) * 0.85;
    gl_FragColor = vec4(colour * a, a);
    #include <colorspace_fragment>
  }
`;
export const plainVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
/**
 * Warning outlines fade out at the horizon and are not drawn beyond it: a line just above the far
 * side of the sphere would otherwise poke out past its edge. A patch of three.js's line shader,
 * which must find the lines it replaces (tests/globe-shaders.test.ts reads three.js's own).
 */
export function hideBeyondHorizon(shader: { vertexShader: string; fragmentShader: string }) {
  shader.vertexShader = shader.vertexShader.replace(
    'void main() {',
    `varying float vFacing;
    void main() {
      vec3 surfacePoint = position.y < 0.5 ? instanceStart : instanceEnd;
      vFacing = dot(normalize(surfacePoint), normalize(cameraPosition - surfacePoint));`,
  );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      'void main() {',
      'varying float vFacing;\nvoid main() {\n  if (vFacing < 0.0) discard;',
    )
    .replace(
      'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
      'gl_FragColor = vec4( diffuseColor.rgb, alpha * smoothstep( 0.0, 0.07, vFacing ) );',
    );
}
