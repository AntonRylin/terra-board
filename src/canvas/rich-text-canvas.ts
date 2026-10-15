import {
  fontFamilies,
  spoilerRegions,
  styleRuns,
  type TextMark,
  type TextStyle,
} from './rich-text.ts';

// Canvas layout and drawing of formatted text, matching the DOM editor
// (white-space: pre-wrap, overflow-wrap: break-word, unitless line-height):
// words wrap as units with their trailing spaces hanging past the edge, an
// over-long word breaks between characters, and each line box is as tall as
// its tallest inline box, measured from the real font metrics like CSS does.

export interface RichBase {
  size: number;
  weight: number | string;
  family: string;
  lineHeight: number; // multiple of the font size
}
type Measure = Pick<
  CanvasRenderingContext2D,
  'font' | 'measureText' | 'save' | 'restore' | 'fillStyle' | 'globalAlpha'
>;
export interface RichPiece {
  text: string;
  style: TextStyle;
  start: number;
  end: number;
  width: number; // including any padding
  size: number; // font size of the piece
  ascent: number;
  descent: number;
  lead: number; // inline padding before the text (monospace runs)
  spoiler?: number; // start of the whole spoiler region, the key a reveal is stored under
}
export interface RichLine {
  pieces: RichPiece[];
  start: number;
  end: number;
  width: number; // without hanging trailing spaces
  height: number;
  baseline: number; // from the top of the line
  size: number; // largest font size on the line
}

export const fontSizeOf = (style: TextStyle, base: RichBase) =>
  base.size * (style.size || 1) * (style.code && !style.font ? 0.92 : 1);
export const fontOf = (style: TextStyle, base: RichBase) => {
  const family = style.font
    ? fontFamilies[style.font]
    : style.code
      ? fontFamilies.mono
      : base.family;
  return `${style.italic ? 'italic ' : ''}${style.bold ? 700 : base.weight} ${fontSizeOf(style, base)}px ${family}`;
};
// .rt-code in rich-text.css: padding-inline 0.18em.
const codePad = 0.18;

const metricCache = new Map<string, { ascent: number; descent: number }>();
function fontMetrics(ctx: Measure, font: string, size: number) {
  let m = metricCache.get(font);
  if (!m) {
    ctx.font = font;
    const t = ctx.measureText('Mg');
    m = {
      ascent: t.fontBoundingBoxAscent ?? size * 0.92,
      descent: t.fontBoundingBoxDescent ?? size * 0.23,
    };
    if (metricCache.size > 500) metricCache.clear();
    metricCache.set(font, m);
  }
  return m;
}
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
function graphemes(text: string, from: number, to: number) {
  const out: number[] = [];
  if (segmenter)
    for (const { index } of segmenter.segment(text.slice(from, to))) out.push(from + index);
  else for (let at = from; at < to; at += text.codePointAt(at)! > 0xffff ? 2 : 1) out.push(at);
  out.push(to);
  return out;
}

