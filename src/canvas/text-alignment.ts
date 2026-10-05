import type { CanvasObject } from '../model';

export function textPlacement(
  o: CanvasObject,
  a: { padding: number; wrapWidth: number; lineHeight: number; labelGap?: number },
  lineCount: number,
  contentHeight?: number,
) {
  const height = contentHeight ?? Math.max(1, lineCount) * a.lineHeight;
  if (o.type === 'frame' || o.type === 'image' || o.type === 'document')
    return { left: 0, top: -height - (a.labelGap ?? 8), height };
  return {
    left: o.centerX ? (o.width - a.wrapWidth) / 2 : a.padding,
    top: o.centerY ? Math.max(a.padding, (o.height - height) / 2) : a.padding,
    height,
  };
}
