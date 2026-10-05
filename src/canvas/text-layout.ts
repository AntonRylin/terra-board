import { CanvasTextMetrics, TextStyle } from 'pixi.js';
import type { CanvasObject } from '../model';
import { textAppearance } from './text-style';
import { localToWorld } from './transform';
import { frameTitleSize } from './frame-title-size';
import { textInkBounds } from './text-ink';

type Layout = {
  appearance: ReturnType<typeof textAppearance> & {
    wrapWidth: number;
    labelGap?: number;
    inkTop?: number;
    inkHeight?: number;
  };
  metrics: CanvasTextMetrics;
  editorContentHeight?: number;
};
const cache = new Map<string, Layout>();
let probe: HTMLTextAreaElement | undefined;
let inkProbe: CanvasRenderingContext2D | undefined;

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
  text = (o.type === 'image' ? o.imageTitle : o.type === 'document' ? o.documentTitle : o.text) ||
    '',
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
  ]);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const base = { ...textAppearance(o), ...titleSize };
  const fittedBox = o.type === 'note' || (o.type === 'text' && !!o.textBox);
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
    // Pixi drops a trailing empty line; the native editor needs it for the caret.
    const measuredText = /[\r\n][\t ]*$/.test(text) ? text + '\u200b' : text;
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
    return { appearance, metrics };
  };
  let result = measure(base.fontSize);
  if (o.type === 'frame' && frameZoom !== undefined) {
    // Cap the entire wrapped title, not just each glyph. Long names must not
    // turn into a heading block almost as tall as their frame when zoomed out.
    const budget = o.height * 0.16;
    const fits = (layout: Layout) =>
      Math.max(1, layout.metrics.lines.length) * layout.appearance.lineHeight +
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
    const fits = (layout: Layout) => {
      const width = Math.max(1, o.width - layout.appearance.padding * 2);
      const height = Math.max(1, o.height - layout.appearance.padding * 2);
      return (
        layout.metrics.maxLineWidth <= width &&
        Math.max(
          layout.metrics.height,
          layout.metrics.lines.length * layout.appearance.lineHeight,
        ) <=
          height - 1 &&
        editorHeight(text, layout.appearance) <= height - 1
      );
    };
    if (!fits(result)) {
      let low = 0.0001,
        high = base.fontSize;
      result = measure(low);
      for (let i = 0; i < 16; i++) {
        const mid = (low + high) / 2,
          candidate = measure(mid);
        if (fits(candidate)) {
          low = mid;
          result = candidate;
        } else high = mid;
      }
    }
  }
  result.editorContentHeight = Math.max(
    Math.max(1, result.metrics.lines.length) * result.appearance.lineHeight,
    fittedBox ? editorHeight(text, result.appearance) : 0,
  );
  if (o.type === 'text' && !o.textBox) {
    inkProbe ??= document.createElement('canvas').getContext('2d')!;
    const a = result.appearance;
    inkProbe.font = `${a.fontWeight} ${a.fontSize}px ${a.fontFamily}`;
    const ink = textInkBounds(result.metrics.lines, a.lineHeight, (line) =>
      inkProbe!.measureText(line),
    );
    a.inkTop = ink.top;
    a.inkHeight = ink.height;
  }
  cache.set(key, result);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return result;
}

// Free text grows with its explicit lines. Resized text boxes retain the user's
// rectangle; textLayout wraps and fits their contents instead of widening them.
export function fitTextObject(
  o: CanvasObject,
  text = (o.type === 'image' ? o.imageTitle : o.type === 'document' ? o.documentTitle : o.text) ||
    '',
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
