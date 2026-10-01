import type { Graphics } from 'pixi.js';
import type { CanvasObject, ArrowHead } from '../model';
import { arrowPath, arrowStyle } from './arrows.ts';
import type { Point } from './geometry';

export function drawArrow(g: Graphics, o: CanvasObject) {
  const path = arrowPath(o),
    style = arrowStyle(o),
    color = o.color || '#333333',
    width = style.thickness;
  // Keep dash geometry bounded even for exceptionally long board connectors.
  const total = path
    .slice(1)
    .reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);
  const size = Math.max(10, width * 4);
  const inset = (kind: ArrowHead) =>
    kind === 'none'
      ? 0
      : kind === 'open'
        ? width / 2
        : kind === 'circle'
          ? size * 0.48
          : kind === 'diamond'
            ? size
            : size * 0.6;
  // Stop the rounded shaft inside the marker. Drawing it to the pointed tip
  // makes its round cap poke through, especially on thick arrows.
  const start = inset(style.start),
    end = total - inset(style.end),
    points: Point[] = [];
  let distance = 0;
  for (let i = 1; i < path.length && end > start; i++) {
    const a = path[i - 1],
      b = path[i],
      length = Math.hypot(b.x - a.x, b.y - a.y);
    const from = Math.max(start, distance),
      to = Math.min(end, distance + length);
    if (length > 0 && to > from) {
      const at = (d: number) => ({
        x: a.x + ((b.x - a.x) * (d - distance)) / length,
        y: a.y + ((b.y - a.y) * (d - distance)) / length,
      });
      if (!points.length) points.push(at(from));
      points.push(at(to));
    }
    distance += length;
  }
  const unit = Math.max(width, total / 6000);
  const on = style.dash === 'dotted' ? unit * 0.1 : unit * 4,
    off = unit * 2.5;
  let phase = 0;
  if (style.dash === 'solid' && points.length) g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    if (style.dash === 'solid') {
      g.lineTo(b.x, b.y);
      continue;
    }
    let d = 0;
    while (d < length) {
      const drawing = phase < on,
        step = Math.min(length - d, (drawing ? on : on + off) - phase);
      if (drawing)
        g.moveTo(a.x + ((b.x - a.x) * d) / length, a.y + ((b.y - a.y) * d) / length).lineTo(
          a.x + ((b.x - a.x) * (d + step)) / length,
          a.y + ((b.y - a.y) * (d + step)) / length,
        );
      d += step;
      phase = (phase + step) % (on + off);
      if (step < 1e-8) {
        phase = 0;
        break;
      }
    }
  }
  g.stroke({ color, width, cap: 'round', join: 'round' });
  function head(p: Point, from: Point, kind: ArrowHead) {
    if (kind === 'none') return;
    const length = Math.hypot(p.x - from.x, p.y - from.y) || 1,
      ux = (p.x - from.x) / length,
      uy = (p.y - from.y) / length;
    const half = size * 0.48;
    const a = { x: p.x - ux * size - uy * half, y: p.y - uy * size + ux * half },
      b = { x: p.x - ux * size + uy * half, y: p.y - uy * size - ux * half };
    if (kind === 'circle') {
      g.circle(p.x - ux * half, p.y - uy * half, half).fill(color);
      return;
    }
    if (kind === 'open') {
      g.moveTo(a.x, a.y)
        .lineTo(p.x, p.y)
        .lineTo(b.x, b.y)
        .stroke({ color, width, cap: 'round', join: 'round' });
      return;
    }
    const poly =
      kind === 'diamond'
        ? [p.x, p.y, a.x, a.y, p.x - ux * size * 2, p.y - uy * size * 2, b.x, b.y]
        : kind === 'arrow'
          ? [p.x, p.y, a.x, a.y, p.x - ux * size * 0.7, p.y - uy * size * 0.7, b.x, b.y]
          : [p.x, p.y, a.x, a.y, b.x, b.y];
    g.poly(poly).fill(color);
  }
  const first = path[0],
    last = path.at(-1)!;
  head(
    first,
    path.find((p) => Math.hypot(p.x - first.x, p.y - first.y) > 0.01) || last,
    style.start,
  );
  head(
    last,
    [...path].reverse().find((p) => Math.hypot(p.x - last.x, p.y - last.y) > 0.01) || first,
    style.end,
  );
}
