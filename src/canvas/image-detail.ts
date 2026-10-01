import type { Camera, CanvasObject } from '../model';
import { localViewport } from './transform.ts';

export function imageTiles(o: CanvasObject, c: Camera, width: number, height: number, dpr: number) {
  const crop = o.crop || { x: 0, y: 0, width: 1, height: 1 };
  const fullWidth = o.width / crop.width,
    fullHeight = o.height / crop.height;
  const pixels = Math.max(fullWidth, fullHeight) * c.zoom * dpr;
  if (!o.assetId || pixels <= 1600) return [];
  const grid = (size: number) => Math.min(256, 2 ** Math.max(0, Math.ceil(Math.log2(size / 512))));
  const cols = grid(fullWidth * c.zoom * dpr),
    rows = grid(fullHeight * c.zoom * dpr);
  const tw = fullWidth / cols,
    th = fullHeight / rows;
  const offsetX = crop.x * fullWidth,
    offsetY = crop.y * fullHeight;
  const { left, top, right, bottom } = localViewport(o, c, width, height, 32);
  if (right <= left || bottom <= top) return [];
  const x0 = Math.max(0, Math.floor((left + offsetX) / tw)),
    y0 = Math.max(0, Math.floor((top + offsetY) / th));
  const x1 = Math.min(cols, Math.ceil((right + offsetX) / tw)),
    y1 = Math.min(rows, Math.ceil((bottom + offsetY) / th));
  const tiles = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const tx = x * tw - offsetX,
        ty = y * th - offsetY;
      const clippedX = Math.max(0, tx),
        clippedY = Math.max(0, ty);
      const clippedWidth = Math.min(o.width, tx + tw) - clippedX,
        clippedHeight = Math.min(o.height, ty + th) - clippedY;
      if (clippedWidth <= 0 || clippedHeight <= 0) continue;
      tiles.push({
        key: `${o.assetId}/tile-${cols}-${rows}-${x}-${y}`,
        x: clippedX,
        y: clippedY,
        width: clippedWidth,
        height: clippedHeight,
        frame: {
          x: (clippedX - tx) / tw,
          y: (clippedY - ty) / th,
          width: clippedWidth / tw,
          height: clippedHeight / th,
        },
      });
    }
  return tiles;
}
