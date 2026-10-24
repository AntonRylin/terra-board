import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { textAppearance } from '../src/canvas/text-style.ts';
import { localToWorld } from '../src/canvas/transform.ts';
import { frameTitleSize } from '../src/canvas/frame-title-size.ts';
import * as richCanvas from '../src/canvas/rich-text-canvas.ts';
import * as richText from '../src/canvas/rich-text.ts';

// Every character is half an em wide. Wrapping works like Pixi's: whole words
// fill a line, and a word wider than the line breaks between its letters.
const width = (text, size) => [...text].length * size * 0.5;
function wrap(text, size, limit) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const joined = line ? line + ' ' + word : word;
      if (width(joined, size) <= limit) {
        line = joined;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      for (const ch of word) {
        if (line && width(line + ch, size) > limit) {
          lines.push(line);
          line = '';
        }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

function load() {
  const CanvasTextMetrics = {
    measureText(text, style) {
      const lines = style.wordWrap
        ? wrap(text, style.fontSize, style.wordWrapWidth)
        : text.split('\n');
      const widest = Math.max(...lines.map((l) => width(l, style.fontSize)));
      return {
        lines,
        height: lines.length * style.lineHeight,
        width: widest,
        maxLineWidth: widest,
      };
    },
  };
  class TextStyle {
    constructor(options) {
      Object.assign(this, options);
    }
  }
  const probe = {
    style: {},
    value: '',
    setAttribute() {},
    get scrollHeight() {
      const size = parseFloat(/ ([\d.e-]+)px /.exec(this.style.font)[1]);
      return (
        wrap(this.value, size, parseFloat(this.style.width)).length *
        parseFloat(this.style.lineHeight)
      );
    },
  };
  const context = {
    font: '10px sans-serif',
    measureText(text) {
      const size = parseFloat(/([\d.e-]+)px/.exec(this.font)[1]);
      return { width: width(text, size) };
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
        createElement: (tag) => (tag === 'textarea' ? probe : { getContext: () => context }),
      },
      require: (id) =>
        ({
          'pixi.js': { CanvasTextMetrics, TextStyle },
          './text-style': { textAppearance },
          './transform': { localToWorld },
          './frame-title-size': { frameTitleSize },
          './rich-text-canvas': richCanvas,
          './rich-text': richText,
        })[id] || { textInkBounds: () => ({ top: 0, height: 10 }) },
    },
  );
  return exports;
}

const { textLayout, widenNoteForWords, noteWordFloor } = load();
let count = 0;
const note = (text, extra = {}) => ({
  id: 'note-' + count++,
  type: 'note',
  x: 100,
  y: 50,
  width: 240,
  height: 200,
  z: 1,
  text,
  ...extra,
});
const ceiling = 60; // 0.3 of the shorter side of a 240 by 200 note
const floor = 21;

test('a word that fits on one line at a smaller size is not split', () => {
  const layout = textLayout(note('Здравствуйте'));
  assert.equal(layout.split, false);
  assert.deepEqual(layout.metrics.lines, ['Здравствуйте']);
  assert.ok(layout.appearance.fontSize > floor && layout.appearance.fontSize < ceiling);
});

test('ordinary sentences keep the size they had', () => {
  const layout = textLayout(note('Привет, как дела?'));
  assert.equal(layout.split, false);
  assert.ok(layout.appearance.fontSize > 30);
});

test('a word too long even at the floor breaks at the floor size or below', () => {
  const o = note('x'.repeat(40));
  assert.ok(Math.abs(noteWordFloor(o, ceiling) - floor) < 1e-9);
  const layout = textLayout(o);
  assert.equal(layout.split, true);
  assert.ok(layout.appearance.fontSize <= floor + 1e-9);
});

test('text without spaces, like Chinese, wraps freely as before', () => {
  const layout = textLayout(note('今天下午三点开会今天下午三点开会今天下午三点开会'));
  assert.equal(layout.split, false);
  assert.ok(layout.appearance.fontSize > floor);
});

test('the test word widens the note just enough to stay whole', () => {
  const o = note('wfhwfiowefiowqefhiowehfwiqoeh');
  assert.equal(textLayout(o).split, true);
  const wider = widenNoteForWords(o);
  assert.ok(wider.width > o.width);
  assert.equal(textLayout(wider).split, false);
  assert.equal(textLayout({ ...wider, width: wider.width - 1 }).split, true);
  assert.equal(wider.x, o.x);
  assert.equal(wider.height, o.height);
});

test('words that already fit, or never could, leave the width alone', () => {
  for (const text of ['Здравствуйте', 'x'.repeat(40), '']) {
    const o = note(text);
    assert.equal(widenNoteForWords(o), o);
  }
});

test('a rotated note grows from the same corner', () => {
  const o = note('wfhwfiowefiowqefhiowehfwiqoeh', { rotation: 0.4 });
  const wider = widenNoteForWords(o);
  const a = localToWorld(o, { x: 0, y: 0 }),
    b = localToWorld(wider, { x: 0, y: 0 });
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6);
});
