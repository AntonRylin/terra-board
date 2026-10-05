type InkMetrics = Pick<
  TextMetrics,
  | 'fontBoundingBoxAscent'
  | 'fontBoundingBoxDescent'
  | 'actualBoundingBoxAscent'
  | 'actualBoundingBoxDescent'
>;

// Match the canvas/native editor baseline, then trim only the unused space
// outside the visible lines. Blank lines still reserve room for the caret.
export function textInkBounds(
  lines: string[],
  lineHeight: number,
  measure: (text: string) => InkMetrics,
) {
  const font = measure('Mg');
  const baseline =
    (lineHeight - font.fontBoundingBoxAscent - font.fontBoundingBoxDescent) / 2 +
    font.fontBoundingBoxAscent;
  let top = Infinity,
    bottom = -Infinity;
  for (const [i, line] of (lines.length ? lines : ['']).entries()) {
    const ink = measure(line);
    const visible = line.replace(/\u200b/g, '').trim();
    top = Math.min(top, i * lineHeight + (visible ? baseline - ink.actualBoundingBoxAscent : 0));
    bottom = Math.max(
      bottom,
      i * lineHeight + (visible ? baseline + ink.actualBoundingBoxDescent : lineHeight),
    );
  }
  return { top, height: Math.max(1, bottom - top) };
}
