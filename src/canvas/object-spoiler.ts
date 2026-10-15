import { BlurFilter, Container, Graphics } from 'pixi.js';
import type { CanvasObject } from '../model';
import { dustLayer } from './spoiler-dust.ts';
import { hidesContents, wholeObject } from './spoiler-objects.ts';

export * from './spoiler-objects.ts';

/**
 * Wraps a finished object view so its spoiler can be shown and revealed
 * without rebuilding it: the content goes into a blur container and a cover
 * with dust goes on top. Titles drawn outside the object stay readable.
 */
export function coverSpoiler(
  view: Container,
  o: CanvasObject,
  dark: boolean,
  // Titles drawn outside the object, which stay readable over the blur.
  external: boolean,
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
  const blur = new Container({ label: 'spoiler-blur' });
  for (const child of children)
    if (!(external && child.label === 'board-text')) blur.addChild(child);
  view.addChildAt(blur, 0);
  view.addChildAt(cover, 1);
  return view;
}

/** The container that holds the object's own drawing, blurred while hidden. */
export function spoilerContent(view: Container) {
  return view.getChildByLabel('spoiler-blur') || view;
}

/**
 * hidden: 1 = fully covered, 0 = revealed. scale: screen pixels per board
 * unit, so the blur hides about the same share of the object at every zoom.
 */
export function updateSpoilerCover(
  view: Container,
  o: CanvasObject,
  hidden: number,
  scale: number,
) {
  const cover = view.getChildByLabel('spoiler-cover');
  if (!cover) return;
  cover.visible = hidden > 0.001;
  const shade = cover.getChildByLabel('spoiler-shade');
  if (shade) shade.alpha = hidden;
  const blur = view.getChildByLabel('spoiler-blur');
  if (!blur) return;
  const size = Math.min(o.width, o.height) * scale;
  const strength = hidden * Math.max(6, Math.min(48, size * 0.07));
  if (strength < 0.25) {
    blur.filters = null;
    return;
  }
  let filter = (blur.filters as BlurFilter[] | null)?.[0];
  if (!filter) {
    filter = new BlurFilter({ strength, quality: 4, resolution: 0.5 });
    // Clamp at the edges so the blur stays inside the object and its border
    // does not fade into the board.
    filter.repeatEdgePixels = true;
    blur.filters = [filter];
  }
  filter.strength = strength;
}
