import { CanvasTextMetrics, TextStyle } from 'pixi.js';
import type { CanvasObject } from '../model';
import { textAppearance } from './text-style';
import { localToWorld } from './transform';
import { frameTitleSize } from './frame-title-size';
import { textInkBounds } from './text-ink';
import { hasRichText, shownMarks, shownText } from './rich-text';
import {
  layoutRichText,
  richInkBounds,
  richTextHeight,
  richTextWidth,
  type RichBase,
  type RichLine,
} from './rich-text-canvas';

type Layout = {
  appearance: ReturnType<typeof textAppearance> & {
    wrapWidth: number;
    labelGap?: number;
    inkTop?: number;
    inkHeight?: number;
  };
  metrics: Pick<CanvasTextMetrics, 'lines' | 'width' | 'height' | 'maxLineWidth'>;
  editorContentHeight?: number;
  // Formatted text lays out its own lines, which the renderer then draws as is.
  rich?: { lines: RichLine[]; base: RichBase };
  // A note's word had to break between letters to fit its width.
  split?: boolean;
};

// Scripts written without spaces wrap between any letters, so breaking there
// is normal and never counts as splitting a word.
const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const spacedWords = (text: string) => text.split(/\s+/).filter((w) => w && !unspaced.test(w));
// Notes shrink their text to keep words whole, but not below about a third of the
// note's own automatic size: past that a long word breaks between letters instead.
export const noteWordFloor = (o: CanvasObject, fontSize: number) =>
  Math.min(fontSize, Math.max(1, Math.min(o.width, o.height) * 0.3) * 0.35);
const cache = new Map<string, Layout>();
// Frame titles are sized per zoom level, so an animated zoom makes new entries
// on every frame. Kept apart, they cannot push note and text layouts out.
const titleCache = new Map<string, Layout>();
// Typing and resizing also make a new layout per key press or pointer move.
// Only an object's latest few stay cached, so one long edit cannot evict the
// layouts of everything else on the board.
const recentKeys = new Map<string, string[]>();
// The size the last search found for each object. After a small edit it is
// usually still the answer; it is checked against the search's own end
// condition, never assumed.
const fitHints = new Map<string, { shape: string; size: number }>();
function remember<T>(map: Map<string, T>, key: string, value: T, limit: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}
let probe: HTMLTextAreaElement | undefined;
let inkProbe: CanvasRenderingContext2D | undefined;
const measureContext = () => (inkProbe ??= document.createElement('canvas').getContext('2d')!);

// Use the browser's own line-breaking rules too (notably emoji and mixed
// scripts). One hidden probe is reused only on layout cache misses. Measuring
// at maximum zoom avoids tiny-font rounding hiding an extra editor line.
function editorHeight(text: string, a: Layout['appearance']) {
  if (!probe) {
    probe = document.createElement('textarea');
    probe.setAttribute('aria-hidden', 'true');
    probe.tabIndex = -1;
    probe.style.cssText =
      'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;contain:strict;box-sizing:content-box;padding:0;border:0;margin:0;height:1px;overflow:hidden;white-space:pre-wrap;overflow-wrap:break-word;';
    document.body.appendChild(probe);
  }
  probe.style.width = `${a.wrapWidth * 8}px`;
  probe.style.font = `${a.fontWeight} ${a.fontSize * 8}px ${a.fontFamily}`;
  probe.style.lineHeight = `${a.lineHeight * 8}px`;
  probe.value = text;
  return probe.scrollHeight / 8;
}

