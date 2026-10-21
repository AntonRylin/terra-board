import type { CanvasObject } from '../model';

// Notes size their text to fill the note unless someone chose a size. Older notes
// were all saved with 21, the old fixed ceiling, so that value still means "auto".
export const autoNoteText = (o: Pick<CanvasObject, 'type' | 'fontSize'>) =>
  o.type === 'note' && (o.fontSize === undefined || o.fontSize === 21);

// The largest text an auto note tries; fitting then shrinks it until the text fits.
const autoNoteCeiling = (o: CanvasObject) => Math.max(1, Math.min(o.width, o.height) * 0.3);

// The renderer and the in-place editor share the same font, spacing and inset.
export function textAppearance(o: CanvasObject) {
  const fontSize =
    o.type === 'image' || o.type === 'document'
      ? 12
      : autoNoteText(o)
        ? autoNoteCeiling(o)
        : o.fontSize || (o.type === 'frame' ? 14 : 18);
  return {
    fontSize,
    fontWeight: o.bold ? ('700' as const) : ('400' as const),
    lineHeight: fontSize * (o.type === 'text' ? 1.3 : 1.45),
    padding:
      o.type === 'text'
        ? fontSize * 0.14
        : o.type === 'frame' || o.type === 'image' || o.type === 'document'
          ? 0
          : o.type === 'note'
            ? Math.min(22, o.width * 0.09, o.height * 0.09)
            : 22,
    fontFamily:
      o.type === 'note' ? '"Segoe Print", "Segoe UI", sans-serif' : '"Segoe UI", sans-serif',
    color: o.type === 'text' ? o.color || '#29313b' : '#434e5d',
  };
}
