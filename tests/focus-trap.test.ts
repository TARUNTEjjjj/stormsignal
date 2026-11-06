import assert from 'node:assert/strict';
import test from 'node:test';
import { focusableControls } from '../src/focus-trap';

type Box = 'shown' | 'display-none' | 'closed-details';
type Control = HTMLElement & { label: string };
/**
 * Chrome keeps layout boxes for the contents of a closed <details>: they are
 * content-visibility: hidden rather than display: none, so getClientRects() is not empty,
 * but checkVisibility() is false and focus() does nothing.
 */
const control = (label: string, box: Box = 'shown') =>
  ({
    label,
    getClientRects: () => ({ length: box === 'display-none' ? 0 : 1 }),
    checkVisibility: () => box === 'shown',
  }) as unknown as Control;
const container = (items: Control[]) =>
  ({ querySelectorAll: () => items }) as unknown as ParentNode;
const labels = (items: HTMLElement[]) => items.map((item) => (item as Control).label);

test('the drawer focus trap ends at a closed details summary, not at links hidden inside it', () => {
  const drawer = [
    control('StormSignal home'),
    control('Close navigation'),
    control('Hidden at this width', 'display-none'),
    control('Kolkata'),
    control('About this selection'),
    control('WorldRiskReport 2026', 'closed-details'),
    control('CC BY 4.0', 'closed-details'),
  ];
  const trap = focusableControls(container(drawer));
  assert.equal(labels(trap)[0], 'StormSignal home');
  assert.equal(labels(trap).at(-1), 'About this selection');
  assert.deepEqual(labels(trap), [
    'StormSignal home',
    'Close navigation',
    'Kolkata',
    'About this selection',
  ]);
});

test('an open details adds its links, and older browsers fall back to layout boxes', () => {
  const open = [control('StormSignal home'), control('About this selection'), control('CC BY 4.0')];
  assert.equal(labels(focusableControls(container(open))).at(-1), 'CC BY 4.0');
  // Without checkVisibility, closed details contents have no layout box in those browsers.
  const older = [control('StormSignal home'), control('About this selection')].concat(
    control('CC BY 4.0', 'display-none'),
  );
  for (const item of older) delete (item as Partial<Control>).checkVisibility;
  assert.deepEqual(labels(focusableControls(container(older))), [
    'StormSignal home',
    'About this selection',
  ]);
});
