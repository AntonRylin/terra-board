import type { CanvasObject, ImageCrop } from '../model';
import { localToWorld } from './transform.ts';

export const fullCrop: ImageCrop = { x: 0, y: 0, width: 1, height: 1 };
export function adjustCrop(
  before: ImageCrop,
  edge: string,
  dx: number,
  dy: number,
  minWidth: number,
  minHeight: number,
): ImageCrop {
  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
  if (edge === 'move')
    return {
      ...before,
      x: clamp(before.x + dx, 0, 1 - before.width),
      y: clamp(before.y + dy, 0, 1 - before.height),
    };
  let x = before.x,
    y = before.y,
    r = Math.min(1, x + before.width),
    b = Math.min(1, y + before.height);
  // A crop can already be smaller than the handle minimum after zooming out.
  // Keep its opposite edge anchored without ever creating a negative bound.
  if (edge.includes('w')) x = clamp(x + dx, 0, r - Math.min(minWidth, r));
  if (edge.includes('e')) r = clamp(r + dx, x + Math.min(minWidth, 1 - x), 1);
  if (edge.includes('n')) y = clamp(y + dy, 0, b - Math.min(minHeight, b));
  if (edge.includes('s')) b = clamp(b + dy, y + Math.min(minHeight, 1 - y), 1);
  return { x, y, width: r - x, height: b - y };
}

export function uncroppedImage(o: CanvasObject): CanvasObject {
  const { crop, ...image } = o;
  if (!crop) return image;
  const width = o.width / crop.width,
    height = o.height / crop.height;
  const center = localToWorld(o, { x: (0.5 - crop.x) * width, y: (0.5 - crop.y) * height });
  return { ...image, x: center.x - width / 2, y: center.y - height / 2, width, height };
}

// Crop coordinates always refer to the original source, including on re-edit.
// Retained pixels stay at the same board position and scale.
export function cropImage(o: CanvasObject, crop: ImageCrop): CanvasObject {
  const image = uncroppedImage(o);
  if (crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1) return image;
  const center = localToWorld(image, {
    x: (crop.x + crop.width / 2) * image.width,
    y: (crop.y + crop.height / 2) * image.height,
  });
  return {
    ...image,
    x: center.x - (image.width * crop.width) / 2,
    y: center.y - (image.height * crop.height) / 2,
    width: image.width * crop.width,
    height: image.height * crop.height,
    crop: { ...crop },
  };
}
