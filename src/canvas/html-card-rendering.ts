import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { CanvasObject } from '../model';
import { browserChrome } from './html-card.ts';

// An HTML embed on the board: its captured picture, or a code mark while the
// first picture is being captured. While its page runs in a DOM frame under
// the board, the card is a see-through hole onto that page instead, so objects
// above it still draw over it.
export function renderHtmlCard(
  o: CanvasObject,
  texture: Texture | null,
  dark: boolean,
  live = false,
) {
  const card = new Container();
  const back = new Graphics()
    .rect(0, 0, o.width, o.height)
    .fill(texture || live ? '#ffffff' : dark ? '#1c2632' : '#f4f6f9');
  if (live) back.blendMode = 'erase';
  card.addChild(back);
  if (live) {
    // Nothing between the hole and the border.
  } else if (texture) {
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

// A browser frame: an address bar over the page's captured picture. The live
// page and its working controls are a DOM overlay drawn over this.
export function renderBrowserCard(
  o: CanvasObject,
  texture: Texture | null,
  dark: boolean,
  resolution: number,
) {
  const card = new Container();
  const radius = Math.min(10, o.width / 8, o.height / 8),
    bar = Math.min(browserChrome, o.height);
  card.addChild(
    new Graphics()
      .roundRect(0, 0, o.width, o.height, radius)
      .fill(dark ? '#1c2632' : '#f4f6f9')
      .rect(0, bar, o.width, o.height - bar)
      .fill(texture ? '#ffffff' : dark ? '#151d27' : '#ffffff'),
  );
  if (texture) {
    const sprite = new Sprite(texture);
    sprite.position.set(0, bar);
    sprite.width = o.width;
    sprite.height = Math.max(0, o.height - bar);
    // Keep the page inside the card's rounded corners.
    const mask = new Graphics().roundRect(0, 0, o.width, o.height, radius).fill('#ffffff');
    sprite.mask = mask;
    card.addChild(sprite, mask);
  } else if (o.height > bar + 40) {
    // A globe while the first picture is being captured.
    const size = Math.min(o.width, o.height - bar) * 0.12,
      cx = o.width / 2,
      cy = bar + (o.height - bar) / 2;
    card.addChild(
      new Graphics()
        .circle(cx, cy, size)
        .ellipse(cx, cy, size * 0.45, size)
        .moveTo(cx - size, cy)
        .lineTo(cx + size, cy)
        .stroke({ color: dark ? '#8fa3bb' : '#8a96a6', width: Math.max(1, size * 0.08) }),
    );
  }
  // Back, forward and reload, drawn as the overlay's buttons appear.
  const ink = dark ? '#8fa3bb' : '#7b8796',
    cy = bar / 2;
  const glyphs = new Graphics()
    .moveTo(20, cy - 5)
    .lineTo(15, cy)
    .lineTo(20, cy + 5)
    .moveTo(40, cy - 5)
    .lineTo(45, cy)
    .lineTo(40, cy + 5)
    .moveTo(70 + 5.5 * Math.cos(-Math.PI * 0.35), cy + 5.5 * Math.sin(-Math.PI * 0.35))
    .arc(70, cy, 5.5, -Math.PI * 0.35, Math.PI * 1.45)
    .stroke({ color: ink, width: 1.6, cap: 'round', join: 'round' });
  card.addChild(glyphs);
  const pill = { x: 92, y: 7, width: Math.max(0, o.width - 104), height: bar - 14 };
  if (pill.width > 40) {
    card.addChild(
      new Graphics()
        .roundRect(pill.x, pill.y, pill.width, pill.height, pill.height / 2)
        .fill(dark ? '#263241' : '#ffffff')
        .stroke({ color: dark ? '#344255' : '#e1e6ed', width: 1 }),
    );
    let address = o.url || '';
    try {
      const u = new URL(address);
      address = u.host + (u.pathname === '/' ? '' : u.pathname);
    } catch {}
    const room = Math.floor((pill.width - 28) / 7);
    if (address.length > room) address = address.slice(0, Math.max(1, room - 1)) + '…';
    const label = new Text({
      text: address,
      resolution: Math.min(4, Math.max(1, resolution)),
      style: {
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        fontSize: 13,
        fill: dark ? '#c9d4e2' : '#3b4655',
      },
    });
    label.position.set(pill.x + 14, pill.y + (pill.height - label.height) / 2);
    card.addChild(label);
  }
  card.addChild(
    new Graphics()
      .roundRect(0, 0, o.width, o.height, radius)
      .stroke({ color: dark ? '#3a485b' : '#d7dee8', width: 1, alignment: 1 }),
  );
  return card;
}
