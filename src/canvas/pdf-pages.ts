import type { CanvasObject } from '../model';
import { objectBounds } from './transform.ts';

// Turning a PDF into page images, and merging images back into a PDF.
export type PageStack = 'vertical' | 'horizontal';
export const pageGap = { min: 0, max: 1000, step: 10, initial: 40 };
// Space between the PDF card and its first page image.
export const pageOffset = 64;

export function clampGap(gap: number) {
  if (!Number.isFinite(gap)) return pageGap.initial;
  return Math.max(pageGap.min, Math.min(pageGap.max, Math.round(gap)));
}

// A page image keeps its PDF size in points, so a board of mixed pages
// reads like the document. Very small or wide pages stay within reach.
export function pageImageSize(width: number, height: number) {
  const scale = Math.max(400, Math.min(900, width)) / width;
  return { width: width * scale, height: height * scale };
}

export function stackPages(
  origin: { x: number; y: number },
  sizes: { width: number; height: number }[],
  stack: PageStack,
  gap: number,
) {
  const space = clampGap(gap);
  let cursor = 0;
  return sizes.map((size) => {
    const place =
      stack === 'vertical'
        ? { x: origin.x, y: origin.y + cursor, ...size }
        : { x: origin.x + cursor, y: origin.y, ...size };
    cursor += (stack === 'vertical' ? size.height : size.width) + space;
    return place;
  });
}

// Reading order: rows top to bottom, then left to right inside a row. An
// object joins a row when its middle falls within the row's first object.
export function readingOrder<T extends CanvasObject>(objects: T[]): T[] {
  const boxes = objects
    .map((object) => ({ object, box: objectBounds(object) }))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: { top: number; bottom: number; items: typeof boxes }[] = [];
  for (const item of boxes) {
    const middle = item.box.y + item.box.height / 2;
    const row = rows.find((r) => middle >= r.top && middle <= r.bottom);
    if (row) row.items.push(item);
    else rows.push({ top: item.box.y, bottom: item.box.y + item.box.height, items: [item] });
  }
  return rows.flatMap((row) =>
    row.items.sort((a, b) => a.box.x - b.box.x).map((item) => item.object),
  );
}

// Images turned at right angles become turned pages; other angles keep the page upright.
export function pageRotation(rotation = 0) {
  const turn = ((Math.round(rotation) % 360) + 360) % 360;
  return turn % 90 === 0 && Math.abs(rotation - Math.round(rotation)) < 1e-6 ? turn : 0;
}

export function baseName(name: string) {
  return (
    (name.split(/[\\/]/).pop() || '')
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/ — page \d+$/, '')
      .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 180) || 'Document'
  );
}

export function pageName(document: string, page: number, extension: string) {
  return `${baseName(document)} — page ${page}.${extension}`;
}

export function mergedName(objects: CanvasObject[]) {
  const first = objects[0];
  return `${baseName(first?.text || first?.imageTitle || 'Merged')}.pdf`;
}

// Returns the EXIF orientation of a JPEG, or 1 when it carries none.
export function jpegOrientation(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return 1;
    // APP1 "Exif\0\0" followed by a TIFF header.
    if (marker === 0xe1 && length >= 16 && view.getUint32(offset + 4) === 0x45786966) {
      const tiff = offset + 10;
      const little = view.getUint16(tiff) === 0x4949;
      const u16 = (at: number) => view.getUint16(at, little);
      const u32 = (at: number) => view.getUint32(at, little);
      const end = offset + 2 + length;
      const directory = tiff + u32(tiff + 4);
      if (directory + 2 > end) return 1;
      const count = u16(directory);
      for (let i = 0; i < count; i++) {
        const entry = directory + 2 + i * 12;
        if (entry + 12 > end) return 1;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

export function imageKind(bytes: Uint8Array): 'png' | 'jpg' | null {
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}
