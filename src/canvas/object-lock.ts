import type { CanvasObject, Edit } from '../model';

// Check the whole transaction: partial gallery/group edits can corrupt layout.
export function editTouchesLocked(objects: Map<string, CanvasObject>, edit: Edit) {
  return (
    edit.deleted.some((id) => objects.get(id)?.locked) ||
    edit.upserts.some(
      (o) => objects.get(o.id)?.locked || (o.galleryId && objects.get(o.galleryId)?.locked),
    )
  );
}
