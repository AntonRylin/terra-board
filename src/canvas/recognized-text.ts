import type { ImageCrop } from '../model';

// Text found on an image or PDF page. Boxes are fractions (0-1) of the page so
// the same result lines up at any zoom.
export interface RecognizedWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Attach to the previous word without a space (CJK, split PDF runs). */
  join?: boolean;
  /** Clockwise rotation in degrees around the box's top-left corner. */
  angle?: number;
}
export interface RecognizedLine {
  words: RecognizedWord[];
}
export interface RecognizedText {
  lines: RecognizedLine[];
  source?: 'pdf' | 'ocr';
}

export const lineText = (line: RecognizedLine) =>
  line.words.map((word, index) => (index && !word.join ? ' ' : '') + word.text).join('');

const lineBox = (line: RecognizedLine) => {
  const top = Math.min(...line.words.map((word) => word.y));
  return { top, bottom: Math.max(...line.words.map((word) => word.y + word.height)) };
};

// A gap clearly wider than the text's usual line spacing starts a new paragraph,
// so evenly spaced lines stay together however loosely they are set.
export function paragraphStarts(text: RecognizedText): boolean[] {
  const gaps = text.lines.map((line, index) => {
    if (!index || !line.words.length || !text.lines[index - 1].words.length) return NaN;
    const previous = lineBox(text.lines[index - 1]),
      current = lineBox(line);
    const height = Math.max(previous.bottom - previous.top, current.bottom - current.top);
    return height > 0 ? (current.top - previous.bottom) / height : NaN;
  });
  const sorted = gaps.filter((gap) => gap >= 0).sort((a, b) => a - b);
  const usual = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  return gaps.map((gap) => gap > Math.max(0.6, usual * 1.6 + 0.2));
}

export function recognizedString(text: RecognizedText): string {
  const breaks = paragraphStarts(text);
  return text.lines
    .map((line, index) => (breaks[index] ? '\n' : '') + lineText(line))
    .filter((line) => line.trim())
    .join('\n')
    .trim();
}

// Keep the words visible inside a cropped image, in the crop's coordinates.
export function cropRecognizedText(text: RecognizedText, crop?: ImageCrop): RecognizedText {
  if (!crop || (crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1)) return text;
  const lines = text.lines
    .map((line) => ({
      words: line.words
        .filter((word) => {
          const x = word.x + word.width / 2,
            y = word.y + word.height / 2;
          return (
            x >= crop.x && x <= crop.x + crop.width && y >= crop.y && y <= crop.y + crop.height
          );
        })
        .map((word) => ({
          ...word,
          x: (word.x - crop.x) / crop.width,
          y: (word.y - crop.y) / crop.height,
          width: word.width / crop.width,
          height: word.height / crop.height,
        })),
    }))
    .filter((line) => line.words.length);
  return { ...text, lines };
}

export const characterCount = (text: RecognizedText) =>
  text.lines.reduce(
    (sum, line) => sum + line.words.reduce((count, word) => count + word.text.trim().length, 0),
    0,
  );

type Matrix = number[];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
export interface PdfTextRun {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
  fontName?: string;
}
export interface PdfTextViewport {
  width: number;
  height: number;
  scale: number;
  transform: number[];
}

// Converts pdf.js text content into positioned runs, placed like pdf.js's own
// text layer: the run's baseline minus the font ascent is its top edge.
export function pdfRunsToText(
  items: readonly unknown[],
  viewport: PdfTextViewport,
  styles: Record<string, { ascent?: number; vertical?: boolean }> = {},
): RecognizedText {
  const lines: RecognizedLine[] = [];
  let words: RecognizedWord[] = [],
    spaced = false,
    previous: { end: number; baseline: number; size: number; angle: number } | null = null;
  const close = () => {
    if (words.length) lines.push({ words });
    words = [];
    previous = null;
    spaced = false;
  };
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || typeof (raw as PdfTextRun).str !== 'string') continue;
    const item = raw as PdfTextRun;
    const value = item.str.replace(/\s+/g, ' ');
    if (!value.trim()) {
      if (item.hasEOL) close();
      else if (value) spaced = true;
      continue;
    }
    const style = (item.fontName && styles[item.fontName]) || {};
    const tx = multiply(viewport.transform, item.transform);
    let angle = Math.atan2(tx[1], tx[0]);
    if (style.vertical) angle += Math.PI / 2;
    const size = Math.hypot(tx[2], tx[3]);
    if (!(size > 0) || !Number.isFinite(size)) continue;
    const ascent =
      size * (style.ascent && style.ascent > 0 && style.ascent < 1.5 ? style.ascent : 0.8);
    const left = angle === 0 ? tx[4] : tx[4] + ascent * Math.sin(angle),
      top = angle === 0 ? tx[5] - ascent : tx[5] - ascent * Math.cos(angle);
    const width = (style.vertical ? item.height : item.width) * viewport.scale;
    if (
      previous &&
      (Math.abs(previous.angle - angle) > 0.01 ||
        Math.abs(previous.baseline - tx[5]) > Math.max(previous.size, size) * 0.5)
    )
      close();
    const gap = previous ? left - previous.end : 0;
    const join =
      !!previous &&
      !spaced &&
      !/^\s/.test(value) &&
      Math.abs(gap) < Math.min(previous.size, size) * 0.15;
    words.push({
      text: value.trim(),
      x: left / viewport.width,
      y: top / viewport.height,
      width: Math.max(0, width) / viewport.width,
      height: size / viewport.height,
      ...(join ? { join: true } : {}),
      ...(Math.abs(angle) > 0.01 ? { angle: (angle * 180) / Math.PI } : {}),
    });
    spaced = /\s$/.test(value);
    previous = { end: left + width, baseline: tx[5], size, angle };
    if (item.hasEOL) close();
  }
  close();
  return { lines, source: 'pdf' };
}
