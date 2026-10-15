import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { textAppearance } from '../src/canvas/text-style.ts';
import { localToWorld } from '../src/canvas/transform.ts';
import { frameTitleSize } from '../src/canvas/frame-title-size.ts';
import * as richCanvas from '../src/canvas/rich-text-canvas.ts';
import { hasRichText } from '../src/canvas/rich-text.ts';

// A 2D context whose characters are half an em wide in whatever font is set.
function halfEmContext() {
  return {
    font: '10px sans-serif',
    measureText(text) {
      const size = parseFloat(/([\d.e-]+)px/.exec(this.font)[1]);
      return {
        width: [...text].length * size * 0.5,
        fontBoundingBoxAscent: size * 0.9,
        fontBoundingBoxDescent: size * 0.25,
        actualBoundingBoxAscent: size * 0.7,
        actualBoundingBoxDescent: size * 0.2,
      };
    },
  };
}

// The real fitting and caching code with a deterministic stand-in for the font
// engine: every character is half an em wide. `measured` counts layout passes.
function fixture() {
  let measured = 0;
  const lines = (text, fontSize, wrapWidth) =>
    Math.max(1, Math.ceil((text.length * fontSize * 0.5) / wrapWidth));
  const CanvasTextMetrics = {
    measureText(text, style) {
      measured++;
      const count = style.wordWrap ? lines(text, style.fontSize, style.wordWrapWidth) : 1;
      const width = text.length * style.fontSize * 0.5;
      return {
        lines: Array(count).fill(text),
        height: count * style.lineHeight,
        width,
        maxLineWidth: style.wordWrap ? Math.min(width, style.wordWrapWidth) : width,
      };
    },
  };
  class TextStyle {
    constructor(options) {
      Object.assign(this, options);
    }
  }
  // The hidden editor probe wraps the same way at eight times the size.
  const probe = {
    style: {},
    value: '',
    setAttribute() {},
    get scrollHeight() {
      const fontSize = parseFloat(/ ([\d.e-]+)px /.exec(this.style.font)[1]);
      return (
        lines(this.value, fontSize, parseFloat(this.style.width)) *
        parseFloat(this.style.lineHeight)
      );
    },
  };
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../src/canvas/text-layout.ts', import.meta.url), 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
    ).outputText,
    {
      exports,
      document: {
        body: { appendChild() {} },
        createElement: (tag) =>
          tag === 'textarea' ? probe : { getContext: () => halfEmContext() },
      },
      require: (id) =>
        id === 'pixi.js'
          ? { CanvasTextMetrics, TextStyle }
          : id === './text-style'
            ? { textAppearance }
            : id === './transform'
              ? { localToWorld }
              : id === './frame-title-size'
                ? { frameTitleSize }
                : id === './rich-text-canvas'
                  ? richCanvas
                  : id === './rich-text'
                    ? { hasRichText }
                    : { textInkBounds: () => ({ top: 0, height: 10 }) },
    },
  );
  return {
    textLayout: exports.textLayout,
    measured: () => measured,
  };
}
const words = 'a quiet plan for the next week and the one after that. ';
const note = (i, text = words.repeat(18)) => ({
  id: 'note-' + i,
  type: 'note',
  x: i * 500,
  y: 0,
  width: 420,
  height: 460 + i,
  z: i,
  fontSize: 21,
  text,
});
const frame = {
  id: 'frame',
  type: 'frame',
  x: 0,
  y: 0,
  width: 2000,
  height: 1500,
  z: 0,
  text: 'Plan',
};

test('an animated zoom over a frame does not make notes fit their text again', () => {
  const { textLayout, measured } = fixture();
  const notes = Array.from({ length: 40 }, (_, i) => note(i));
  for (const o of notes) textLayout(o);
  // Frame titles keep a constant screen size, so every zoom level is a new layout.
  for (let step = 0; step < 900; step++) textLayout(frame, undefined, 0.2 + step * 0.002);
  const before = measured();
  for (const o of notes) textLayout(o);
  assert.equal(measured(), before, 'note layouts survive the zoom');
});

test('a long edit of one note leaves the other layouts cached', () => {
  const { textLayout, measured } = fixture();
  const notes = Array.from({ length: 40 }, (_, i) => note(i));
  for (const o of notes) textLayout(o);
  let draft = notes[0].text;
  for (let key = 0; key < 600; key++) {
    draft += 'x';
    textLayout(notes[0], draft);
  }
  const before = measured();
  for (const o of notes.slice(1)) textLayout(o);
  assert.equal(measured(), before, 'typing does not evict other objects');
});

test('typing reuses the previous fitted size and still matches a full search', () => {
  const warm = fixture();
  const o = note(0);
  warm.textLayout(o);
  const cold = warm.measured();
  assert.ok(cold > 16, 'the first layout searches for the size');
  for (const text of [o.text + 'x', o.text + 'xy', o.text.slice(0, -1)]) {
    const before = warm.measured();
    const typed = warm.textLayout(o, text);
    assert.ok(warm.measured() - before <= 3, 'an unchanged size is only verified');
    // A fresh module has no hint and runs the whole search for the same text.
    const full = fixture().textLayout(o, text);
    assert.equal(typed.appearance.fontSize, full.appearance.fontSize);
    assert.equal(typed.metrics.lines.length, full.metrics.lines.length);
  }
  // A large change no longer fits the remembered size: search again, same answer.
  const longer = o.text + words.repeat(6);
  const before = warm.measured();
  const typed = warm.textLayout(o, longer);
  assert.ok(warm.measured() - before > 16);
  assert.equal(typed.appearance.fontSize, fixture().textLayout(o, longer).appearance.fontSize);
  assert.ok(typed.appearance.fontSize < warm.textLayout(o).appearance.fontSize);
});

test('formatted notes lay out their own lines and shrink until they fit', () => {
  const { textLayout } = fixture();
  const text = words.repeat(6);
  const plain = note(0, text);
  const formatted = { ...plain, textMarks: [{ start: 0, end: 30, size: 2, bold: true }] };
  const layout = textLayout(formatted);
  assert.ok(layout.rich, 'formatted text has its own layout');
  assert.equal(layout.metrics.lines.join(''), text, 'every character is on a line');
  const box = formatted.height - layout.appearance.padding * 2;
  assert.ok(layout.metrics.height <= box - 1, 'the lines fit the note');
  assert.equal(layout.editorContentHeight, layout.metrics.height);
  // The doubled run makes its lines taller, so the text needs a smaller base size.
  assert.ok(layout.rich.lines[0].height > layout.rich.lines.at(-1).height);
  assert.ok(layout.appearance.fontSize <= textLayout(plain).appearance.fontSize);
  // New formatting is a new layout; the same formatting is the cached one.
  assert.equal(textLayout({ ...formatted }), layout);
  assert.notEqual(
    textLayout({ ...formatted, textMarks: [{ start: 0, end: 30, italic: true }] }),
    layout,
  );
  // Frames and other titles stay plain even if marks arrive from outside.
  assert.equal(textLayout({ ...frame, textMarks: formatted.textMarks }).rich, undefined);
});
