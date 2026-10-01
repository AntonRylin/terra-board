import type { CanvasObject } from '../model';
import { rotatePoint } from './transform.ts';

export type Corner = 'nw' | 'ne' | 'sw' | 'se';
export const corners: Corner[] = ['nw', 'ne', 'sw', 'se'];
export type ResizeHandle = Corner | 'n' | 'e' | 's' | 'w';
export const resizeHandles: ResizeHandle[] = [...corners, 'n', 'e', 's', 'w'];
export function handlePoint(o: CanvasObject, handle: ResizeHandle) {
  return {
    x: handle.includes('w') ? 0 : handle.includes('e') ? o.width : o.width / 2,
    y: handle.includes('n') ? 0 : handle.includes('s') ? o.height : o.height / 2,
  };
}

export function resizeObject(
  o: CanvasObject,
  corner: ResizeHandle,
  dx: number,
  dy: number,
  free: boolean,
) {
  const west = corner.includes('w'),
    north = corner.includes('n');
  const edge = corner.length === 1;
  const local = rotatePoint({ x: dx, y: dy }, -(o.rotation || 0));
  dx = local.x;
  dy = local.y;
  const dw = west ? -dx : dx,
    dh = north ? -dy : dy;
  let width: number,
    height: number,
    fontSize = o.fontSize;
  if (!edge && (o.type === 'text' || (['image', 'video'].includes(o.type) && !free))) {
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
    width = edge && !/[ew]/.test(corner) ? o.width : Math.max(20, Math.min(1e6, o.width + dw));
    height = edge && !/[ns]/.test(corner) ? o.height : Math.max(20, Math.min(1e6, o.height + dh));
  }
  const shift = rotatePoint(
    { x: (width - o.width) * (west ? -0.5 : 0.5), y: (height - o.height) * (north ? -0.5 : 0.5) },
    o.rotation || 0,
  );
  return {
    ...o,
    x: o.x + o.width / 2 + shift.x - width / 2,
    y: o.y + o.height / 2 + shift.y - height / 2,
    width,
    height,
    fontSize,
    ...(edge && o.type === 'text' ? { textBox: true } : {}),
  };
}
