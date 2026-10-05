import type { CanvasObject } from '../model';

// These are display dimensions only; zoom never changes a saved title size.
export function frameTitleSize(
  o: Pick<CanvasObject, 'width' | 'height' | 'fontSize'>,
  zoom?: number,
) {
  const base = o.fontSize || 14;
  if (zoom === undefined) return { fontSize: base, labelGap: 8 };
  const z = Math.max(0.01, Math.min(8, zoom));
  const frameLimit = Math.max(base, Math.min(o.width / 8, o.height / 4));
  const fontSize = Math.min(frameLimit, Math.max(base, 12 / z), 28 / z);
  return { fontSize, labelGap: Math.min(8 / z, fontSize * 0.75) };
}
