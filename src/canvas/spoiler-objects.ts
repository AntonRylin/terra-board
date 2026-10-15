import type { CanvasObject } from '../model';
import { containsObject } from './transform.ts';

// Whole objects can be spoilers too. Media, documents, links and linked frames
// blur under drifting dust; plain frames and galleries hide what they hold and
// show dust across their body. Reveals use the same per-viewer state as text
// spoilers, stored under this region key.
export const wholeObject = -1;

const spoilerTypes = new Set(['image', 'video', 'document', 'link', 'frame']);

export function canBeSpoiler(o: CanvasObject) {
  return spoilerTypes.has(o.type);
}

export function isSpoiler(o: CanvasObject) {
  return !!o.spoiler && canBeSpoiler(o);
}

/** Frames whose spoiler hides the objects inside them rather than blurring itself. */
export function hidesContents(o: CanvasObject) {
  return o.type === 'frame' && !o.pdfComposer && !o.frameLink;
}

/** The hiding frame `o` sits inside of, above it, if any. */
export function concealedBy(o: CanvasObject, frames: readonly CanvasObject[]) {
  return frames.find(
    (frame) =>
      frame.id !== o.id &&
      (o.galleryId === frame.id || (frame.z < o.z && containsObject(frame, o))),
  );
}
