import type { Bounds, Point } from './geometry';

type Axis = 'x' | 'y';
type Anchor = { at: number; from: number; to: number };
export type SnapTargets = Record<Axis, Anchor[]>;
export type SnapState = Partial<Record<Axis, { source: number; target: number }>>;
export type SnapGuide = Anchor & { axis: Axis };
const anchors = (b: Bounds, axis: Axis) => {
  const size = axis === 'x' ? b.width : b.height;
  return [b[axis], b[axis] + size / 2, b[axis] + size];
};
export function snapTargets(boxes: Bounds[]): SnapTargets {
  const result: SnapTargets = { x: [], y: [] };
  for (const axis of ['x', 'y'] as const) {
    const merged = new Map<number, Anchor>();
    for (const box of boxes) {
      const from = axis === 'x' ? box.y : box.x,
        to = from + (axis === 'x' ? box.height : box.width);
      for (const at of anchors(box, axis)) {
        const entry = merged.get(at);
        if (entry) {
          entry.from = Math.min(entry.from, from);
          entry.to = Math.max(entry.to, to);
        } else merged.set(at, { at, from, to });
      }
    }
    result[axis] = [...merged.values()].sort((a, b) => a.at - b.at);
  }
  return result;
}
function lowerBound(entries: Anchor[], at: number) {
  let lo = 0,
    hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].at < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function snapMove(
  box: Bounds,
  raw: Point,
  targets: SnapTargets,
  zoom: number,
  previous: SnapState = {},
  bypass = false,
): { delta: Point; state: SnapState; guides: SnapGuide[] } {
  const delta = { ...raw },
    state: SnapState = {},
    guides: SnapGuide[] = [];
  if (bypass) return { delta, state, guides };
  for (const axis of ['x', 'y'] as const) {
    const values = anchors(box, axis),
      entries = targets[axis],
      held = previous[axis];
    if (held && Math.abs(held.target - values[held.source] - raw[axis]) <= 10 / zoom)
      state[axis] = held;
    else {
      let best = 6 / zoom;
      // Prefer edges over centers for exact ties; nearest distance otherwise wins.
      for (const source of [0, 2, 1]) {
        const at = values[source] + raw[axis],
          i = lowerBound(entries, at);
        for (const entry of [entries[i], entries[i - 1]]) {
          if (!entry) continue;
          const distance = Math.abs(entry.at - at);
          if (distance <= best && (!state[axis] || distance < best)) {
            best = distance;
            state[axis] = { source, target: entry.at };
          }
        }
      }
    }
    const snap = state[axis];
    if (snap) delta[axis] = snap.target - values[snap.source];
  }
  const moved = { ...box, x: box.x + delta.x, y: box.y + delta.y };
  for (const axis of ['x', 'y'] as const) {
    if (!state[axis]) continue;
    const entries = targets[axis];
    for (const at of anchors(moved, axis)) {
      const i = lowerBound(entries, at - 1e-6 / zoom),
        entry = entries[i];
      if (!entry || Math.abs(entry.at - at) > 1e-6 / zoom) continue;
      const from = axis === 'x' ? moved.y : moved.x,
        to = from + (axis === 'x' ? moved.height : moved.width);
      guides.push({
        axis,
        at: entry.at,
        from: Math.min(from, entry.from),
        to: Math.max(to, entry.to),
      });
    }
  }
  return { delta, state, guides };
}
