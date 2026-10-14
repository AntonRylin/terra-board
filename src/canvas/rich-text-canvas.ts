import { fontFamilies, styleRuns, type TextMark, type TextStyle } from './rich-text.ts';

// Canvas layout and drawing of formatted text for exports, matching the DOM
// editor: words wrap as units, larger text grows its own line, and spoilers stay
// hidden behind dust (an export is shared with people who have not clicked it).

export interface RichBase {
  size: number;
  weight: number;
  family: string;
  lineHeight: number; // multiple of the font size
}
interface Piece {
  text: string;
  style: TextStyle;
  width: number;
  size: number;
}
export interface RichLine {
  pieces: Piece[];
  height: number;
  size: number; // largest font size on the line
}

const fontOf = (style: TextStyle, base: RichBase) => {
  const size = base.size * (style.size || 1) * (style.code && !style.font ? 0.92 : 1);
  const family = style.font
    ? fontFamilies[style.font]
    : style.code
      ? fontFamilies.mono
      : base.family;
  return `${style.italic ? 'italic ' : ''}${style.bold ? 700 : base.weight} ${size}px ${family}`;
};

export function layoutRichText(
  ctx: CanvasRenderingContext2D,
  text: string,
  marks: readonly TextMark[] | undefined,
  base: RichBase,
  width: number,
): RichLine[] {
  const runs = styleRuns(text.length, marks);
  const pieceAt = (start: number, end: number): Piece[] =>
    runs
      .filter((run) => run.end > start && run.start < end)
      .map((run) => {
        const value = text.slice(Math.max(start, run.start), Math.min(end, run.end));
        ctx.font = fontOf(run.style, base);
        return {
          text: value,
          style: run.style,
          width: ctx.measureText(value).width,
          size: base.size * (run.style.size || 1),
        };
      });
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let used = 0;
  const append = (pieces: Piece[]) => {
    for (const piece of pieces) {
      const last = line[line.length - 1];
      if (last && last.style === piece.style) {
        last.text += piece.text;
        last.width += piece.width;
      } else line.push({ ...piece });
      used += piece.width;
    }
  };
  const breakLine = () => {
    lines.push(line);
    line = [];
    used = 0;
  };
  let offset = 0;
  for (const paragraph of text.split('\n')) {
    for (const match of paragraph.matchAll(/\S+\s*|\s+/gu)) {
      const start = offset + match.index!,
        end = start + match[0].length;
      const pieces = pieceAt(start, end);
      const tokenWidth = pieces.reduce((sum, piece) => sum + piece.width, 0);
      if (line.length && used + tokenWidth > width) breakLine();
      if (tokenWidth <= width) {
        append(pieces);
        continue;
      }
      // A word wider than the line breaks between characters.
      for (let at = start; at < end;) {
        const step = text.codePointAt(at)! > 0xffff ? 2 : 1;
        const character = pieceAt(at, at + step);
        const characterWidth = character.reduce((sum, piece) => sum + piece.width, 0);
        if (line.length && used + characterWidth > width) breakLine();
        append(character);
        at += step;
      }
    }
    breakLine();
    offset += paragraph.length + 1;
  }
  return lines.map((pieces) => {
    const size = Math.max(base.size, ...pieces.map((piece) => piece.size));
    return { pieces, height: size * base.lineHeight, size };
  });
}

export const richTextHeight = (lines: readonly RichLine[]) =>
  lines.reduce((sum, line) => sum + line.height, 0);

// Deterministic dust, so repeated exports are identical.
function dust(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  let seed = Math.floor(x * 7 + y * 13 + w * 3) >>> 0 || 1;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#606e80';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.fill();
  for (let i = 0, count = Math.ceil((w * h) / 26); i < count; i++) {
    ctx.globalAlpha = 0.35 + random() * 0.55;
    ctx.beginPath();
    ctx.arc(x + random() * w, y + random() * h, 0.55 + random() * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawRichText(
  ctx: CanvasRenderingContext2D,
  lines: readonly RichLine[],
  base: RichBase,
  x: number,
  y: number,
  color: string,
  strikeAll = false,
) {
  ctx.textBaseline = 'alphabetic';
  let top = y;
  for (const line of lines) {
    // Segoe UI's content area is ~1.33em with a 1.08em ascent, centred in the line like CSS.
    const baseline = top + (line.height - line.size * 1.33) / 2 + line.size * 1.08;
    let left = x;
    for (const piece of line.pieces) {
      const { style } = piece;
      const glyphTop = baseline - piece.size * 0.95,
        glyphHeight = piece.size * 1.3;
      if (style.spoiler) {
        dust(ctx, left, glyphTop, piece.width, glyphHeight);
        left += piece.width;
        continue;
      }
      if (style.highlight || style.code) {
        ctx.save();
        ctx.globalAlpha = style.highlight ? 0.42 : 0.16;
        ctx.fillStyle = style.highlight || '#788ca5';
        ctx.beginPath();
        ctx.roundRect(left, glyphTop, piece.width, glyphHeight, 3);
        ctx.fill();
        ctx.restore();
      }
      ctx.font = fontOf(style, base);
      ctx.fillStyle = style.color || color;
      ctx.fillText(piece.text, left, baseline);
      const thickness = Math.max(1, piece.size / 16);
      if (style.underline) ctx.fillRect(left, baseline + piece.size * 0.12, piece.width, thickness);
      if (style.strike || strikeAll)
        ctx.fillRect(left, baseline - piece.size * 0.3, piece.width, thickness);
      left += piece.width;
    }
    top += line.height;
  }
}
