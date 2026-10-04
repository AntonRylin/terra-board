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

// Solve against the resulting geometry, not the mouse position: corner resizing
// may preserve proportions, and rotated handles move along a different axis.
export function snapResize(
  raw: Point,
  targets: SnapTargets,
  zoom: number,
  resize: (delta: Point) => Bounds,
  previous: SnapState = {},
  bypass = false,
): { delta: Point; state: SnapState; guides: SnapGuide[] } {
  const state: SnapState = {},
    guides: SnapGuide[] = [];
  if (bypass) return { delta: raw, state, guides };
  const box = resize(raw),
    step = 1 / zoom;
  const alongX = resize({ x: raw.x + step, y: raw.y });
  const alongY = resize({ x: raw.x, y: raw.y + step });
  type Candidate = {
    axis: Axis;
    source: number;
    target: number;
    gx: number;
    gy: number;
    error: number;
    cost: number;
    held: boolean;
  };
  const candidates: Candidate[] = [];
  for (const axis of ['x', 'y'] as const) {
    let best: Candidate | undefined;
    const values = anchors(box, axis),
      xValues = anchors(alongX, axis),
      yValues = anchors(alongY, axis);
    for (const source of [0, 2, 1]) {
      const gx = (xValues[source] - values[source]) / step;
      const gy = (yValues[source] - values[source]) / step;
      const norm = gx * gx + gy * gy;
      if (norm < 1e-10) continue; // Fixed edges and size limits cannot snap.
      const entries = targets[axis],
        i = lowerBound(entries, values[source]);
      const held = previous[axis];
      const choices = [
        entries[i]?.at,
        entries[i - 1]?.at,
        held?.source === source ? held.target : undefined,
      ];
      for (const target of choices) {
        if (target === undefined) continue;
        const isHeld = held?.source === source && held.target === target;
        const error = target - values[source];
        if (Math.abs(error) > (isHeld ? 10 : 6) / zoom) continue;
        const candidate = {
          axis,
          source,
          target,
          gx,
          gy,
          error,
          cost: Math.abs(error) / Math.sqrt(norm),
          held: isHeld,
        };
        if (
          !best ||
          (candidate.held && !best.held) ||
          (candidate.held === best.held && candidate.cost < best.cost - 1e-8)
        )
          best = candidate;
      }
    }
    if (best) candidates.push(best);
  }
  if (!candidates.length) return { delta: raw, state, guides };
  candidates.sort((a, b) => Number(b.held) - Number(a.held) || a.cost - b.cost);
  const matches = (b: Bounds, c: Candidate) =>
    Math.abs(anchors(b, c.axis)[c.source] - c.target) < 1e-5 / zoom;
  let delta = { ...raw };
  const [first, second] = candidates;
  let both = false;
  if (second) {
    const det = first.gx * second.gy - first.gy * second.gx;
    if (Math.abs(det) > 1e-8) {
      const dx = (first.error * second.gy - first.gy * second.error) / det;
      const dy = (first.gx * second.error - first.error * second.gx) / det;
      const trial = { x: raw.x + dx, y: raw.y + dy };
      if (Math.hypot(dx, dy) <= 20 / zoom) {
        const b = resize(trial);
        if (candidates.every((c) => matches(b, c))) {
          delta = trial;
          both = true;
        }
      }
    }
  }
  if (!both) {
    for (const c of candidates) {
      const norm = c.gx * c.gx + c.gy * c.gy;
      const trial = { x: raw.x + (c.gx * c.error) / norm, y: raw.y + (c.gy * c.error) / norm };
      if (Math.hypot(trial.x - raw.x, trial.y - raw.y) <= 20 / zoom && matches(resize(trial), c)) {
        delta = trial;
        break;
      }
    }
  }
  const resized = resize(delta);
  for (const c of candidates) {
    if (!matches(resized, c)) continue;
    state[c.axis] = { source: c.source, target: c.target };
    const entry = targets[c.axis][lowerBound(targets[c.axis], c.target)];
    if (!entry || entry.at !== c.target) continue;
    const from = c.axis === 'x' ? resized.y : resized.x;
    const to = from + (c.axis === 'x' ? resized.height : resized.width);
    guides.push({
      axis: c.axis,
      at: c.target,
      from: Math.min(from, entry.from),
      to: Math.max(to, entry.to),
    });
  }
  return { delta, state, guides };
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
