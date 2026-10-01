import type { CanvasObject, ArrowStyle } from '../model';
import type { Point } from './geometry';

export const defaultArrow: ArrowStyle = {
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  line: 'curve',
  start: 'none',
  end: 'arrow',
  dash: 'solid',
  thickness: 3,
};
export const arrowStyle = (o: CanvasObject): ArrowStyle => o.arrow || defaultArrow;
export const arrowPoints = (o: CanvasObject) =>
  arrowStyle(o).points.map((p) => ({ x: p.x * o.width, y: p.y * o.height }));
export function arrowFromPoints(o: CanvasObject, points: Point[]): CanvasObject {
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
    arrow: {
      ...arrowStyle(o),
      points: points.map((p) => ({ x: (p.x - x) / width, y: (p.y - y) / height })),
    },
  };
}
function segment(points: Point[], index: number, line: ArrowStyle['line']): Point[] {
  const a = points[index],
    b = points[index + 1];
  if (line === 'straight') return [a, b];
  const mid = (a.x + b.x) / 2;
  if (line === 'elbow') return [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b];
  // Monotone Hermite tangents follow neighboring knots without overshooting
  // their bounds. Endpoints follow the terminal segment, not a fixed axis.
  const tangent = (i: number, axis: 'x' | 'y') => {
    if (i === 0) return points[1][axis] - points[0][axis];
    if (i === points.length - 1) return points[i][axis] - points[i - 1][axis];
    const before = points[i][axis] - points[i - 1][axis],
      after = points[i + 1][axis] - points[i][axis];
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  };
  const c = { x: a.x + tangent(index, 'x') / 3, y: a.y + tangent(index, 'y') / 3 },
    d = { x: b.x - tangent(index + 1, 'x') / 3, y: b.y - tangent(index + 1, 'y') / 3 };
  return Array.from({ length: 25 }, (_, i) => {
    const t = i / 24,
      u = 1 - t;
    return {
      x: u * u * u * a.x + 3 * u * u * t * c.x + 3 * u * t * t * d.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c.y + 3 * u * t * t * d.y + t * t * t * b.y,
    };
  });
}
export function arrowPath(o: CanvasObject): Point[] {
  const points = arrowPoints(o),
    line = arrowStyle(o).line;
  return points.flatMap((p, i) => (i ? segment(points, i - 1, line).slice(1) : [p]));
}
export function arrowHandles(o: CanvasObject) {
  const points = arrowPoints(o);
  return points.flatMap((p, i) => {
    const knot = { ...p, index: i, insert: false };
    if (i === points.length - 1 || points.length >= 32) return [knot];
    const path = segment(points, i, arrowStyle(o).line),
      middle =
        arrowStyle(o).line === 'curve'
          ? path[12]
          : {
              x: (p.x + points[i + 1].x) / 2,
              y: (p.y + points[i + 1].y) / 2,
            };
    return [knot, { ...middle, index: i + 1, insert: true }];
  });
}
export function hitsArrow(o: CanvasObject, q: Point, tolerance: number) {
  const p = arrowPath(o);
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1],
      b = p[i],
      dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
    );
    if (
      Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t) <=
      tolerance + arrowStyle(o).thickness / 2
    )
      return true;
  }
  return false;
}
export function arrowLabelPoint(o: CanvasObject) {
  const p = arrowPath(o),
    lengths = p.slice(1).map((b, i) => Math.hypot(b.x - p[i].x, b.y - p[i].y));
  let remaining = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) {
      const t = remaining / (lengths[i] || 1);
      return { x: p[i].x + (p[i + 1].x - p[i].x) * t, y: p[i].y + (p[i + 1].y - p[i].y) * t };
    }
    remaining -= lengths[i];
  }
  return p[0];
}
