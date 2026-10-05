import type { CanvasObject } from '../model';
import type { Point } from './geometry';
import { worldToLocal } from './transform';
import { convertibleDocument } from './pdf-conversion-formats';

export function isPdfComposerInput(object: CanvasObject) {
  return (
    !!object.assetId &&
    (object.type === 'image' ||
      (object.type === 'document' && convertibleDocument(object.text || '', object.documentMime)))
  );
}

export function pdfComposerTargetAt(
  objects: CanvasObject[],
  point: Point,
  excluded: Set<string> = new Set(),
) {
  for (const object of [...objects].sort((a, b) => b.z - a.z)) {
    if (excluded.has(object.id)) continue;
    const local = worldToLocal(object, point);
    if (local.x < 0 || local.y < 0 || local.x > object.width || local.y > object.height) continue;
    if (object.locked) return null;
    if (object.pdfComposer || (object.type === 'document' && isPdfComposerInput(object)))
      return object;
    // Ordinary frames can contain PDF cards; solid foreground cards occlude them.
    if (object.type !== 'frame') return null;
  }
  return null;
}
