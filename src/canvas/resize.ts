import type { CanvasObject } from '../model';

export type Corner = 'nw' | 'ne' | 'sw' | 'se';
export const corners: Corner[] = ['nw', 'ne', 'sw', 'se'];

export function resizeObject(
  o: CanvasObject,
  corner: Corner,
  dx: number,
  dy: number,
  free: boolean,
) {
  const west = corner.includes('w'),
    north = corner.includes('n');
  const dw = west ? -dx : dx,
    dh = north ? -dy : dy;
  let width: number,
    height: number,
    fontSize = o.fontSize;
  if (o.type === 'text' || (['image', 'video'].includes(o.type) && !free)) {
    // Project the pointer onto the original diagonal, so either axis scales naturally.
    const requested = 1 + (dw * o.width + dh * o.height) / (o.width ** 2 + o.height ** 2);
    const font = o.fontSize || 18;
    const minimum =
      o.type === 'text'
        ? Math.max(8 / font, 1 / o.width, 1 / o.height)
        : Math.min(1, Math.max(20 / o.width, 20 / o.height));
    const maximum = Math.min(
      1e6 / o.width,
      1e6 / o.height,
      o.type === 'text' ? 300 / font : Infinity,
    );
    const scale = Math.max(minimum, Math.min(maximum, requested));
    width = Math.max(1, Math.min(1e6, o.width * scale));
    height = Math.max(1, Math.min(1e6, o.height * scale));
    if (o.type === 'text') fontSize = Math.max(8, Math.min(300, font * scale));
  } else {
    width = Math.max(20, Math.min(1e6, o.width + dw));
    height = Math.max(20, Math.min(1e6, o.height + dh));
  }
  return {
    ...o,
    x: west ? o.x + o.width - width : o.x,
    y: north ? o.y + o.height - height : o.y,
    width,
    height,
    fontSize,
  };
}
