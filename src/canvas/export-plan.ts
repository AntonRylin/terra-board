import type { Camera, CanvasObject } from '../model';
import type { Bounds } from './geometry';
import { containsObject, objectBounds } from './transform.ts';
import { selectionWithGalleryImages } from './gallery.ts';

export type ExportScope = 'selection' | 'visible';
export type ExportQuality = 'full' | '2k' | '4k';
export function exportResolution(
  bounds: Pick<Bounds, 'width' | 'height'>,
  quality: ExportQuality,
  sourceScale = 1,
) {
  const requested =
    quality === 'full'
      ? Math.max(2, sourceScale)
      : (quality === '2k' ? 2048 : 4096) / Math.max(bounds.width, bounds.height);
  const scale = Math.min(
    requested,
    8192 / bounds.width,
    8192 / bounds.height,
    Math.sqrt(32_000_000 / (bounds.width * bounds.height)),
  );
  return {
    scale,
    width: Math.max(1, Math.floor(bounds.width * scale + 1e-7)),
    height: Math.max(1, Math.floor(bounds.height * scale + 1e-7)),
    limited: scale < requested,
  };
}
export function exportPlan(
  all: CanvasObject[],
  selected: string[],
  scope: ExportScope,
  camera: Camera,
  viewport: { width: number; height: number },
  getBounds = objectBounds,
) {
  let objects: CanvasObject[];
  let bounds: Bounds;
  if (scope === 'selection') {
    const ids = new Set(selected);
    // Normal frames own their contents by placement, just as when dragging them.
    // Galleries keep their explicit membership, including galleries inside frames.
    const frames = all.filter(
      (o) => ids.has(o.id) && o.type === 'frame' && !o.gallery && !o.pdfComposer && !o.frameLink,
    );
    objects = selectionWithGalleryImages(
      all.filter((o) => ids.has(o.id) || frames.some((frame) => containsObject(frame, o))),
      all,
    );
    if (!objects.length) throw Error('Select something to export.');
    const boxes = objects.map(getBounds);
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const b of boxes) {
      left = Math.min(left, b.x);
      top = Math.min(top, b.y);
      right = Math.max(right, b.x + b.width);
      bottom = Math.max(bottom, b.y + b.height);
    }
    bounds = { x: left, y: top, width: right - left, height: bottom - top };
  } else {
    bounds = {
      x: -camera.x / camera.zoom,
      y: -camera.y / camera.zoom,
      width: viewport.width / camera.zoom,
      height: viewport.height / camera.zoom,
    };
    objects = all.filter((o) => {
      const b = getBounds(o);
      return (
        b.x < bounds.x + bounds.width &&
        b.x + b.width > bounds.x &&
        b.y < bounds.y + bounds.height &&
        b.y + b.height > bounds.y
      );
    });
  }
  const baseScale = scope === 'visible' ? camera.zoom : 1;
  const scale = Math.min(
    baseScale,
    8192 / bounds.width,
    8192 / bounds.height,
    Math.sqrt(32_000_000 / (bounds.width * bounds.height)),
  );
  return {
    // Freeze the content before asynchronous rendering starts.
    objects: structuredClone(objects.sort((a, b) => a.z - b.z)),
    bounds,
    scale,
    width: Math.max(1, Math.floor(bounds.width * scale)),
    height: Math.max(1, Math.floor(bounds.height * scale)),
  };
}
export type ExportPlan = ReturnType<typeof exportPlan>;
