/**
 * Controls in a container that keyboard focus can reach, in document order. A layout box is
 * not enough: Chrome hides the contents of a closed <details> with content-visibility: hidden,
 * so its links still have client rects but cannot take focus. checkVisibility() excludes them.
 */
export function focusableControls(container: ParentNode): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary'),
  ].filter(
    (element) =>
      element.getClientRects().length > 0 &&
      (typeof element.checkVisibility !== 'function' || element.checkVisibility()),
  );
}