export function layoutRichText(
  ctx: Measure,
  text: string,
  marks: readonly TextMark[] | undefined,
  base: RichBase,
  width: number,
): RichLine[] {
  const runs = styleRuns(text.length, marks);
  const regions = spoilerRegions(runs);
  const strut = fontMetrics(ctx, fontOf({}, base), base.size);
  const pieceAt = (start: number, end: number): RichPiece[] =>
    runs
      .filter((run) => run.end > start && run.start < end)
      .map((run) => {
        const from = Math.max(start, run.start),
          to = Math.min(end, run.end);
        const value = text.slice(from, to);
        const font = fontOf(run.style, base),
          size = fontSizeOf(run.style, base);
        ctx.font = font;
        const pad = run.style.code ? size * codePad : 0;
        const lead = from === run.start ? pad : 0;
        return {
          text: value,
          style: run.style,
          start: from,
          end: to,
          width: ctx.measureText(value).width + lead + (to === run.end ? pad : 0),
          size,
          lead,
          ...fontMetrics(ctx, font, size),
          ...(run.style.spoiler
            ? { spoiler: regions.find((r) => r.start <= from && from < r.end)!.start }
            : {}),
        };
      });
  const sum = (pieces: RichPiece[]) => pieces.reduce((total, piece) => total + piece.width, 0);
  const lines: RichLine[] = [];
  let line: RichPiece[] = [],
    used = 0,
    inked = 0,
    lineStart = 0;
  const append = (pieces: RichPiece[], ink: boolean) => {
    for (const piece of pieces) {
      const last = line[line.length - 1];
      if (last && last.style === piece.style && last.end === piece.start) {
        last.text += piece.text;
        last.width += piece.width;
        last.end = piece.end;
      } else line.push({ ...piece });
      used += piece.width;
    }
    if (ink) inked = used;
  };
  const breakLine = (end: number) => {
    lines.push(finishLine(line, lineStart, end, inked, strut, base));
    line = [];
    used = inked = 0;
    lineStart = end;
  };
  let offset = 0;
  for (const paragraph of text.split('\n')) {
    lineStart = offset;
    for (const match of paragraph.matchAll(/(\S*)(\s*)/gu)) {
      if (!match[0]) continue;
      const start = offset + match.index!,
        wordEnd = start + match[1].length,
        end = start + match[0].length;
      const word = pieceAt(start, wordEnd),
        space = pieceAt(wordEnd, end);
      const wordWidth = sum(word);
      if (word.length && line.length && used + wordWidth > width) breakLine(start);
      if (wordWidth <= width || !word.length) append(word, word.length > 0);
      else {
        // A word wider than the line breaks between characters.
        const stops = graphemes(text, start, wordEnd);
        for (let i = 0; i < stops.length - 1; i++) {
          const character = pieceAt(stops[i], stops[i + 1]);
          if (line.length && used + sum(character) > width) breakLine(stops[i]);
          append(character, true);
        }
      }
      // Trailing spaces hang past the edge, like pre-wrap in the editor.
      append(space, false);
    }
    breakLine(offset + paragraph.length);
    offset += paragraph.length + 1;
  }
  return lines;
}

function finishLine(
  pieces: RichPiece[],
  start: number,
  end: number,
  width: number,
  strut: { ascent: number; descent: number },
  base: RichBase,
): RichLine {
  // CSS inline layout: each box is centred in its own line-height (half leading)
  // and boxes share a baseline; the root's strut always takes part.
  const box = (size: number, m: { ascent: number; descent: number }) => {
    const half = (size * base.lineHeight - m.ascent - m.descent) / 2;
    return { top: m.ascent + half, bottom: m.descent + half };
  };
  let { top, bottom } = box(base.size, strut);
  let size = base.size;
  for (const piece of pieces) {
    const b = box(piece.size, piece);
    top = Math.max(top, b.top);
    bottom = Math.max(bottom, b.bottom);
    size = Math.max(size, piece.size);
  }
  return { pieces, start, end, width, height: top + bottom, baseline: top, size };
}

export const richTextHeight = (lines: readonly RichLine[]) =>
  lines.reduce((sum, line) => sum + line.height, 0);
export const richTextWidth = (lines: readonly RichLine[]) =>
  lines.reduce((max, line) => Math.max(max, line.width), 0);

export interface RichPlacement {
  x: number;
  y: number;
  // Centred lines sit around x; otherwise x is the left edge.
  align?: 'left' | 'center';
}
export interface PlacedPiece {
  piece: RichPiece;
  line: RichLine;
  left: number; // left edge of the piece box
  baseline: number;
  top: number; // content area of the piece's font (what CSS backgrounds cover)
  height: number;
}
export function placeRichText(
  lines: readonly RichLine[],
  at: RichPlacement,
  visible?: { top: number; bottom: number },
): PlacedPiece[] {
  const placed: PlacedPiece[] = [];
  let top = at.y;
  for (const line of lines) {
    const lineTop = top;
    top += line.height;
    if (visible && (top < visible.top || lineTop > visible.bottom)) continue;
    const baseline = lineTop + line.baseline;
    let left = at.align === 'center' ? at.x - line.width / 2 : at.x;
    for (const piece of line.pieces) {
      placed.push({
        piece,
        line,
        left,
        baseline,
        top: baseline - piece.ascent,
        height: piece.ascent + piece.descent,
      });
      left += piece.width;
    }
  }
  return placed;
}

