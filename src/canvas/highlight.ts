import type { CanvasObject, HighlightStroke } from '../model';
import type { Point } from './geometry';

export const highlightColors = ['#ffe14d', '#9be564', '#6fd3ff', '#ff9ecb', '#ffad5c', '#c9a6ff'];
// Brush diameter in screen pixels: the marker feels the same at every zoom.
export const highlightSizeRange = { min: 4, max: 200 };
export const defaultHighlightStyle = { color: highlightColors[0], size: 22 };
export const highlightAlpha = 0.4;
export const highlightPointLimit = 2000;
export const clampHighlightSize = (size: number) =>
  Math.max(highlightSizeRange.min, Math.min(highlightSizeRange.max, Math.round(size)));
export function readHighlightStyle(value: unknown) {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    color:
      typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)
        ? raw.color
        : defaultHighlightStyle.color,
    size:
      typeof raw.size === 'number' && Number.isFinite(raw.size)
        ? clampHighlightSize(raw.size)
        : defaultHighlightStyle.size,
  };
}

const stroke = (o: CanvasObject): HighlightStroke =>
  o.highlight || {
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    size: 20,
  };
export const highlightSize = (o: CanvasObject) => stroke(o).size;
export const highlightPoints = (o: CanvasObject) =>
  stroke(o).points.map((p) => ({ x: p.x * o.width, y: p.y * o.height }));
export function highlightFromPoints(o: CanvasObject, points: Point[]): CanvasObject {
  // A single press is a dot; keep the two points every stroke needs.
  if (points.length === 1) points = [points[0], points[0]];
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  const width = Math.max(1, Math.max(...points.map((p) => p.x)) - x),
    height = Math.max(1, Math.max(...points.map((p) => p.y)) - y);
  return {
    ...o,
    x,
    y,
    width,
    height,
    rotation: 0,
    highlight: {
      size: stroke(o).size,
      points: points.map((p) => ({ x: (p.x - x) / width, y: (p.y - y) / height })),
    },
  };
}

function distanceToSegment(q: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t);
}
// Ramer-Douglas-Peucker, iterative so a long scribble cannot exhaust the stack.
// Gives up once more than `limit` points must stay: that is also its slow case.
function reduce(points: Point[], tolerance: number, limit: number) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const ranges = [[0, points.length - 1]];
  let kept = 2;
  while (ranges.length) {
    const [from, to] = ranges.pop()!;
    let index = -1,
      furthest = tolerance;
    for (let i = from + 1; i < to; i++) {
      const d = distanceToSegment(points[i], points[from], points[to]);
      if (d > furthest) {
        furthest = d;
        index = i;
      }
    }
    if (index !== -1) {
      if (++kept > limit) return null;
      keep[index] = 1;
      ranges.push([from, index], [index, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
const sample = (points: Point[], count: number) =>
  points.length <= count
    ? points
    : Array.from(
        { length: count },
        (_, i) => points[Math.round((i * (points.length - 1)) / (count - 1))],
      );
// Drop pointer samples the eye cannot tell apart. A stroke too intricate to store
// is thinned evenly instead, which keeps the work bounded on any input.
export function simplifyStroke(points: Point[], tolerance: number, limit = highlightPointLimit) {
  if (points.length < 3) return points;
  points = sample(points, limit * 4);
  return reduce(points, tolerance, limit) || sample(points, limit);
}
export function hitsHighlight(o: CanvasObject, q: Point, tolerance: number) {
  const p = highlightPoints(o),
    reach = tolerance + highlightSize(o) / 2;
  for (let i = 1; i < p.length; i++) if (distanceToSegment(q, p[i - 1], p[i]) <= reach) return true;
  return false;
}
// The inked area: the stroke's centre line grown by half the brush.
export function highlightBounds(o: CanvasObject) {
  const pad = highlightSize(o) / 2;
  return { x: o.x - pad, y: o.y - pad, width: o.width + pad * 2, height: o.height + pad * 2 };
}
