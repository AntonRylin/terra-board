import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { CanvasObject } from '../model';

// An HTML embed on the board: its captured picture, or a code mark while the
// first picture is being captured. The live page is a DOM frame over this.
export function renderHtmlCard(o: CanvasObject, texture: Texture | null, dark: boolean) {
  const card = new Container();
  const back = new Graphics()
    .rect(0, 0, o.width, o.height)
    .fill(texture ? '#ffffff' : dark ? '#1c2632' : '#f4f6f9');
  card.addChild(back);
  if (texture) {
    const sprite = new Sprite(texture);
    sprite.width = o.width;
    sprite.height = o.height;
    card.addChild(sprite);
  } else {
    // "</>", sized to the card.
    const size = Math.min(o.width, o.height) * 0.16,
      cx = o.width / 2,
      cy = o.height / 2,
      width = Math.max(1, size * 0.09);
    const mark = new Graphics()
      .moveTo(cx - size * 0.45, cy - size * 0.32)
      .lineTo(cx - size * 0.85, cy)
      .lineTo(cx - size * 0.45, cy + size * 0.32)
      .moveTo(cx + size * 0.45, cy - size * 0.32)
      .lineTo(cx + size * 0.85, cy)
      .lineTo(cx + size * 0.45, cy + size * 0.32)
      .moveTo(cx + size * 0.14, cy - size * 0.46)
      .lineTo(cx - size * 0.14, cy + size * 0.46)
      .stroke({ color: dark ? '#8fa3bb' : '#8a96a6', width, cap: 'round', join: 'round' });
    card.addChild(mark);
  }
  card.addChild(
    new Graphics()
      .rect(0, 0, o.width, o.height)
      .stroke({ color: dark ? '#3a485b' : '#dce2eb', width: 1, alignment: 1 }),
  );
  return card;
}
