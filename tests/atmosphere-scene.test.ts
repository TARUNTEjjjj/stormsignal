import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AtmosphereScene from '../src/components/AtmosphereScene';

// The conditions card's artwork: decoration in the Midnight Aurora palette, never a reading.
const scene = (code: number | null) =>
  renderToStaticMarkup(createElement(AtmosphereScene, { code }));
const codes = [null, 0, 2, 3, 45, 63, 75, 95];
const colours = (html: string) => [
  ...new Set([...html.matchAll(/#[0-9a-f]{6}\b/gi)].map((match) => match[0].toLowerCase())),
];
function hsl(colour: string) {
  const value = Number.parseInt(colour.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const spread = max - min;
  const saturation = spread ? spread / (1 - Math.abs(2 * lightness - 1)) : 0;
  const sector = !spread
    ? 0
    : max === r
      ? (g - b) / spread
      : max === g
        ? (b - r) / spread + 2
        : (r - g) / spread + 4;
  return { hue: (sector * 60 + 360) % 360, saturation, lightness };
}

test('the atmosphere artwork stays decorative and out of the reading order', () => {
  for (const code of codes) {
    const html = scene(code);
    assert.match(html, /^<svg class="atmosphere-scene"[^>]*aria-hidden="true"/, String(code));
    assert.match(html, /focusable="false"/);
    assert.doesNotMatch(html, /<(?:text|title|desc|a)\b/, 'nothing in it can be read or focused');
  }
});

test('the artwork is drawn in cool aurora colours, never in a warning red, orange or yellow', () => {
  for (const code of codes)
    for (const colour of colours(scene(code))) {
      const { hue, saturation } = hsl(colour);
      const warm = hue < 75 || hue >= 330;
      assert.ok(
        !warm || saturation < 0.2,
        `${colour} (code ${code}) is a warm, warning-like colour`,
      );
    }
  // Rain takes the teal of the palette and other weather its violet, both kept faint, since the
  // temperature can sit over the halo's edge.
  const halo = (html: string) =>
    /-halo"><stop stop-color="(#[0-9a-f]{6})" stop-opacity="([\d.]+)"/.exec(html)!;
  assert.equal(halo(scene(63))[1], '#3ee6c1');
  assert.equal(halo(scene(0))[1], '#8b7cff');
  assert.ok(Number(halo(scene(0))[2]) <= 0.16, 'a faint halo');
});

test('the artwork follows the weather code it is given, and draws no body without one', () => {
  const orb = /fill="url\(#[^)]*-orb\)"/;
  assert.doesNotMatch(scene(null), orb, 'no forecast: no sun or moon is implied');
  assert.match(scene(0), orb);
  assert.match(scene(3), /-cloud\)"/);
  assert.match(scene(63), /stroke="url\(#[^)]*-rain\)"/);
  assert.match(scene(75), /<circle[^>]*r="2.4"/, 'snow');
  assert.match(scene(95), /fill="#e9e4ff"/, 'lightning');
  assert.doesNotMatch(scene(63), /fill="#e9e4ff"/);
});

test('the artwork separates depth-parallax layers cleanly without altering accessibility', () => {
  for (const code of [null, 0, 63, 95]) {
    const html = scene(code);
    for (const layer of ['atmo-depth-far', 'atmo-depth-mid', 'atmo-depth-near']) {
      assert.match(html, new RegExp(`class="${layer}"`), `missing ${layer} for code ${code}`);
    }
  }
});
