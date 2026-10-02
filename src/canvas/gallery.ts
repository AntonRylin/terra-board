import type { CanvasObject, Edit } from '../model';
import { objectBounds } from './transform.ts';

export const galleryPadding = 16;
export const defaultGallery = { direction: 'below' as const, size: 400, gap: 12 };
export function galleryMembers(id: string, objects: Iterable<CanvasObject>) {
  return [...objects]
    .filter((o) => o.type === 'image' && o.galleryId === id)
    .sort(
      (a, b) =>
        (a.galleryIndex || 0) - (b.galleryIndex || 0) || a.z - b.z || a.id.localeCompare(b.id),
    );
}
export function selectionWithGalleryImages(selected: CanvasObject[], all: Iterable<CanvasObject>) {
  const ids = new Set(selected.filter((o) => o.gallery).map((o) => o.id));
  return [
    ...new Map(
      [...selected, ...[...all].filter((o) => o.galleryId && ids.has(o.galleryId))].map((o) => [
        o.id,
        o,
      ]),
    ).values(),
  ];
}
export function layoutGallery(
  container: CanvasObject,
  images: CanvasObject[],
  bounds = objectBounds,
) {
  const settings = container.gallery!;
  const below = settings.direction === 'below';
  const size = Math.max(32, Math.min(8192, settings.size));
  const gap = settings.gap;
  let cursor = galleryPadding;
  const sized = images.map((image) => {
    const before = objectBounds(image);
    const scale = size / (below ? before.width : before.height);
    const width = image.width * scale,
      height = image.height * scale;
    const resized = { ...image, x: 0, y: 0, width, height };
    return { image, width, height, visual: bounds(resized), body: objectBounds(resized) };
  });
  const rowInset = Math.max(0, ...sized.map((o) => o.body.y - o.visual.y));
  const upserts = sized.map(({ image, width, height, visual, body }) => {
    const x = container.x + (below ? galleryPadding : cursor) - visual.x;
    const y = container.y + (below ? cursor - visual.y : galleryPadding + rowInset - body.y);
    cursor += (below ? visual.height : visual.width) + gap;
    return { ...image, x, y, width, height, z: Math.max(image.z, container.z + 1) };
  });
  const length = images.length ? cursor - gap + galleryPadding : 180;
  const rowHeight = Math.max(
    size,
    ...sized.map((o) => rowInset - o.body.y + o.visual.y + o.visual.height),
  );
  return [
    {
      ...container,
      rotation: 0,
      gallery: { ...settings, size },
      width: below ? size + galleryPadding * 2 : length,
      height: below ? length : rowHeight + galleryPadding * 2,
    },
    ...upserts,
  ];
}

// Expand one user edit into one undoable layout transaction. Ordinary edits
// without gallery membership retain their existing path and cost.
export function galleryEdit(
  current: Map<string, CanvasObject>,
  edit: Edit,
  bounds = objectBounds,
): Edit {
  const affected = new Set<string>();
  const touch = (o?: CanvasObject) => {
    if (o?.gallery) affected.add(o.id);
    if (o?.galleryId) affected.add(o.galleryId);
  };
  for (const o of edit.upserts) {
    touch(o);
    touch(current.get(o.id));
  }
  for (const id of edit.deleted) touch(current.get(id));
  if (!affected.size) return edit;
  const changes = new Map(edit.upserts.map((o) => [o.id, o]));
  const next = new Map(current);
  for (const id of edit.deleted) next.delete(id);
  for (const input of edit.upserts) {
    let o = input;
    const before = current.get(o.id);
    if (o.gallery && before?.gallery && o.gallery.direction === before.gallery.direction) {
      const cross = o.gallery.direction === 'below' ? 'width' : 'height';
      if (o[cross] !== before[cross])
        o = {
          ...o,
          gallery: {
            ...o.gallery,
            size: Math.max(32, Math.min(8192, before.gallery.size + o[cross] - before[cross])),
          },
        };
    }
    // Pulling an image outside releases it. Moving the whole gallery keeps it.
    if (
      o.galleryId &&
      before?.galleryId === o.galleryId &&
      !changes.has(o.galleryId) &&
      (o.x !== before.x || o.y !== before.y)
    ) {
      const parent = next.get(o.galleryId),
        cx = o.x + o.width / 2,
        cy = o.y + o.height / 2;
      if (
        parent &&
        (cx < parent.x ||
          cy < parent.y ||
          cx > parent.x + parent.width ||
          cy > parent.y + parent.height)
      )
        o = { ...o, galleryId: undefined, galleryIndex: undefined };
    }
    changes.set(o.id, o);
    next.set(o.id, o);
  }
  for (const id of affected) {
    const parent = next.get(id),
      images = galleryMembers(id, next.values());
    if (parent?.gallery) {
      for (const o of layoutGallery(parent, images, bounds)) {
        if (changes.has(o.id) || JSON.stringify(o) !== JSON.stringify(current.get(o.id)))
          changes.set(o.id, o);
        next.set(o.id, o);
      }
    } else
      for (const o of images)
        changes.set(o.id, { ...o, galleryId: undefined, galleryIndex: undefined });
  }
  return {
    upserts: [...changes.values()].filter((o) => !edit.deleted.includes(o.id)),
    deleted: edit.deleted,
  };
}
