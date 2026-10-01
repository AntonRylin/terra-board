import { CanvasSource, Sprite, Texture } from 'pixi.js';
import type { Camera, CanvasObject } from '../model';
import { textLayout } from './text-layout';
import { textPlacement } from './text-alignment';

export function textRegion(o: CanvasObject, c: Camera, width: number, height: number) {
  const x = Math.max(0, Math.floor((-c.x - 64) / c.zoom - o.x));
  const y = Math.max(0, Math.floor((-c.y - 64) / c.zoom - o.y));
  return {
    x,
    y,
    width: Math.max(0, Math.min(o.width, (width - c.x + 64) / c.zoom - o.x) - x),
    height: Math.max(0, Math.min(o.height, (height - c.y + 64) / c.zoom - o.y) - y),
  };
}

// Rasterize vector font outlines at the current display scale. Only the visible
// portion gets a texture, so a very wide object at 800% never allocates a giant bitmap.
export function renderText(
  o: CanvasObject,
  text: string,
  resolution: number,
  region: ReturnType<typeof textRegion>,
) {
  const { appearance: a, metrics } = textLayout(o, text);
  const placement = textPlacement(o, a, metrics.lines.length);
  const anchor = o.centerX ? o.width / 2 : a.padding;
  const overhang = a.fontSize * 0.25 + 2;
  const left = Math.max(region.x, anchor - (o.centerX ? metrics.maxLineWidth / 2 : 0) - overhang);
  const top = Math.max(region.y, placement.top - overhang);
  const right = Math.min(
    region.x + region.width,
    anchor + metrics.maxLineWidth / (o.centerX ? 2 : 1) + overhang,
  );
  const bottom = Math.min(region.y + region.height, placement.top + placement.height + overhang);
  if (right <= left || bottom <= top) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil((right - left) * resolution));
  canvas.height = Math.max(1, Math.ceil((bottom - top) * resolution));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(resolution, resolution);
  ctx.translate(-left, -top);
  ctx.font = `400 ${a.fontSize}px ${a.fontFamily}`;
  ctx.fillStyle = a.color;
  ctx.textAlign = o.centerX ? 'center' : 'left';
  const font = ctx.measureText('Mg');
  const baseline =
    (a.lineHeight - font.fontBoundingBoxAscent - font.fontBoundingBoxDescent) / 2 +
    font.fontBoundingBoxAscent;
  const first = Math.max(0, Math.floor((region.y - placement.top) / a.lineHeight) - 1);
  const last = Math.min(
    metrics.lines.length,
    Math.ceil((bottom - placement.top) / a.lineHeight) + 1,
  );
  for (let i = first; i < last; i++)
    ctx.fillText(metrics.lines[i], anchor, placement.top + baseline + i * a.lineHeight);
  const texture = new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
  const sprite = new Sprite(texture);
  sprite.label = 'board-text';
  sprite.position.set(left, top);
  sprite.once('destroyed', () => texture.destroy(true));
  return sprite;
}
