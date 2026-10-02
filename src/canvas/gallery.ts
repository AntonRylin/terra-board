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
  const cells = sized.map((o, index) => ({
    ...o,
    row: o.image.galleryRow ?? (below ? index : 0),
    column: o.image.galleryColumn ?? (below ? 0 : index),
  }));
  const rowCells = new Map<number, typeof cells>();
  const columnWidths = new Map<number, number>();
  for (const cell of cells) {
    const list = rowCells.get(cell.row) || [];
    list.push(cell);
    rowCells.set(cell.row, list);
    columnWidths.set(cell.column, Math.max(columnWidths.get(cell.column) || 0, cell.visual.width));
  }
  const rows = [...rowCells.keys()].sort((a, b) => a - b);
  const columns = [...columnWidths.keys()].sort((a, b) => a - b);
  const rowIndices = new Map(rows.map((r, i) => [r, i])),
    columnIndices = new Map(columns.map((c, i) => [c, i]));
  const rowOffsets = new Map<number, number>(),
    columnOffsets = new Map<number, number>();
  const rowInsets = new Map<number, number>();
  for (const row of rows) {
    const members = rowCells.get(row)!;
    const inset = Math.max(0, ...members.map((o) => o.body.y - o.visual.y));
    rowInsets.set(row, inset);
    rowOffsets.set(row, cursor);
    cursor +=
      Math.max(...members.map((o) => inset - o.body.y + o.visual.y + o.visual.height)) + gap;
  }
  const height = rows.length
    ? cursor - gap + galleryPadding
    : below
      ? 180
      : size + galleryPadding * 2;
  cursor = galleryPadding;
  for (const column of columns) {
    columnOffsets.set(column, cursor);
    cursor += columnWidths.get(column)! + gap;
  }
  const width = columns.length
    ? cursor - gap + galleryPadding
    : below
      ? size + galleryPadding * 2
      : 180;
  const upserts = cells.map(({ image, width, height, visual, body, row, column }, index) => ({
    ...image,
    x: container.x + columnOffsets.get(column)! - visual.x,
    y: container.y + rowOffsets.get(row)! + rowInsets.get(row)! - body.y,
    width,
    height,
    z: Math.max(image.z, container.z + 1),
    galleryRow: rowIndices.get(row)!,
    galleryColumn: columnIndices.get(column)!,
    galleryIndex: index,
  }));
  return [{ ...container, rotation: 0, gallery: { ...settings, size }, width, height }, ...upserts];
}

export interface GalleryTarget {
  galleryId: string;
  anchorId?: string;
  direction?: 'right' | 'below';
}

// Main-axis insertion creates a journey step. Cross-axis insertion adds a variation
// in the same row/column, moving only that step's later variations.
export function insertGalleryImages(
  current: Map<string, CanvasObject>,
  incoming: CanvasObject[],
  target?: GalleryTarget | null,
): Edit {
  const parent = target && current.get(target.galleryId);
  if (!parent?.gallery) return { upserts: incoming, deleted: [] };
  const members = layoutGallery(parent, galleryMembers(parent.id, current.values()))
    .slice(1)
    .map((o) => ({
      ...current.get(o.id)!,
      galleryRow: o.galleryRow,
      galleryColumn: o.galleryColumn,
      galleryIndex: o.galleryIndex,
    }));
  const anchor = members.find((o) => o.id === target?.anchorId);
  const direction = (anchor && target?.direction) || parent.gallery.direction;
  const main = direction === parent.gallery.direction;
  const row = anchor
    ? anchor.galleryRow! + (direction === 'below' ? 1 : 0)
    : parent.gallery.direction === 'below'
      ? Math.max(-1, ...members.map((o) => o.galleryRow!)) + 1
      : 0;
  const column = anchor
    ? anchor.galleryColumn! + (direction === 'right' ? 1 : 0)
    : parent.gallery.direction === 'right'
      ? Math.max(-1, ...members.map((o) => o.galleryColumn!)) + 1
      : 0;
  const copiedGalleries = new Set(incoming.filter((o) => o.gallery).map((o) => o.id));
  const images = incoming.filter(
    (o) => o.type === 'image' && !copiedGalleries.has(o.galleryId || ''),
  );
  if (!images.length) return { upserts: incoming, deleted: [] };
  const moved = members
    .filter((o) =>
      direction === 'below'
        ? o.galleryRow! >= row && (main || o.galleryColumn === column)
        : o.galleryColumn! >= column && (main || o.galleryRow === row),
    )
    .map((o) => ({
      ...o,
      galleryRow: o.galleryRow! + (direction === 'below' ? images.length : 0),
      galleryColumn: o.galleryColumn! + (direction === 'right' ? images.length : 0),
    }));
  const offsets = new Map(images.map((o, i) => [o.id, i]));
  const index = Math.max(-1, ...members.map((o) => o.galleryIndex || 0)) + 1;
  return {
    upserts: [
      ...moved,
      ...incoming.map((o) =>
        offsets.has(o.id)
          ? {
              ...o,
              groupId: undefined,
              galleryId: parent.id,
              galleryIndex: index + offsets.get(o.id)!,
              galleryRow: row + (direction === 'below' ? offsets.get(o.id)! : 0),
              galleryColumn: column + (direction === 'right' ? offsets.get(o.id)! : 0),
            }
          : o,
      ),
    ],
    deleted: [],
  };
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
      if (o[cross] !== before[cross] && o.gallery.size === before.gallery.size) {
        const members = galleryMembers(o.id, current.values());
        const tracks = Math.max(
          1,
          new Set(
            members.map((image) =>
              cross === 'width' ? image.galleryColumn || 0 : image.galleryRow || 0,
            ),
          ).size,
        );
        o = {
          ...o,
          gallery: {
            ...o.gallery,
            size: Math.max(
              32,
              Math.min(8192, before.gallery.size + (o[cross] - before[cross]) / tracks),
            ),
          },
        };
      }
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
        o = {
          ...o,
          galleryId: undefined,
          galleryIndex: undefined,
          galleryRow: undefined,
          galleryColumn: undefined,
        };
    }
    changes.set(o.id, o);
    next.set(o.id, o);
  }
  for (const id of affected) {
    const parent = next.get(id),
      images = galleryMembers(id, next.values());
    if (parent?.gallery) {
      const previous = current.get(id);
      const ordered =
        previous?.gallery && previous.gallery.direction !== parent.gallery.direction
          ? layoutGallery(previous, images, bounds)
              .slice(1)
              .map((o) => ({ ...o, galleryRow: o.galleryColumn, galleryColumn: o.galleryRow }))
          : images;
      for (const o of layoutGallery(parent, ordered, bounds)) {
        if (changes.has(o.id) || JSON.stringify(o) !== JSON.stringify(current.get(o.id)))
          changes.set(o.id, o);
        next.set(o.id, o);
      }
    } else
      for (const o of images)
        changes.set(o.id, {
          ...o,
          galleryId: undefined,
          galleryIndex: undefined,
          galleryRow: undefined,
          galleryColumn: undefined,
        });
  }
  return {
    upserts: [...changes.values()].filter((o) => !edit.deleted.includes(o.id)),
    deleted: edit.deleted,
  };
}
