import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { textPlacement } from '../src/canvas/text-alignment.ts';

test('centered text outside the viewport allocates no texture; visible labels allocate only their ink bounds', () => {
  const strokes = [],
    fonts = [];
  const allocated = [],
    exports = {};
  class CanvasSource {
    constructor({ resource }) {
      this.resource = resource;
    }
  }
  class Texture {
    constructor({ source }) {
      this.source = source;
    }
  }
  class Sprite {
    position = { set() {} };
    once() {}
  }
  const code = ts.transpileModule(
    readFileSync(new URL('../src/canvas/text-rendering.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  vm.runInNewContext(code, {
    exports,
    require: (name) =>
      name === 'pixi.js'
        ? { CanvasSource, Texture, Sprite }
        : name === './text-alignment'
          ? { textPlacement }
          : {
              textLayout: () => ({
                appearance: {
                  padding: 22,
                  wrapWidth: 3956,
                  fontSize: 20,
                  lineHeight: 29,
                  fontFamily: 'sans-serif',
                  fontWeight: '700',
                  color: '#000000',
                },
                metrics: { maxLineWidth: 30, lines: ['Hi'] },
              }),
            },
    document: {
      createElement() {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({
            scale() {},
            translate() {},
            set font(value) {
              fonts.push(value);
            },
            fillText() {},
            fillRect(...args) {
              strokes.push(args);
            },
            measureText: () => ({
              width: 30,
              fontBoundingBoxAscent: 16,
              fontBoundingBoxDescent: 4,
            }),
          }),
        };
        allocated.push(canvas);
        return canvas;
      },
    },
  });
  const object = { type: 'rect', width: 4000, height: 4000, centerX: true, centerY: true };
  assert.equal(exports.renderText(object, 'Hi', 1, { x: 0, y: 0, width: 1000, height: 700 }), null);
  assert.equal(allocated.length, 0);
  assert.ok(exports.renderText(object, 'Hi', 1, { x: 1800, y: 1800, width: 1000, height: 700 }));
  assert.equal(allocated.length, 1);
  assert.equal(strokes.length, 0);
  exports.renderText({ ...object, strikethrough: true }, 'Hi', 1, {
    x: 1800,
    y: 1800,
    width: 1000,
    height: 700,
  });
  assert.deepEqual(strokes[0], [1985, 1999.375, 30, 1.25]);
  assert.equal(fonts[0], '700 20px sans-serif');
  assert.ok(
    allocated[0].width < 50 && allocated[0].height < 50,
    'blank area allocated around centered ink',
  );
});
