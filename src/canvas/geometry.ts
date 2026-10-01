import RBush from 'rbush';
import type { Camera, CanvasObject } from '../model';
export interface Point {
  x: number;
  y: number;
}
export interface Bounds extends Point {
  width: number;
  height: number;
}
export const screenToWorld = (p: Point, c: Camera): Point => ({
  x: (p.x - c.x) / c.zoom,
  y: (p.y - c.y) / c.zoom,
});
export function zoomAt(c: Camera, p: Point, zoom: number): Camera {
  const q = screenToWorld(p, c);
  zoom = Math.max(0.025, Math.min(8, zoom));
  return { x: p.x - q.x * zoom, y: p.y - q.y * zoom, zoom };
}
export function boundsOf(items: CanvasObject[]): Bounds | null {
  if (!items.length) return null;
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const o of items) {
    x = Math.min(x, o.x);
    y = Math.min(y, o.y);
    right = Math.max(right, o.x + o.width);
    bottom = Math.max(bottom, o.y + o.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}
interface Entry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  object: CanvasObject;
}
export class SpatialIndex {
  private tree = new RBush<Entry>();
  private entries = new Map<string, Entry>();
  reset(objects: CanvasObject[]) {
    this.tree.clear();
    this.entries.clear();
    const entries = objects.map((o) => this.entry(o));
    for (const e of entries) this.entries.set(e.object.id, e);
    this.tree.load(entries);
  }
  private entry(o: CanvasObject): Entry {
    return { minX: o.x, minY: o.y, maxX: o.x + o.width, maxY: o.y + o.height, object: o };
  }
  upsert(o: CanvasObject) {
    this.remove(o.id);
    const e = this.entry(o);
    this.entries.set(o.id, e);
    this.tree.insert(e);
  }
  remove(id: string) {
    const e = this.entries.get(id);
    if (e) {
      this.tree.remove(e);
      this.entries.delete(id);
    }
  }
  search(b: Bounds) {
    return this.tree
      .search({ minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height })
      .map((e) => e.object);
  }
}