// Fit in board units, independent of pan/zoom. Reuse layouts while rendering and
// editing so fitting does not run again for each GPU frame or change the note size.
export function textLayout(
  o: CanvasObject,
  text = shownText(o),
  frameZoom?: number,
): Layout {
  const titleSize = o.type === 'frame' ? frameTitleSize(o, frameZoom) : undefined;
  const key = JSON.stringify([
    o.type,
    o.width,
    o.height,
    o.fontSize,
    o.color,
    o.textBox,
    o.bold,
    text,
    titleSize,
    hasRichText(o) ? shownMarks(o) : null,
  ]);
  const store = titleSize && frameZoom !== undefined ? titleCache : cache;
  const cached = store.get(key);
  if (cached) {
    store.delete(key);
    store.set(key, cached);
    return cached;
  }
  const base = { ...textAppearance(o), ...titleSize };
  const fittedBox = o.type === 'note' || (o.type === 'text' && !!o.textBox);
  const rich = hasRichText(o);
  // Plain text: the longest word at 100px, scaled to each candidate size.
  let longestWord: number | undefined;
  if (o.type === 'note' && !rich) {
    const ctx = measureContext();
    ctx.font = `${base.fontWeight} 100px ${base.fontFamily}`;
    longestWord = 0;
    for (const word of spacedWords(text))
      longestWord = Math.max(longestWord, ctx.measureText(word).width);
  }
  const measure = (fontSize: number): Layout => {
    const padding = o.type === 'text' ? fontSize * 0.14 : base.padding;
    // Leave room for the handwriting font's ink overhang at a wrapped edge.
    // Checking its ink width against the exact wrap width makes long unbroken
    // words fail fitting at nearly every size despite wrapping successfully.
    const wrapWidth = Math.max(
      1,
      o.width - padding * 2 - (o.type === 'note' ? fontSize * 0.25 + 1 : 0),
    );
    const appearance = {
      ...base,
      padding,
      fontSize,
      lineHeight: fontSize * (o.type === 'text' ? 1.3 : 1.45),
      wrapWidth,
    };
    if (o.type === 'frame' && frameZoom !== undefined)
      appearance.labelGap = Math.min(base.labelGap!, fontSize * 0.4);
    if (rich) {
      const richBase = {
        size: fontSize,
        weight: appearance.fontWeight,
        family: appearance.fontFamily,
        lineHeight: appearance.lineHeight / fontSize,
      };
      const lines = layoutRichText(
        measureContext(),
        text,
        shownMarks(o),
        richBase,
        o.type !== 'text' || o.textBox ? wrapWidth : Infinity,
      );
      const width = richTextWidth(lines);
      // A wrap with letters on both sides of it cut a word.
      const split =
        o.type === 'note' &&
        lines.some((line, i) => {
          const at = line.end;
          if (i === lines.length - 1 || lines[i + 1].start !== at) return false;
          const before = text[at - 1] || ' ',
            after = text[at] || ' ';
          return !/\s/.test(before + after) && !unspaced.test(before + after);
        });
      return {
        appearance,
        metrics: {
          lines: lines.map((line) => text.slice(line.start, line.end)),
          width,
          maxLineWidth: width,
          height: richTextHeight(lines),
        },
        rich: { lines, base: richBase },
        split,
      };
    }
    // Pixi drops a trailing empty line; the native editor needs it for the caret.
    const measuredText = /[\r\n][\t ]*$/.test(text) ? text + '\u200b' : text;
    // No style here has letter spacing. On its fallback path Pixi still segments
    // every measured token into graphemes just to multiply their count by zero.
    CanvasTextMetrics.experimentalLetterSpacing = true;
    const metrics = CanvasTextMetrics.measureText(
      measuredText,
      new TextStyle({
        fontFamily: appearance.fontFamily,
        fontSize,
        fontWeight: appearance.fontWeight,
        lineHeight: appearance.lineHeight,
        wordWrap: o.type !== 'text' || !!o.textBox,
        breakWords: true,
        whiteSpace: 'pre',
        wordWrapWidth: wrapWidth,
      }),
    );
    // Pixi breaks a word between letters exactly when it is wider than the wrap width.
    const split = longestWord !== undefined && (longestWord * fontSize) / 100 > wrapWidth;
    return { appearance, metrics, split };
  };
  let result = measure(base.fontSize);
  if (o.type === 'frame' && frameZoom !== undefined) {
    // Cap the entire wrapped title, not just each glyph. Long names must not
    // turn into a heading block almost as tall as their frame when zoomed out.
    const budget = o.height * 0.16;
    const fits = (layout: Layout) =>
      (layout.rich
        ? layout.metrics.height
        : Math.max(1, layout.metrics.lines.length) * layout.appearance.lineHeight) +
        (layout.appearance.labelGap || 0) <=
      budget;
    if (!fits(result)) {
      let low = 0.0001,
        high = base.fontSize;
      result = measure(low);
      for (let i = 0; i < 14; i++) {
        const mid = (low + high) / 2,
          candidate = measure(mid);
        if (fits(candidate)) {
          low = mid;
          result = candidate;
        } else high = mid;
      }
    }
  }
  if (fittedBox) {
    // `quick` skips the hidden editor probe. It only ever accepts more than the full
    // check does, so it narrows the search cheaply before the full check confirms.
    const floor = o.type === 'note' ? noteWordFloor(o, base.fontSize) : 0;
    const fits = (layout: Layout, quick = false) => {
      // Smaller type that keeps every word whole beats larger type that cuts one.
      if (layout.split && layout.appearance.fontSize > floor) return false;
      const width = Math.max(1, o.width - layout.appearance.padding * 2);
      const height = Math.max(1, o.height - layout.appearance.padding * 2);
      // Pixi wraps by adding up word widths, so a wrapped line can measure a hair wider
      // than its limit. Counting that as overflow rejects sizes that fit, and the search
      // below then settles on needlessly small type. Notes already wrap this much short.
      const slack = o.type === 'text' ? layout.appearance.fontSize * 0.25 + 1 : 0;
      // Formatted lines are already laid out the way the editor's spans wrap.
      if (layout.rich)
        return layout.metrics.maxLineWidth <= width + slack && layout.metrics.height <= height - 1;
      return (
        layout.metrics.maxLineWidth <= width + slack &&
        Math.max(
          layout.metrics.height,
          layout.metrics.lines.length * layout.appearance.lineHeight,
        ) <=
          height - 1 &&
        (quick || editorHeight(text, layout.appearance) <= height - 1)
      );
    };
    if (!fits(result)) {
      // The search ends on the largest of 2^16 equal steps below the base size that fits.
      const shape = JSON.stringify([
        o.type,
        o.width,
        o.height,
        base.fontSize,
        o.textBox,
        o.bold,
        rich,
      ]);
      const steps = 65536;
      const step = (base.fontSize - 0.0001) / steps;
      const size = (i: number) => 0.0001 + i * step;
      const hint = fitHints.get(o.id);
      let found = false;
      if (hint?.shape === shape && hint.size > 0.0001 && hint.size + step <= base.fontSize) {
        const candidate = measure(hint.size);
        if (fits(candidate) && !fits(measure(hint.size + step))) {
          result = candidate;
          found = true;
        }
      }
      if (!found) {
        const search = (top: number, quick: boolean) => {
          let low = 0,
            high = top,
            best: Layout | undefined;
          while (high - low > 1) {
            const mid = (low + high) >> 1,
              candidate = measure(size(mid));
            if (fits(candidate, quick)) {
              low = mid;
              best = candidate;
            } else high = mid;
          }
          return { index: low, layout: best };
        };
        let { index, layout } = search(steps, true);
        // Nothing larger passed the quick check, so nothing larger passes the full one.
        if (layout && !fits(layout)) ({ index, layout } = search(index, false));
        result = layout || measure(size(0));
        remember(fitHints, o.id, { shape, size: size(index) }, 4000);
      }
    }
  }
  result.editorContentHeight = result.rich
    ? result.metrics.height
    : Math.max(
        Math.max(1, result.metrics.lines.length) * result.appearance.lineHeight,
        fittedBox ? editorHeight(text, result.appearance) : 0,
      );
  if (o.type === 'text' && !o.textBox && result.rich) {
    const ink = richInkBounds(measureContext(), result.rich.lines, result.rich.base);
    result.appearance.inkTop = ink.top;
    result.appearance.inkHeight = ink.height;
  } else if (o.type === 'text' && !o.textBox) {
    inkProbe ??= document.createElement('canvas').getContext('2d')!;
    const a = result.appearance;
    inkProbe.font = `${a.fontWeight} ${a.fontSize}px ${a.fontFamily}`;
    const ink = textInkBounds(result.metrics.lines, a.lineHeight, (line) =>
      inkProbe!.measureText(line),
    );
    a.inkTop = ink.top;
    a.inkHeight = ink.height;
  }
  remember(store, key, result, store === titleCache ? 256 : 4000);
  if (store === cache) {
    const keys = recentKeys.get(o.id) || [];
    keys.push(key);
    if (keys.length > 4) {
      const stale = keys.shift()!;
      if (!keys.includes(stale)) cache.delete(stale);
    }
    remember(recentKeys, o.id, keys, 4000);
  }
  return result;
}