// Ink extent of the lines, like textInkBounds: blank lines keep their full box
// so the caret has room.
export function richInkBounds(ctx: Measure, lines: readonly RichLine[], base: RichBase) {
  let top = Infinity,
    bottom = -Infinity,
    y = 0;
  for (const line of lines) {
    let ascent = 0,
      descent = 0,
      visible = false;
    for (const piece of line.pieces) {
      if (!piece.text.replace(/​/g, '').trim()) continue;
      ctx.font = fontOf(piece.style, base);
      const m = ctx.measureText(piece.text);
      ascent = Math.max(ascent, m.actualBoundingBoxAscent ?? piece.ascent);
      descent = Math.max(descent, m.actualBoundingBoxDescent ?? piece.descent);
      visible = true;
    }
    top = Math.min(top, visible ? y + line.baseline - ascent : y);
    bottom = Math.max(bottom, visible ? y + line.baseline + descent : y + line.height);
    y += line.height;
  }
  if (!lines.length) return { top: 0, height: 1 };
  return { top, height: Math.max(1, bottom - top) };
}

export const dustColor = (dark: boolean) => (dark ? '#cddaeb' : '#606e80');

// Deterministic dust, so repeated exports are identical.
function dust(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  dot: number,
) {
  let seed = Math.floor(x * 7 + y * 13 + w * 3) >>> 0 || 1;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4 * dot);
  ctx.fill();
  for (let i = 0, count = Math.ceil((w * h) / (26 * dot * dot)); i < count; i++) {
    ctx.globalAlpha = 0.35 + random() * 0.55;
    ctx.beginPath();
    ctx.arc(x + random() * w, y + random() * h, (0.55 + random() * 0.45) * dot, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export interface RichDrawOptions extends RichPlacement {
  color: string;
  strikeAll?: boolean;
  dark?: boolean;
  // Spoiler regions (by start) this viewer has revealed. Others stay hidden:
  // 'dust' paints still dust (exports), 'veil' only the faint backing the
  // canvas's animated dust layer sits on.
  revealed?: (start: number) => boolean;
  hidden?: 'dust' | 'veil';
  // Dust grain in drawing units (1 = how it looks on screen at 100%).
  dot?: number;
  visible?: { top: number; bottom: number };
}

export function drawRichText(
  ctx: CanvasRenderingContext2D,
  lines: readonly RichLine[],
  base: RichBase,
  options: RichDrawOptions,
) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const { piece, left, baseline, top, height } of placeRichText(
    lines,
    options,
    options.visible,
  )) {
    const { style } = piece;
    if (piece.spoiler !== undefined && !options.revealed?.(piece.spoiler)) {
      if (options.hidden === 'veil') {
        ctx.save();
        ctx.globalAlpha = 0.07;
        ctx.fillStyle = dustColor(!!options.dark);
        ctx.fillRect(left, top, piece.width, height);
        ctx.restore();
      } else dust(ctx, left, top, piece.width, height, dustColor(!!options.dark), options.dot || 1);
      continue;
    }
    if (style.highlight || style.code) {
      ctx.save();
      ctx.globalAlpha = style.highlight ? (options.dark ? 0.34 : 0.42) : 0.16;
      ctx.fillStyle = style.highlight || '#788ca5';
      ctx.beginPath();
      ctx.roundRect(left, top, piece.width, height, style.code ? piece.size * 0.25 : 3);
      ctx.fill();
      ctx.restore();
    }
    ctx.font = fontOf(style, base);
    ctx.fillStyle = style.color || options.color;
    ctx.fillText(piece.text, left + piece.lead, baseline);
    const thickness = Math.max(base.size / 16, piece.size / 16);
    if (style.underline) ctx.fillRect(left, baseline + piece.size * 0.12, piece.width, thickness);
    if (style.strike) ctx.fillRect(left, baseline - piece.size * 0.3, piece.width, thickness);
    if (options.strikeAll) {
      // The object's own strikethrough is the root's decoration: base colour and position.
      ctx.fillStyle = options.color;
      ctx.fillRect(
        left,
        baseline - base.size * 0.3 - base.size / 32,
        piece.width,
        Math.max(base.size / 16, 0.0001),
      );
    }
  }
}

export interface SpoilerBox {
  start: number; // region key
  x: number;
  y: number;
  width: number;
  height: number;
}
export function spoilerBoxes(lines: readonly RichLine[], at: RichPlacement): SpoilerBox[] {
  return placeRichText(lines, at)
    .filter(({ piece }) => piece.spoiler !== undefined)
    .map(({ piece, left, top, height }) => ({
      start: piece.spoiler!,
      x: left,
      y: top,
      width: piece.width,
      height,
    }));
}
