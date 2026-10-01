import type { Bounds } from './geometry';

export function selectionToolsPosition(
  bounds: Bounds,
  viewport: { width: number; height: number },
  tools: { width: number; height: number },
) {
  const margin = 10,
    gap = 14;
  const left = Math.max(
    margin,
    Math.min(viewport.width - tools.width - margin, bounds.x + bounds.width / 2 - tools.width / 2),
  );
  let top = bounds.y - tools.height - gap;
  if (top < margin) {
    const below = bounds.y + bounds.height + gap;
    // For a selection taller than the viewport, keep its controls near the visible top.
    top = below + tools.height <= viewport.height - margin ? below : margin;
  }
  return { left, top: Math.max(margin, Math.min(viewport.height - tools.height - margin, top)) };
}