// Free text grows with its explicit lines. Resized text boxes retain the user's
// rectangle; textLayout wraps and fits their contents instead of widening them.
export function fitTextObject(
  o: CanvasObject,
  text = shownText(o),
): CanvasObject {
  if (o.type === 'image') return { ...o, imageTitle: text };
  if (o.type === 'document') return { ...o, documentTitle: text };
  if (o.type !== 'text' || o.textBox) return { ...o, text };
  const { appearance: a, metrics } = textLayout(o, text);
  const fitted = {
    ...o,
    text,
    width: Math.min(
      1e6,
      Math.max(a.fontSize * 0.5, metrics.maxLineWidth) + a.padding * 2 + a.fontSize * 0.08,
    ),
    height: Math.min(
      1e6,
      (a.inkHeight ?? Math.max(1, metrics.lines.length) * a.lineHeight) + a.padding * 2,
    ),
  };
  if (o.rotation) {
    const before = localToWorld(o, { x: 0, y: 0 }),
      after = localToWorld(fitted, { x: 0, y: 0 });
    fitted.x += before.x - after.x;
    fitted.y += before.y - after.y;
  }
  return fitted;
}

// The longest word a note makes room for, in widths of its smallest whole-word
// type: about 29 letters ("wfhwfiowefiowqefhiowehfwiqoeh", bold, is 16.3).
const widestNoteWord = 17;

