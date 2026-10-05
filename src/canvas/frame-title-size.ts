import type { CanvasObject } from '../model';

// These are display dimensions only; zoom never changes a saved title size.
export function frameTitleSize(
  o: Pick<CanvasObject, 'width' | 'height' | 'fontSize'>,
  zoom?: number,
) {
  const base = o.fontSize || 14;
  if (zoom === undefined) return { fontSize: base, labelGap: 8 };
  const z = Math.max(0.01, Math.min(8, zoom));
  const frameLimit = Math.min(o.width / 16, o.height / 12);
  const fontSize = Math.min(frameLimit, Math.max(base, 10 / z), 18 / z);
  return { fontSize, labelGap: Math.min(5 / z, fontSize * 0.4) };
}
