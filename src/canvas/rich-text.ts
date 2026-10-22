// Inline formatting is stored beside plain text as non-overlapping style ranges.
// The text itself stays a plain string, so search, sync and MCP keep working.
import type { CanvasObject } from '../model';

// The text an object shows on the board: an image's or document's title, else `text`.
export const shownText = (o: CanvasObject) =>
  (o.type === 'image' ? o.imageTitle : o.type === 'document' ? o.documentTitle : o.text) || '';
export const shownMarksKey = (o: CanvasObject) =>
  o.type === 'image' || o.type === 'document' ? 'titleMarks' : 'textMarks';
export const shownMarks = (o: CanvasObject) => o[shownMarksKey(o)];

// Board text, notes and the names of frames, images and documents render their
// formatting; shapes and other titles stay plain.
export const hasRichText = (o: CanvasObject) =>
  ['text', 'note', 'frame', 'image', 'document'].includes(o.type) && !!shownMarks(o)?.length;

export const textFonts = ['serif', 'mono', 'hand', 'condensed', 'inter'] as const;
export type TextFont = (typeof textFonts)[number];
export const textSizes = [0.8, 1, 1.25, 1.5, 2] as const;
const flags = ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler'] as const;
export type TextFlag = (typeof flags)[number];

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  spoiler?: boolean;
  color?: string;
  highlight?: string;
  font?: TextFont;
  size?: number;
}
export interface TextMark extends TextStyle {
  start: number;
  end: number;
}
// null removes a property; undefined leaves it unchanged.
export type StylePatch = { [K in keyof TextStyle]?: TextStyle[K] | null };
export interface StyleRun {
  start: number;
  end: number;
  style: TextStyle;
}

const hex = /^#[0-9a-f]{6}$/i;
export function cleanStyle(value: any): TextStyle {
  const style: TextStyle = {};
  if (!value || typeof value !== 'object') return style;
  for (const flag of flags) if (value[flag] === true) style[flag] = true;
  if (typeof value.color === 'string' && hex.test(value.color)) style.color = value.color;
  if (typeof value.highlight === 'string' && hex.test(value.highlight))
    style.highlight = value.highlight;
  if (textFonts.includes(value.font)) style.font = value.font;
  if (
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    value.size >= 0.5 &&
    value.size <= 3 &&
    value.size !== 1
  )
    style.size = value.size;
  return style;
}
const styleKey = (style: TextStyle) => JSON.stringify(cleanStyle(style));
export const sameStyle = (a: TextStyle, b: TextStyle) => styleKey(a) === styleKey(b);
const plain = (style: TextStyle) => Object.keys(style).length === 0;

// Every character is covered by exactly one run; unstyled text has an empty style.
export function styleRuns(length: number, marks?: readonly TextMark[]): StyleRun[] {
  const valid = (marks || [])
    .map((m) => ({
      start: Math.max(0, Math.min(length, Math.floor(m.start))),
      end: Math.max(0, Math.min(length, Math.floor(m.end))),
      style: cleanStyle(m),
    }))
    .filter((m) => m.end > m.start && !plain(m.style))
    .sort((a, b) => a.start - b.start);
  const runs: StyleRun[] = [];
  let at = 0;
  const push = (start: number, end: number, style: TextStyle) => {
    if (end <= start) return;
    const last = runs[runs.length - 1];
    if (last && last.end === start && sameStyle(last.style, style)) last.end = end;
    else runs.push({ start, end, style });
  };
  for (const mark of valid) {
    // Overlapping input (only from external data) keeps the earlier range.
    const start = Math.max(at, mark.start);
    if (mark.end <= start) continue;
    push(at, start, {});
    push(start, mark.end, mark.style);
    at = mark.end;
  }
  push(at, length, {});
  return runs;
}

export function runsToMarks(runs: readonly StyleRun[]): TextMark[] {
  return runs
    .filter((run) => run.end > run.start && !plain(run.style))
    .map((run) => ({ start: run.start, end: run.end, ...cleanStyle(run.style) }));
}

export function normalizeMarks(length: number, marks?: readonly TextMark[]): TextMark[] {
  return runsToMarks(styleRuns(length, marks));
}

// Trims surrounding whitespace, keeping each style on the characters that remain.
export function trimMarked(text: string, marks?: readonly TextMark[]) {
  const trimmed = text.trim(),
    shift = text.length - text.trimStart().length;
  return {
    text: trimmed,
    marks: normalizeMarks(
      trimmed.length,
      marks?.map((m) => ({ ...m, start: m.start - shift, end: m.end - shift })),
    ),
  };
}

// Drops line breaks left at the end of a title, clipping styles to the text that remains.
export function trimTrailingBreaks(text: string, marks?: readonly TextMark[]) {
  const trimmed = text.replace(/[\r\n]\s*$/, '');
  return { text: trimmed, marks: normalizeMarks(trimmed.length, marks) };
}

