import { CanvasSource, Sprite, Texture } from 'pixi.js';
import type { Camera, CanvasObject } from '../model';
import { textLayout } from './text-layout';
import { textPlacement } from './text-alignment';
import { localViewport } from './transform';
import { frameLabel } from './frame-label';
import { linkLayout } from './link-preview';

export function renderLinkCaption(
  o: CanvasObject,
  resolution: number,
  region: { x: number; y: number; width: number; height: number },
  loading = false,
) {
  const compact = !o.assetId;
  const summary = compact && !!o.linkDescription?.trim();
  const box = linkLayout(o.width, o.height);
  const captionTop = compact ? 0 : box.y + box.height;
  const left = Math.max(0, region.x),
    top = Math.max(captionTop, region.y);
  const width = Math.min(o.width, region.x + region.width) - left;
  const height = Math.min(o.height, region.y + region.height) - top;
  if (width <= 0 || height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * resolution));
  canvas.height = Math.max(1, Math.ceil(height * resolution));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(resolution, resolution);
  ctx.translate(-left, -top);
  const scale = Math.min(1, o.width / 440, compact ? o.height / 76 : box.footer / 56),
    pad = (compact ? 52 : o.linkIconId ? 48 : 14) * scale;
  const available = o.width - pad - (compact ? 62 : 14) * scale;
  const line = (text: string, y: number, font: number, color: string, weight = 400) => {
    ctx.font = `${weight} ${font * scale}px "Segoe UI", sans-serif`;
    ctx.fillStyle = color;
    let value = text.replace(/\s+/g, ' ').trim();
    if (ctx.measureText(value).width > available) {
      while (value.length && ctx.measureText(value + '…').width > available)
        value = value.slice(0, -1);
      value += '…';
    }
    ctx.fillText(value, pad, captionTop + y * scale);
  };
  const domain = (() => {
    try {
      return new URL(o.url!).hostname.replace(/^www\./, '');
    } catch {
      return 'Link';
    }
  })();
  line(
    o.text || o.url || domain,
    summary ? 28 : compact ? o.height / scale / 2 - 5 : 22,
    14,
    '#253040',
    600,
  );
  line(
    compact && loading ? 'Loading preview…' : domain,
    summary ? 46 : compact ? o.height / scale / 2 + 15 : 41,
    11,
    '#8893a2',
  );
  if (summary) {
    ctx.font = `${13 * scale}px "Segoe UI", sans-serif`;
    const words = o.linkDescription!.split(/\s+/);
    const lines: string[] = [];
    let row = '';
    for (const word of words) {
      if (row && ctx.measureText(row + ' ' + word).width > available) {
        lines.push(row);
        row = word;
      } else row += (row ? ' ' : '') + word;
    }
    if (row) lines.push(row);
    for (let i = 0; i < Math.min(2, lines.length); i++)
      line(lines[i] + (i === 1 && lines.length > 2 ? ' …' : ''), 72 + i * 18, 13, '#697586');
  }
  const texture = new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
  const sprite = new Sprite(texture);
  sprite.position.set(left, top);
  sprite.once('destroyed', () => texture.destroy(true));
  return sprite;
}

export function textRegion(o: CanvasObject, c: Camera, width: number, height: number) {
  if (o.rotation || o.type === 'frame') {
    const b = localViewport(o, c, width, height, 64, o.type === 'frame' ? frameLabel(o).top : 0);
    return {
      x: Math.floor(b.left),
      y: Math.floor(b.top),
      width: Math.max(0, b.right - Math.floor(b.left)),
      height: Math.max(0, b.bottom - Math.floor(b.top)),
    };
  }
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
  const centered = o.type !== 'frame' && o.centerX;
  const anchor = centered ? o.width / 2 : a.padding;
  const overhang = a.fontSize * 0.25 + 2;
  const left = Math.max(region.x, anchor - (centered ? metrics.maxLineWidth / 2 : 0) - overhang);
  const top = Math.max(region.y, placement.top - overhang);
  const right = Math.min(
    region.x + region.width,
    anchor + metrics.maxLineWidth / (centered ? 2 : 1) + overhang,
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
  ctx.textAlign = centered ? 'center' : 'left';
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
