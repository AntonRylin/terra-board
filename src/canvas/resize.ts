import type { Bounds } from './geometry';
import type { CanvasObject } from '../model';
import { rotatePoint } from './transform.ts';
import { listLayout } from './list-layout.ts';

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
  if (
    !edge &&
    (o.type === 'text' || (['image', 'video', 'document', 'list'].includes(o.type) && !free))
  ) {
    // Project the pointer onto the original diagonal, so either axis scales naturally.
    const requested = 1 + (dw * o.width + dh * o.height) / (o.width ** 2 + o.height ** 2);
    const font = o.fontSize || 18;
    const minimum =
      o.type === 'text'
        ? Math.max(8 / font, 1 / o.width, 1 / o.height)
        : o.type === 'list'
          ? 240 / o.width
          : Math.min(1, Math.max(20 / o.width, 20 / o.height));
    const maximum = Math.min(
      1e6 / o.width,
      1e6 / o.height,
      o.type === 'text' ? 300 / font : Infinity,
      o.type === 'list' ? listLayout(o).maximumWidth / o.width : Infinity,
    );
    const scale = Math.max(minimum, Math.min(maximum, requested));
    width = Math.max(1, Math.min(1e6, o.width * scale));
    height = Math.max(1, Math.min(1e6, o.height * scale));
    if (o.type === 'text') fontSize = Math.max(8, Math.min(300, font * scale));
  } else {
    width = edge && !/[ew]/.test(corner) ? o.width : Math.max(20, Math.min(1e6, o.width + dw));
    height = edge && !/[ns]/.test(corner) ? o.height : Math.max(20, Math.min(1e6, o.height + dh));
  }
  if (o.type === 'list') {
    const layout = listLayout(o);
    width = Math.min(layout.maximumWidth, Math.max(240, width));
    height = Math.max(layout.minimumHeight * (width / o.width), height);
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

// One common factor preserves the layout, including rotated objects and frame contents.
export function resizeSelection(
  objects: CanvasObject[],
  bounds: Bounds,
  corner: Corner,
  dx: number,
  dy: number,
) {
  const west = corner.includes('w'),
    north = corner.includes('n');
  const anchor = {
    x: bounds.x + (west ? bounds.width : 0),
    y: bounds.y + (north ? bounds.height : 0),
  };
  const requested =
    1 +
    ((west ? -dx : dx) * bounds.width + (north ? -dy : dy) * bounds.height) /
      Math.max(1, bounds.width ** 2 + bounds.height ** 2);
  const font = (o: CanvasObject) =>
    ['text', 'note', 'rect', 'ellipse', 'frame', 'arrow'].includes(o.type)
      ? o.fontSize || (o.type === 'note' ? 21 : o.type === 'frame' ? 14 : 18)
      : undefined;
  let minimum = 0,
    maximum = Infinity;
  for (const o of objects) {
    const size = font(o);
    minimum = Math.max(
      minimum,
      o.type === 'arrow' ? 0 : 1 / o.width,
      o.type === 'arrow' ? 0 : 1 / o.height,
      size ? 8 / size : 0,
      o.type === 'list' ? 240 / o.width : 0,
    );
    maximum = Math.min(
      maximum,
      1e6 / o.width,
      1e6 / o.height,
      size ? 300 / size : Infinity,
      o.type === 'list' ? listLayout(o).maximumWidth / o.width : Infinity,
    );
  }
  const scale = Math.max(minimum, Math.min(maximum, requested));
  return objects.map((o) => ({
    ...o,
    x: anchor.x + (o.x - anchor.x) * scale,
    y: anchor.y + (o.y - anchor.y) * scale,
    width: Math.max(1, o.width * scale),
    height: Math.max(1, o.height * scale),
    ...(font(o) ? { fontSize: Math.max(8, Math.min(300, font(o)! * scale)) } : {}),
    ...(o.arrow
      ? {
          arrow: {
            ...o.arrow,
            points: o.arrow.points.map((p) => ({
              x: (p.x * o.width * scale) / Math.max(1, o.width * scale),
              y: (p.y * o.height * scale) / Math.max(1, o.height * scale),
            })),
            thickness: Math.max(0.5, Math.min(40, o.arrow.thickness * scale)),
          },
        }
      : {}),
    ...(o.linkPreviewHeight ? { linkPreviewHeight: o.linkPreviewHeight * scale } : {}),
  }));
}
