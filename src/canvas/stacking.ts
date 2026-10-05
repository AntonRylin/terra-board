import type { CanvasObject, Edit } from '../model';
import { containsObject, localToWorld } from './transform.ts';

/** Strict rectangle intersection in board space; touching edges do not overlap. */
export function objectsOverlap(a: CanvasObject, b: CanvasObject): boolean {
  const corners = (o: CanvasObject) =>
    [
      { x: 0, y: 0 },
      { x: o.width, y: 0 },
      { x: o.width, y: o.height },
      { x: 0, y: o.height },
    ].map((p) => localToWorld(o, p));
  const first = corners(a),
    second = corners(b);
  for (const points of [first, second]) {
    for (let i = 0; i < 2; i++) {
      const dx = points[i + 1].x - points[i].x;
      const dy = points[i + 1].y - points[i].y;
      const length = Math.hypot(dx, dy);
      if (!length) return false;
      const project = (p: { x: number; y: number }) => (-dy * p.x + dx * p.y) / length;
      const p = first.map(project),
        q = second.map(project);
      if (
        Math.min(Math.max(...p), Math.max(...q)) - Math.max(Math.min(...p), Math.min(...q)) <=
        1e-7
      )
        return false;
    }
  }
  return true;
}

type Hierarchy = {
  parent: Map<string, string | null>;
  children: Map<string | null, CanvasObject[]>;
};

/** Infer frame ownership from placement and the existing stack, before reordering. */
export function stackingHierarchy(all: CanvasObject[]): Hierarchy {
  const sorted = [...all].sort((a, b) => a.z - b.z);
  const rank = new Map(sorted.map((o, i) => [o.id, i]));
  const frames = sorted.filter((o) => o.type === 'frame');
  const containers = frames.filter((o) => !o.gallery && !o.pdfComposer);
  const frameIds = new Set(frames.map((o) => o.id));
  const parent = new Map<string, string | null>();
  const children = new Map<string | null, CanvasObject[]>();
  for (const o of sorted) {
    let owner: string | null = null;
    if (o.galleryId && frameIds.has(o.galleryId)) owner = o.galleryId;
    else {
      const candidates = containers.filter(
        (frame) =>
          frame.id !== o.id &&
          containsObject(frame, o) &&
          (o.type !== 'frame' || !containsObject(o, frame)),
      );
      // Prefer the deepest enclosing frame. Overlapping peer frames are resolved
      // by the nearest frame below this item, so an overlying frame cannot steal it.
      const deepest = candidates.filter(
        (frame) =>
          !candidates.some(
            (other) =>
              other.id !== frame.id &&
              containsObject(frame, other) &&
              !containsObject(other, frame),
          ),
      );
      const below = deepest.filter((frame) => rank.get(frame.id)! < rank.get(o.id)!);
      owner = (below.at(-1) || deepest[0])?.id || null;
    }
    parent.set(o.id, owner);
    const siblings = children.get(owner) || [];
    siblings.push(o);
    children.set(owner, siblings);
  }
  return { parent, children };
}

export function stackingOverlap(
  selected: CanvasObject,
  other: CanvasObject,
  allOrHierarchy: CanvasObject[] | Hierarchy = [selected, other],
): boolean {
  if (selected.id === other.id) return false;
  const hierarchy = Array.isArray(allOrHierarchy)
    ? stackingHierarchy(allOrHierarchy)
    : allOrHierarchy;
  if (hierarchy.parent.get(selected.id) !== hierarchy.parent.get(other.id)) return false;
  if (selected.type === 'frame' && other.type !== 'frame') return false;
  return objectsOverlap(selected, other);
}

export function stackingSelection(all: CanvasObject[], selected: CanvasObject[]): CanvasObject[] {
  const { children } = stackingHierarchy(all);
  const members = new Map<string, CanvasObject>();
  const include = (o: CanvasObject) => {
    if (members.has(o.id)) return;
    members.set(o.id, o);
    for (const child of children.get(o.id) || []) include(child);
  };
  for (const o of selected) include(o);
  return [...members.values()];
}

export function bringToFrontEdit(all: CanvasObject[], selected: CanvasObject[]): Edit {
  if (!selected.length) return { upserts: [], deleted: [] };
  const { parent, children } = stackingHierarchy(all);
  const ids = new Set(selected.map((o) => o.id));
  // A selected descendant travels with its selected ancestor; it must not also
  // change its position within that ancestor's contents.
  const roots = new Set(
    selected
      .filter((o) => {
        let ancestor = parent.get(o.id);
        while (ancestor) {
          if (ids.has(ancestor)) return false;
          ancestor = parent.get(ancestor);
        }
        return true;
      })
      .map((o) => o.id),
  );
  for (const [owner, siblings] of children) {
    if (siblings.some((o) => roots.has(o.id)))
      children.set(owner, [
        ...siblings.filter((o) => !roots.has(o.id)),
        ...siblings.filter((o) => roots.has(o.id)),
      ]);
  }
  const ordered: CanvasObject[] = [];
  const append = (owner: string | null) => {
    for (const o of children.get(owner) || []) {
      ordered.push(o);
      append(o.id);
    }
  };
  append(null);
  // Keep existing z values wherever possible. Bump later siblings as necessary
  // so no descendant can cross the next frame's complete subtree.
  let previous = -Infinity;
  let next = ordered.map((o) => {
    const z = Math.max(o.z, previous + 1);
    previous = z;
    return z === o.z ? o : { ...o, z };
  });
  if (previous > 1e7) next = ordered.map((o, i) => ({ ...o, z: i }));
  return { upserts: next.filter((o, i) => o.z !== ordered[i].z), deleted: [] };
}
