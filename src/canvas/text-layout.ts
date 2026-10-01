import { CanvasTextMetrics, TextStyle } from 'pixi.js';
import type { CanvasObject } from '../model';
import { textAppearance } from './text-style';
import { localToWorld } from './transform';

type Layout = {
  appearance: ReturnType<typeof textAppearance> & { wrapWidth: number };
  metrics: CanvasTextMetrics;
  editorContentHeight?: number;
};
const cache = new Map<string, Layout>();
let probe: HTMLTextAreaElement | undefined;

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
  probe.style.font = `400 ${a.fontSize * 8}px ${a.fontFamily}`;
  probe.style.lineHeight = `${a.lineHeight * 8}px`;
  probe.value = text;
  return probe.scrollHeight / 8;
}

// Fit in board units, independent of pan/zoom. Reuse layouts while rendering and
// editing so fitting does not run again for each GPU frame or change the note size.
export function textLayout(
  o: CanvasObject,
  text = (o.type === 'image' ? o.imageTitle : o.text) || '',
): Layout {
  const key = JSON.stringify([o.type, o.width, o.height, o.fontSize, o.color, o.textBox, text]);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const base = textAppearance(o);
  const measure = (fontSize: number): Layout => {
    // Leave room for the handwriting font's ink overhang at a wrapped edge.
    // Checking its ink width against the exact wrap width makes long unbroken
    // words fail fitting at nearly every size despite wrapping successfully.
    const wrapWidth = Math.max(
      1,
      o.width - base.padding * 2 - (o.type === 'note' ? fontSize * 0.25 + 1 : 0),
    );
    const appearance = { ...base, fontSize, lineHeight: fontSize * 1.45, wrapWidth };
    // Pixi drops a trailing empty line; the native editor needs it for the caret.
    const measuredText = /[\r\n][\t ]*$/.test(text) ? text + '\u200b' : text;
    const metrics = CanvasTextMetrics.measureText(
      measuredText,
      new TextStyle({
        fontFamily: appearance.fontFamily,
        fontSize,
        fontWeight: '400',
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
  if (o.type === 'note') {
    const width = Math.max(1, o.width - base.padding * 2);
    const height = Math.max(1, o.height - base.padding * 2);
    const fits = (layout: Layout) =>
      layout.metrics.maxLineWidth <= width &&
      Math.max(layout.metrics.height, layout.metrics.lines.length * layout.appearance.lineHeight) <=
        height - 1 &&
      editorHeight(text, layout.appearance) <= height - 1;
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
    o.type === 'note' ? editorHeight(text, result.appearance) : 0,
  );
  cache.set(key, result);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return result;
}

// Plain text grows with its explicit lines, rather than retaining an arbitrary
// creation rectangle. Keep a little room for ink overhang and the editor caret.
export function fitTextObject(
  o: CanvasObject,
  text = (o.type === 'image' ? o.imageTitle : o.text) || '',
): CanvasObject {
  if (o.type === 'image') return { ...o, imageTitle: text };
  if (o.type !== 'text' || o.textBox) return { ...o, text };
  const { appearance: a, metrics } = textLayout(o, text);
  const fitted = {
    ...o,
    text,
    width: Math.min(
      1e6,
      Math.max(a.fontSize * 0.5, metrics.maxLineWidth) + a.padding * 2 + a.fontSize * 0.08,
    ),
    height: Math.min(1e6, Math.max(1, metrics.lines.length) * a.lineHeight + a.padding * 2),
  };
  if (o.rotation) {
    const before = localToWorld(o, { x: 0, y: 0 }),
      after = localToWorld(fitted, { x: 0, y: 0 });
    fitted.x += before.x - after.x;
    fitted.y += before.y - after.y;
  }
  return fitted;
}
