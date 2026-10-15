import { CanvasSource, Container, Texture, TilingSprite } from 'pixi.js';
import type { SpoilerBox } from './rich-text-canvas';

// Animated dust over hidden spoiler text on the board, like rich-text.css does
// for DOM fields: three tiles of random dots at different sizes drift in
// different directions, and revealing spreads the tiles apart while the dust
// fades. Dots keep their size on screen at every zoom.

const tileSize = 96; // screen pixels
const layers = [
  { scale: 1, vx: 7.2, vy: -4.7 },
  { scale: 1.27, vx: -18, vy: 12 },
  { scale: 0.74, vx: 5.3, vy: 14.4 },
];
export const revealDuration = 700;
export const hideDuration = 380;

let tile: Texture | null = null;
function dustTile() {
  if (tile && !tile.destroyed) return tile;
  const resolution = 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = tileSize * resolution;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(resolution, resolution);
  ctx.fillStyle = '#ffffff';
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < (tileSize * tileSize) / 64; i++) {
    const x = random() * tileSize,
      y = random() * tileSize,
      r = 0.5 + random() * 0.5;
    ctx.globalAlpha = 0.45 + random() * 0.55;
    // Wrap dots across the edges so the tile repeats seamlessly.
    for (const dx of [-tileSize, 0, tileSize])
      for (const dy of [-tileSize, 0, tileSize]) {
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
  }
  tile = new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
  tile.source.addressMode = 'repeat';
  return tile;
}

export function dustLayer(boxes: readonly SpoilerBox[], dark: boolean, tint?: number) {
  const layer = new Container();
  layer.label = 'spoiler-dust';
  for (const box of boxes) {
    const group = new Container();
    group.label = String(box.start);
    group.position.set(box.x, box.y);
    for (let i = 0; i < layers.length; i++) {
      const sprite = new TilingSprite({
        texture: dustTile(),
        width: Math.max(0.0001, box.width),
        height: Math.max(0.0001, box.height),
      });
      sprite.tint = tint ?? (dark ? 0xcddaeb : 0x606e80);
      // Offset each box's pattern so neighbouring words do not repeat it.
      sprite.label = String((box.x * 13 + box.y * 7) % tileSize);
      group.addChild(sprite);
    }
    layer.addChild(group);
  }
  return layer;
}

// visibility(start): 1 = fully hidden under dust, 0 = revealed.
// Returns whether the layer still needs frames.
export function updateDust(
  layer: Container,
  zoom: number,
  time: number,
  visibility: (start: number) => { value: number; moving: boolean },
  still: boolean,
) {
  let animating = false;
  const seconds = still ? 0 : time / 1000;
  for (const group of layer.children) {
    const { value, moving } = visibility(Number(group.label));
    group.visible = value > 0.001;
    group.alpha = value;
    if (!group.visible) continue;
    animating ||= moving || !still;
    const spread = 1 + (1 - value) * 0.9;
    group.children.forEach((child, i) => {
      const sprite = child as TilingSprite;
      const { scale, vx, vy } = layers[i];
      const period = tileSize * scale * spread;
      const offset = Number(sprite.label) || 0;
      sprite.tileScale.set((scale * spread) / zoom);
      sprite.tilePosition.set(
        ((((offset + seconds * vx) % period) + period) % period) / zoom,
        ((((offset + seconds * vy) % period) + period) % period) / zoom,
      );
    });
  }
  return animating;
}
