import type { CanvasObject } from '../model';

// The renderer and the in-place editor share the same font, spacing and inset.
export function textAppearance(o: CanvasObject) {
  const fontSize =
    o.type === 'image' ? 12 : o.fontSize || (o.type === 'note' ? 21 : o.type === 'frame' ? 14 : 18);
  return {
    fontSize,
    lineHeight: fontSize * 1.45,
    padding:
      o.type === 'text'
        ? fontSize * 0.2
        : o.type === 'frame' || o.type === 'image'
          ? 0
          : o.type === 'note'
            ? Math.min(22, o.width / 4, o.height / 4)
            : 22,
    fontFamily:
      o.type === 'note' ? '"Segoe Print", "Segoe UI", sans-serif' : '"Segoe UI", sans-serif',
    color: o.type === 'text' ? o.color || '#29313b' : '#434e5d',
  };
}