// Enter in board text starts a new line, so a habitual Enter before clicking
// away leaves an empty last row that makes a one-line title two lines tall.
export function withoutTrailingBreaks(o: CanvasObject): CanvasObject {
  if (o.type !== 'text' || !o.text || !/[\r\n]\s*$/.test(o.text)) return o;
  const { textMarks: _, ...rest } = o,
    trimmed = trimTrailingBreaks(o.text, o.textMarks);
  return {
    ...rest,
    text: trimmed.text,
    ...(trimmed.marks.length ? { textMarks: trimmed.marks } : {}),
  };
}

// Untrusted data: drop anything malformed rather than rejecting the whole object.
export function sanitizeMarks(value: unknown, length: number): TextMark[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const marks = normalizeMarks(
    length,
    value
      .slice(0, 5000)
      .filter(
        (m) =>
          m &&
          typeof m === 'object' &&
          Number.isInteger(m.start) &&
          Number.isInteger(m.end) &&
          m.start >= 0 &&
          m.end > m.start,
      ),
  );
  return marks.length ? marks : undefined;
}

function patched(style: TextStyle, patch: StylePatch): TextStyle {
  const next: any = { ...style };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === false) delete next[key];
    else next[key] = value;
  }
  return cleanStyle(next);
}

export function applyStyle(
  length: number,
  marks: readonly TextMark[] | undefined,
  start: number,
  end: number,
  patch: StylePatch,
): TextMark[] {
  start = Math.max(0, Math.min(length, start));
  end = Math.max(start, Math.min(length, end));
  const runs: StyleRun[] = [];
  for (const run of styleRuns(length, marks)) {
    const pieces: [number, number, boolean][] = [
      [run.start, Math.min(run.end, start), false],
      [Math.max(run.start, start), Math.min(run.end, end), true],
      [Math.max(run.start, end), run.end, false],
    ];
    for (const [a, b, inside] of pieces)
      if (b > a)
        runs.push({ start: a, end: b, style: inside ? patched(run.style, patch) : run.style });
  }
  return normalizeMarks(length, runsToMarks(runs));
}

// The style shared by every character of a range: flags only when all have them.
export function commonStyle(
  length: number,
  marks: readonly TextMark[] | undefined,
  start: number,
  end: number,
): TextStyle {
  const covered = styleRuns(length, marks).filter((run) => run.end > start && run.start < end);
  if (!covered.length) return {};
  const [first, ...rest] = covered.map((run) => run.style);
  const common: any = {};
  for (const [key, value] of Object.entries(first))
    if (rest.every((style: any) => style[key] === value)) common[key] = value;
  return common;
}

// Re-anchor ranges after an edit. Inserted text takes the style of the text it
// replaces, or of the character before the caret, plus any pending style.
export function rebaseMarks(
  before: string,
  after: string,
  marks: readonly TextMark[] | undefined,
  pending?: StylePatch | null,
  caret?: number,
): TextMark[] {
  if (!marks?.length && !pending) return [];
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before[prefix] === after[prefix]) prefix++;
  // When the caret is known, keep the change ending there (typing "a" after "a").
  if (caret !== undefined)
    prefix = Math.min(prefix, Math.max(0, caret - Math.max(0, after.length - before.length)));
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const removed = before.length - prefix - suffix;
  const inserted = after.length - prefix - suffix;
  const runs = styleRuns(before.length, marks);
  const styleAt = (index: number) =>
    runs.find((run) => run.start <= index && index < run.end)?.style || {};
  let inherited = removed > 0 ? styleAt(prefix) : prefix > 0 ? styleAt(prefix - 1) : {};
  if (pending) inherited = patched(inherited, pending);
  const next: StyleRun[] = [];
  for (const run of runs) {
    if (run.start < prefix) next.push({ ...run, end: Math.min(run.end, prefix) });
  }
  if (inserted > 0) next.push({ start: prefix, end: prefix + inserted, style: inherited });
  const shift = inserted - removed;
  for (const run of runs) {
    const start = Math.max(run.start, prefix + removed);
    if (run.end > start)
      next.push({ start: start + shift, end: run.end + shift, style: run.style });
  }
  return normalizeMarks(after.length, runsToMarks(next));
}

// Contiguous spoiler regions, keyed by their start; one click reveals a whole region.
export function spoilerRegions(runs: readonly StyleRun[]) {
  const regions: { start: number; end: number }[] = [];
  for (const run of runs) {
    if (!run.style.spoiler) continue;
    const last = regions[regions.length - 1];
    if (last && last.end === run.start) last.end = run.end;
    else regions.push({ start: run.start, end: run.end });
  }
  return regions;
}

export const fontFamilies: Record<TextFont | 'sans', string> = {
  sans: '"Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Cascadia Mono", Consolas, monospace',
  hand: '"Segoe Print", "Segoe UI", sans-serif',
  condensed: 'Bahnschrift, "Segoe UI", sans-serif',
  // Bundled with the app (src/fonts.ts), a free near-twin of Apple's San Francisco.
  inter: '"Inter Variable", "Segoe UI", sans-serif',
};
