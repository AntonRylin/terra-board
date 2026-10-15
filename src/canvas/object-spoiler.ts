import {
  BlurFilter,
  Container,
  Graphics,
  Matrix,
  RenderTexture,
  Sprite,
  type Renderer,
} from 'pixi.js';
import type { CanvasObject } from '../model';
import { dustLayer } from './spoiler-dust.ts';
import { hidesContents, wholeObject } from './spoiler-objects.ts';

export * from './spoiler-objects.ts';

// Hidden content is blurred once, in board space, into a small texture that is
// stretched over the object. Unlike a screen-space filter it cannot shimmer
// while the board zooms, and the dust animation does not re-blur every frame.
const veilSize = 64; // texture pixels along the object's longer side

function blurredSnapshot(content: Container, o: CanvasObject, renderer: Renderer) {
  const scale = veilSize / Math.max(o.width, o.height);
  const width = Math.max(2, Math.round(o.width * scale)),
    height = Math.max(2, Math.round(o.height * scale));
  const texture = RenderTexture.create({ width, height, resolution: 1 });
  const blur = new BlurFilter({
    strength: Math.max(1.5, Math.min(width, height) * 0.08),
    quality: 4,
    resolution: 1,
  });
  // The object fills the texture exactly, so clamped edges stay opaque.
  blur.repeatEdgePixels = true;
  content.filters = [blur];
  renderer.render({
    container: content,
    target: texture,
    clear: true,
    transform: new Matrix(width / o.width, 0, 0, height / o.height, 0, 0),
  });
  content.filters = null;
  blur.destroy();
  return texture;
}

/**
 * Wraps a finished object view so its spoiler can be shown and revealed
 * without rebuilding it: a blurred copy of the content and a cover with dust
 * go on top. Titles drawn outside the object stay readable.
 */
export function coverSpoiler(
  view: Container,
  o: CanvasObject,
  dark: boolean,
  // Titles drawn outside the object, which stay readable over the blur.
  external: boolean,
  renderer: Renderer,
) {
  const frame = hidesContents(o);
  const cover = new Container({ label: 'spoiler-cover' });
  const shade = new Graphics({ label: 'spoiler-shade' });
  if (frame)
    shade
      .roundRect(0, 0, o.width, o.height, 8)
      .fill({ color: dark ? '#0e141c' : '#e9eef5', alpha: dark ? 0.35 : 0.6 });
  else
    shade
      .roundRect(0, 0, o.width, o.height, o.type === 'image' ? 0 : 7)
      .fill({ color: '#0b1017', alpha: 0.24 });
  cover.addChild(
    shade,
    dustLayer(
      [{ start: wholeObject, x: 0, y: 0, width: o.width, height: o.height }],
      dark,
      frame ? undefined : 0xffffff,
    ),
  );
  const children = [...view.children];
  if (frame) {
    // Frame contents are hidden separately; the cover sits under the title.
    const title = children.findIndex((child) => child.label === 'board-text');
    view.addChildAt(cover, title === -1 ? children.length : title);
    return view;
  }
  const content = new Container({ label: 'spoiler-content' });
  for (const child of children)
    if (!(external && child.label === 'board-text')) content.addChild(child);
  const texture = blurredSnapshot(content, o, renderer);
  const veil = new Sprite({ texture, label: 'spoiler-veil' });
  veil.width = o.width;
  veil.height = o.height;
  veil.once('destroyed', () => texture.destroy(true));
  view.addChildAt(content, 0);
  view.addChildAt(veil, 1);
  view.addChildAt(cover, 2);
  return view;
}

/** The container that holds the object's own drawing. */
export function spoilerContent(view: Container) {
  return view.getChildByLabel('spoiler-content') || view;
}

/** hidden: 1 = fully covered, 0 = revealed. */
export function updateSpoilerCover(view: Container, hidden: number) {
  const cover = view.getChildByLabel('spoiler-cover');
  if (!cover) return;
  cover.visible = hidden > 0.001;
  const shade = cover.getChildByLabel('spoiler-shade');
  if (shade) shade.alpha = hidden;
  const veil = view.getChildByLabel('spoiler-veil');
  if (!veil) return;
  veil.visible = hidden > 0.001;
  veil.alpha = hidden;
  // While fully covered, the sharp content stays hidden so nothing shows
  // through the veil's softer edges or transparent areas.
  spoilerContent(view).visible = hidden < 0.999;
}
