import type { CanvasObject } from '../model';
import { textLayout } from './text-layout';
import { textPlacement } from './text-alignment';
import { localToWorld, objectBounds } from './transform';

export function frameLabel(o: CanvasObject) {
  const { appearance, metrics } = textLayout(
    o,
    o.type === 'image' ? o.imageTitle || '' : o.text || 'Untitled frame',
  );
  return {
    ...textPlacement(o, appearance, metrics.lines.length),
    width: Math.min(o.width, Math.max(32, metrics.maxLineWidth)),
  };
}

export function hasExternalLabel(o: CanvasObject) {
  return o.type === 'frame' || (o.type === 'image' && !!o.imageTitle?.trim());
}

// Include the external name in culling and pointer queries, but keep resize
// handles on the frame body. Rotated labels use the same local coordinates.
export function visualBounds(o: CanvasObject, editingTitle = false) {
  if (o.type === 'arrow') {
    const b = objectBounds(o),
      pad = Math.max(24, (o.arrow?.thickness || 3) * 5, o.text ? 140 : 0);
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
  }
  if (!hasExternalLabel(o) && !(editingTitle && o.type === 'image')) return objectBounds(o);
  const top = frameLabel(o).top;
  const points = [
    { x: 0, y: top },
    { x: o.width, y: top },
    { x: o.width, y: o.height },
    { x: 0, y: o.height },
  ].map((p) => localToWorld(o, p));
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p.x)) - x,
    height: Math.max(...points.map((p) => p.y)) - y,
  };
}

export function hitsFrameLabel(o: CanvasObject, q: { x: number; y: number }) {
  if (!hasExternalLabel(o)) return false;
  const label = frameLabel(o);
  return q.x >= 0 && q.x <= label.width && q.y >= label.top && q.y <= label.top + label.height;
}
