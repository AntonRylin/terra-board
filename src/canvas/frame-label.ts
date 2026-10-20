import type { CanvasObject } from '../model';
import { textLayout } from './text-layout';
import { textPlacement } from './text-alignment';
import { localToWorld, objectBounds } from './transform';
import { highlightSize } from './highlight';

export function frameLabel(o: CanvasObject, zoom?: number) {
  const { appearance, metrics, rich } = textLayout(
    o,
    o.type === 'image'
      ? o.imageTitle || ''
      : o.type === 'document'
        ? o.documentTitle || ''
        : o.text || 'Untitled frame',
    zoom,
  );
  return {
    ...textPlacement(o, appearance, metrics.lines.length, rich ? metrics.height : undefined),
    width: Math.min(o.width, Math.max(32, metrics.maxLineWidth)),
  };
}

export function hasExternalLabel(o: CanvasObject) {
  return (
    o.type === 'frame' ||
    (o.type === 'image' && !!o.imageTitle?.trim()) ||
    (o.type === 'document' && !!o.documentTitle?.trim())
  );
}

export function arrowLabelObject(o: CanvasObject): CanvasObject {
  const label: CanvasObject = {
    ...o,
    type: 'text',
    fontSize: o.fontSize || 18,
    textBox: false,
    centerX: true,
    centerY: true,
  };
  const { metrics, appearance } = textLayout(label);
  return {
    ...label,
    width: Math.max(32, metrics.width + 8),
    height: Math.max(appearance.lineHeight, metrics.height) + 4,
  };
}

// Include the external name in culling and pointer queries, but keep resize
// handles on the frame body. Rotated labels use the same local coordinates.
// What a picture of an object covers: its name outside and a note's shadow included.
export function pictureBounds(o: CanvasObject) {
  const b = visualBounds(o);
  const pad = o.type === 'note' ? Math.min(o.width, o.height) * 0.08 : 2;
  return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
}
export function visualBounds(o: CanvasObject, editingTitle = false, zoom?: number) {
  if (o.type === 'arrow') {
    const b = objectBounds(o),
      label = o.text ? arrowLabelObject(o) : null,
      pad = Math.max(
        24,
        (o.arrow?.thickness || 3) * 5,
        label ? Math.max(label.width, label.height) / 2 + 8 : 0,
      );
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
  }
  if (o.type === 'highlight') {
    const b = objectBounds(o),
      pad = highlightSize(o) / 2;
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
  }
  if (!hasExternalLabel(o) && !(editingTitle && (o.type === 'image' || o.type === 'document')))
    return objectBounds(o);
  const top = frameLabel(o, zoom).top;
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

export function hitsFrameLabel(o: CanvasObject, q: { x: number; y: number }, zoom?: number) {
  if (!hasExternalLabel(o)) return false;
  const label = frameLabel(o, zoom);
  return q.x >= 0 && q.x <= label.width && q.y >= label.top && q.y <= label.top + label.height;
}
