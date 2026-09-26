/** Scroll only far enough to show the focused control, including its label. */
export function focusScrollOffset(scrollY: number, y: number, height: number, top: number, viewportHeight: number, inset: number): number {
  const visibleTop = top + inset;
  const visibleBottom = top + viewportHeight - inset;
  // Oversized controls align to the top instead of oscillating between both edges.
  if (height > viewportHeight - 2 * inset || y < visibleTop) return Math.max(0, scrollY + y - visibleTop);
  if (y + height > visibleBottom) return Math.max(0, scrollY + y + height - visibleBottom);
  return scrollY;
}