// A note whose word still breaks at the smallest whole-word size grows just wide
// enough to hold it, keeping its left edge, but never past `widestNoteWord`.
// Longer words break as before. It runs once editing ends, not on each key.
export function widenNoteForWords(o: CanvasObject): CanvasObject {
  if (o.type !== 'note' || !textLayout(o).split) return o;
  const floor = noteWordFloor(o, textAppearance(o).fontSize);
  const wider = (width: number) => ({ ...o, width });
  const cap = Math.ceil(widestNoteWord * floor + floor * 0.25 + 47);
  if (cap <= o.width || textLayout(wider(cap)).split) return o;
  let low = o.width,
    high = cap;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (textLayout(wider(mid)).split) low = mid;
    else high = mid;
  }
  const next = wider(high);
  if (o.rotation) {
    const before = localToWorld(o, { x: 0, y: 0 }),
      after = localToWorld(next, { x: 0, y: 0 });
    next.x += before.x - after.x;
    next.y += before.y - after.y;
  }
  return next;
}

// Pasted text has to land readable inside the visible area without taking it over:
// it may cover about a third of the view. Long lines wrap first; the type only
// shrinks when the wrapped text is still too tall.
export function fitTextToView(
  o: CanvasObject,
  view: { x: number; y: number; width: number; height: number },
  // Text being edited stays where it is, moving only as far as the view requires.
  inPlace = false,
  share = 1 / 3,
): CanvasObject {
  let fitted = fitTextObject(o);
  const limit = { width: view.width * Math.sqrt(share), height: view.height * Math.sqrt(share) };
  if (fitted.width > limit.width || fitted.height > limit.height) {
    const box = {
      ...fitted,
      textBox: true,
      width: Math.min(fitted.width, limit.width),
      height: limit.height,
    };
    // The fitted type rarely fills that area exactly: close the box around its lines.
    const { appearance: a, metrics, editorContentHeight } = textLayout(box);
    fitted = {
      ...box,
      width: Math.min(box.width, Math.ceil(metrics.maxLineWidth + a.padding * 2) + 2),
      height: Math.min(
        box.height,
        Math.ceil(Math.max(editorContentHeight || 0, metrics.height) + a.padding * 2) + 2,
      ),
    };
  }
  const within = (at: number, size: number, from: number, span: number) =>
    Math.max(from, Math.min(at, from + span - size));
  return {
    ...fitted,
    x: inPlace
      ? within(o.x, fitted.width, view.x, view.width)
      : view.x + (view.width - fitted.width) / 2,
    y: inPlace
      ? within(o.y, fitted.height, view.y, view.height)
      : view.y + (view.height - fitted.height) / 2,
  };
}
