import type { Camera, CanvasObject } from '../model';
export type Point = { x: number; y: number };
export function rotationHandlePoint(o: CanvasObject, zoom: number): Point {
  return { x: -28 / zoom, y: o.height + 28 / zoom };
}
export function rotatePoint(p: Point, degrees: number): Point {
  if (!degrees) return { ...p };
  const a = (degrees * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}
export function localToWorld(o: CanvasObject, p: Point): Point {
  if (!o.rotation) return { x: o.x + p.x, y: o.y + p.y };
  const q = rotatePoint({ x: p.x - o.width / 2, y: p.y - o.height / 2 }, o.rotation || 0);
  return { x: o.x + o.width / 2 + q.x, y: o.y + o.height / 2 + q.y };
}
export function worldToLocal(o: CanvasObject, p: Point): Point {
  if (!o.rotation) return { x: p.x - o.x, y: p.y - o.y };
  const q = rotatePoint(
    { x: p.x - o.x - o.width / 2, y: p.y - o.y - o.height / 2 },
    -(o.rotation || 0),
  );
  return { x: q.x + o.width / 2, y: q.y + o.height / 2 };
}
export function objectBounds(o: CanvasObject) {
  if (!o.rotation) return { x: o.x, y: o.y, width: o.width, height: o.height };
  const points = [
    { x: 0, y: 0 },
    { x: o.width, y: 0 },
    { x: o.width, y: o.height },
    { x: 0, y: o.height },
  ].map((p) => localToWorld(o, p));
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p.x)) - x,
    height: Math.max(...points.map((p) => p.y)) - y,
  };
}
export function localViewport(
  o: CanvasObject,
  c: Camera,
  width: number,
  height: number,
  margin: number,
) {
  if (!o.rotation)
    return {
      left: Math.max(0, (-c.x - margin) / c.zoom - o.x),
      top: Math.max(0, (-c.y - margin) / c.zoom - o.y),
      right: Math.min(o.width, (width - c.x + margin) / c.zoom - o.x),
      bottom: Math.min(o.height, (height - c.y + margin) / c.zoom - o.y),
    };
  const points = [
    { x: -margin, y: -margin },
    { x: width + margin, y: -margin },
    { x: width + margin, y: height + margin },
    { x: -margin, y: height + margin },
  ].map((p) => worldToLocal(o, { x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom }));
  return {
    left: Math.max(0, Math.min(...points.map((p) => p.x))),
    top: Math.max(0, Math.min(...points.map((p) => p.y))),
    right: Math.min(o.width, Math.max(...points.map((p) => p.x))),
    bottom: Math.min(o.height, Math.max(...points.map((p) => p.y))),
  };
}
export function rotationFromDrag(o: CanvasObject, start: Point, point: Point, snap: boolean) {
  const cx = o.x + o.width / 2,
    cy = o.y + o.height / 2;
  const delta =
    ((Math.atan2(point.y - cy, point.x - cx) - Math.atan2(start.y - cy, start.x - cx)) * 180) /
    Math.PI;
  let degrees = (o.rotation || 0) + delta;
  if (snap) degrees = Math.round(degrees / 15) * 15;
  return ((degrees % 360) + 360) % 360;
}
