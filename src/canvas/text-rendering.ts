import { CanvasSource, Sprite, Texture } from 'pixi.js';
import type { Camera, CanvasObject } from '../model';
import { textLayout } from './text-layout';
import { textPlacement } from './text-alignment';
import { localViewport } from './transform';
import { frameLabel, hasExternalLabel } from './frame-label';
import { linkLayout, hasLinkImage } from './link-preview';
import { nightInk } from '../appearance';
import { drawRichText, spoilerBoxes, type SpoilerBox } from './rich-text-canvas';

export interface RichRenderOptions {
  // Spoiler regions this viewer has revealed (never saved or shared).
  revealed?: (start: number) => boolean;
  // Exports paint still dust over hidden spoilers; on screen the engine
  // animates dust above a faint veil.
  exporting?: boolean;
}

// Hidden-text boxes in the object's local coordinates, for dust and clicks.
export function textSpoilers(o: CanvasObject, text = o.text || ''): SpoilerBox[] {
  const { appearance: a, metrics, rich } = textLayout(o, text);
  if (!rich) return [];
  const placement = textPlacement(o, a, metrics.lines.length, metrics.height);
  return spoilerBoxes(rich.lines, {
    x: o.centerX ? o.width / 2 : a.padding,
    y: placement.top,
    align: o.centerX ? 'center' : 'left',
  });
}

export function renderLinkCaption(
  o: CanvasObject,
  resolution: number,
  region: { x: number; y: number; width: number; height: number },
  loading = false,
  dark = false,
) {
  const compact = !hasLinkImage(o);
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
    dark ? '#e4eaf2' : '#253040',
    600,
  );
  line(
    compact && loading ? 'Loading preview…' : domain,
    summary ? 46 : compact ? o.height / scale / 2 + 15 : 41,
    11,
    dark ? '#a6b3c5' : '#8893a2',
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
      line(
        lines[i] + (i === 1 && lines.length > 2 ? ' …' : ''),
        72 + i * 18,
        13,
        dark ? '#a6b3c5' : '#697586',
      );
  }
  const texture = new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
  const sprite = new Sprite(texture);
  sprite.position.set(left, top);
  sprite.once('destroyed', () => texture.destroy(true));
  return sprite;
}

export function textRegion(
  o: CanvasObject,
  c: Camera,
  width: number,
  height: number,
  frameZoom?: number,
) {
  const external = hasExternalLabel(o);
  const minTop = external ? frameLabel(o, frameZoom).top : 0;
  const b =
    o.rotation || external
      ? localViewport(o, c, width, height, 64, minTop)
      : {
          left: Math.max(0, (-c.x - 64) / c.zoom - o.x),
          top: Math.max(0, (-c.y - 64) / c.zoom - o.y),
          right: Math.min(o.width, (width - c.x + 64) / c.zoom - o.x),
          bottom: Math.min(o.height, (height - c.y + 64) / c.zoom - o.y),
        };
  let { left, top, right, bottom } = b;
  if (frameZoom !== undefined && right > left && bottom > top) {
    // On screen, grow the clip to a coarse grid (128-256 screen pixels, in a
    // power-of-two board unit). The region then stays identical while panning,
    // so text is not rasterised and uploaded again on every frame. Objects
    // smaller than a cell are simply rendered whole.
    const cell = 2 ** Math.ceil(Math.log2(128 / c.zoom));
    const snapped = {
      left: Math.max(0, Math.floor(left / cell) * cell),
      top: Math.max(minTop, Math.floor(top / cell) * cell),
      right: Math.min(o.width, Math.ceil(right / cell) * cell),
      bottom: Math.min(o.height, Math.ceil(bottom / cell) * cell),
    };
    const resolution = 2 ** Math.ceil(Math.log2(c.zoom * devicePixelRatio));
    // Never exceed what the unsnapped clip could already require.
    if (
      (snapped.right - snapped.left) * resolution <= 8192 &&
      (snapped.bottom - snapped.top) * resolution <= 8192
    )
      ({ left, top, right, bottom } = snapped);
  }
  const x = Math.floor(left),
    y = Math.floor(top);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

// Rasterize vector font outlines at the current display scale. Only the visible
// portion gets a texture, so a very wide object at 800% never allocates a giant bitmap.
export function renderText(
  o: CanvasObject,
  text: string,
  resolution: number,
  region: ReturnType<typeof textRegion>,
  dark = false,
  frameZoom?: number,
  options: RichRenderOptions = {},
) {
  const { appearance: a, metrics, rich } = textLayout(o, text, frameZoom);
  const placement = textPlacement(o, a, metrics.lines.length, rich ? metrics.height : undefined);
  const centered = o.type !== 'frame' && o.type !== 'image' && o.type !== 'document' && o.centerX;
  const anchor = centered ? o.width / 2 : a.padding;
  const largest = rich ? Math.max(a.fontSize, ...rich.lines.map((line) => line.size)) : a.fontSize;
  const overhang = largest * 0.25 + 2;
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
  if (rich) {
    drawRichText(ctx, rich.lines, rich.base, {
      x: anchor,
      y: placement.top,
      align: centered ? 'center' : 'left',
      color: dark ? nightInk(o, a.color) : a.color,
      strikeAll: o.strikethrough,
      dark,
      revealed: options.exporting ? undefined : options.revealed,
      hidden: options.exporting ? 'dust' : 'veil',
      visible: { top, bottom },
    });
    return textSprite(canvas, resolution, left, top);
  }
  ctx.font = `${a.fontWeight} ${a.fontSize}px ${a.fontFamily}`;
  ctx.fillStyle = dark ? nightInk(o, a.color) : a.color;
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
  for (let i = first; i < last; i++) {
    const y = placement.top + baseline + i * a.lineHeight;
    ctx.fillText(metrics.lines[i], anchor, y);
    if (o.strikethrough) {
      const width = ctx.measureText(metrics.lines[i]).width;
      const thickness = Math.max(1, a.fontSize / 16);
      ctx.fillRect(
        anchor - (centered ? width / 2 : 0),
        y - a.fontSize * 0.3 - thickness / 2,
        width,
        thickness,
      );
    }
  }
  return textSprite(canvas, resolution, left, top);
}
function textSprite(canvas: HTMLCanvasElement, resolution: number, left: number, top: number) {
  const texture = new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
  const sprite = new Sprite(texture);
  sprite.label = 'board-text';
  sprite.position.set(left, top);
  sprite.once('destroyed', () => texture.destroy(true));
  return sprite;
}
