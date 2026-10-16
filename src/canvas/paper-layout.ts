// A written document ('paper'): A4 sheets at 96 dpi, stacked top to bottom. Text
// flows from one sheet to the next; a sheet is added when the last one is full.
// The object's width sets the scale, and its height is always a whole number of
// sheets at that scale, so the DOM overlay, resizing and exports agree.
import type { CanvasObject } from '../model';
import { localToWorld } from './transform.ts';

export const paperWidth = 794;
export const paperPageHeight = 1123;
export const paperGap = 32;
export const paperMargin = 76;
export const paperContentWidth = paperWidth - paperMargin * 2;
export const paperContentHeight = paperPageHeight - paperMargin * 2;
export const paperFontSize = 16;
export const paperLineHeight = 1.5;
export const paperMaxPages = 500;
export const paperMaxText = 100000;

export const paperScale = (o: Pick<CanvasObject, 'width'>) => o.width / paperWidth;
export const paperHeight = (pages: number, scale = 1) =>
  (pages * paperPageHeight + (pages - 1) * paperGap) * scale;
export const paperPages = (o: Pick<CanvasObject, 'width' | 'height'>) =>
  Math.max(
    1,
    Math.min(
      paperMaxPages,
      Math.round((o.height / paperScale(o) + paperGap) / (paperPageHeight + paperGap)),
    ),
  );
// Top of each sheet in document units.
export const paperPageTop = (index: number) => index * (paperPageHeight + paperGap);

// Grows or shrinks the stack of sheets, keeping the top-left corner in place.
export function withPaperPages(o: CanvasObject, pages: number): CanvasObject {
  const count = Math.max(1, Math.min(paperMaxPages, pages));
  const resized = { ...o, height: paperHeight(count, paperScale(o)) };
  if (o.rotation) {
    const before = localToWorld(o, { x: 0, y: 0 });
    const after = localToWorld(resized, { x: 0, y: 0 });
    resized.x += before.x - after.x;
    resized.y += before.y - after.y;
  }
  return resized;
}

// Splits laid-out lines into sheets the way the DOM does: a line that would
// cross the bottom margin moves to the next sheet.
export function paginateLines<Line extends { height: number }>(lines: readonly Line[]) {
  const pages: Line[][] = [[]];
  let used = 0;
  for (const line of lines) {
    if (used + line.height > paperContentHeight + 0.5 && pages[pages.length - 1].length) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1].push(line);
    used += line.height;
  }
  return pages;
}
