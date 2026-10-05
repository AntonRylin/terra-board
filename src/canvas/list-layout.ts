import type { CanvasObject, ListItem } from '../model';
import { localToWorld } from './transform.ts';

const baseWidth = 320;
export function wrapListText(
  text: string,
  width: number,
  measure: (text: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = '';
    for (const token of paragraph.match(/\S+\s*|\s+/gu) || []) {
      if (line && measure(line + token) > width) {
        lines.push(line);
        line = '';
      }
      for (const character of token) {
        if (line && measure(line + character) > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}
export const listHeight = (count: number, scale = 1) => (100 + count * 44) * scale;

// A single logical layout drives the DOM overlay, resize limits and exports.
// Older lists could be widened without increasing their height. Keep their
// saved rectangle and fit every row by allowing a wider logical layout.
export function listLayout(o: Pick<CanvasObject, 'width' | 'height' | 'items' | 'listScale'>) {
  const contentHeight = listHeight(o.items?.length || 0);
  const scale = o.listScale ?? Math.min(o.width / baseWidth, o.height / contentHeight);
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
    listScale: scale,
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

export function fitListHeight(o: CanvasObject, height: number): CanvasObject {
  const resized = {
    ...o,
    listScale: listLayout(o).scale,
    height: Math.min(1e6, Math.max(o.height, height)),
  };
  const before = localToWorld(o, { x: 0, y: 0 });
  const after = localToWorld(resized, { x: 0, y: 0 });
  resized.x += before.x - after.x;
  resized.y += before.y - after.y;
  return resized;
}
