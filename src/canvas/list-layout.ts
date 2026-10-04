import type { CanvasObject, ListItem } from '../model';
import { localToWorld } from './transform.ts';

const baseWidth = 320;
export const listHeight = (count: number, scale = 1) => (100 + count * 44) * scale;

// A single logical layout drives the DOM overlay, resize limits and exports.
// Older lists could be widened without increasing their height. Keep their
// saved rectangle and fit every row by allowing a wider logical layout.
export function listLayout(o: Pick<CanvasObject, 'width' | 'height' | 'items'>) {
  const contentHeight = listHeight(o.items?.length || 0);
  const scale = Math.min(o.width / baseWidth, o.height / contentHeight);
  const width = o.width / scale;
  return {
    scale,
    width,
    height: o.height / scale,
    minimumHeight: contentHeight * scale,
    maximumWidth: Math.min(1e6, (1e6 * width) / contentHeight),
  };
}

export function withListItems(o: CanvasObject, items: ListItem[]): CanvasObject {
  const { scale } = listLayout(o);
  const resized = {
    ...o,
    items,
    height: Math.min(
      1e6,
      Math.max(
        listHeight(items.length, scale),
        o.height + (items.length - (o.items?.length || 0)) * 44 * scale,
      ),
    ),
  };
  if (o.rotation) {
    const before = localToWorld(o, { x: 0, y: 0 });
    const after = localToWorld(resized, { x: 0, y: 0 });
    resized.x += before.x - after.x;
    resized.y += before.y - after.y;
  }
  return resized;
}
