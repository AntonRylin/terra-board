import { Container, Graphics, Text } from 'pixi.js';
import type { CanvasObject } from '../model';
import { albumName } from './album.ts';

// The album's name, written across the bottom of its cover on a dark band.
// Sizes are in board units, so the name scales with the card and the zoom.
export function renderAlbumName(o: CanvasObject, resolution: number) {
  const layer = new Container();
  layer.label = 'album-name';
  const fontSize = Math.max(4, Math.min(o.width * 0.075, o.height * 0.14, 40));
  const band = Math.min(o.height, fontSize * 2.1);
  const pad = fontSize * 0.6;
  const shade = new Graphics()
    .rect(0, o.height - band, o.width, band)
    .fill({ color: '#000000', alpha: 0.5 });
  const name = new Text({
    text: albumName(o),
    resolution,
    style: {
      fontFamily: 'Segoe UI',
      fontWeight: '600',
      fontSize,
      fill: '#ffffff',
    },
  });
  name.anchor.set(0, 0.5);
  name.position.set(pad, o.height - band / 2);
  // A long name is cut at the card's edge rather than spilling past it.
  const clip = new Graphics().rect(0, 0, Math.max(1, o.width - pad), o.height).fill('#ffffff');
  name.mask = clip;
  layer.addChild(shade, name, clip);
  return layer;
}
