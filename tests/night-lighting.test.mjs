import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { nightScene } from '../src/canvas/night-scene.ts';

test('camera frames reuse the lighting surface and clear old light without accumulating transforms', () => {
  const operations = [];
  const context = Object.fromEntries(
    [
      'scale',
      'setTransform',
      'clearRect',
      'fillRect',
      'save',
      'restore',
      'translate',
      'rotate',
      'beginPath',
      'ellipse',
      'roundRect',
      'fill',
      'drawImage',
    ].map((name) => [name, (...args) => operations.push([name, ...args])]),
  );
  context.createRadialGradient = () => ({ addColorStop() {} });
  let allocations = 0;
  // The visible light layer, then the offscreen layer its shadows are drawn on.
  const canvases = [];
  const createCanvas = () => {
    let width = 300,
      height = 150;
    const canvas = {
      setAttribute() {},
      getContext: () => context,
      get width() {
        return width;
      },
      set width(value) {
        width = value;
        allocations++;
      },
      get height() {
        return height;
      },
      set height(value) {
        height = value;
        allocations++;
      },
    };
    canvases.push(canvas);
    return canvas;
  };
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../src/canvas/night-lighting.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      },
    ).outputText,
    { exports, document: { createElement: createCanvas }, require: () => ({ nightScene }) },
  );
  const lighting = new exports.NightLighting({ prepend() {} });
  const canvas = canvases[0];
  const objects = [
    { id: 'light', type: 'note', x: 100, y: 100, width: 200, height: 200, color: '#ffcc66' },
  ];
  lighting.draw(objects, { x: 0, y: 0, zoom: 1 }, 1000, 700, true);
  const firstAllocations = allocations;
  for (const zoom of [1.1, 1.2, 0.9, 1.01])
    lighting.draw(objects, { x: 10, y: 20, zoom }, 1000, 700, true);
  assert.equal(allocations, firstAllocations, 'zoom must not reset the canvas backing surface');
  operations.length = 0;
  lighting.draw(
    [0, 1, 2].map((i) => ({ ...objects[0], id: 'light-' + i, x: 100 + i * 260 })),
    { x: 0, y: 0, zoom: 1 },
    1000,
    700,
    true,
  );
  assert.equal(operations.filter(([name]) => name === 'fill').length, 3, 'every shadow is drawn');
  assert.equal(
    operations.filter(([name]) => name === 'drawImage').length,
    1,
    'all shadows share a single blur pass',
  );
  operations.length = 0;
  lighting.draw([], { x: 0, y: 0, zoom: 1 }, 1000, 700, true);
  assert.deepEqual(operations[0], ['setTransform', 1, 0, 0, 1, 0, 0]);
  assert.deepEqual(operations[1], ['clearRect', 0, 0, 600, 420], 'old glow is fully cleared');
  lighting.draw([], { x: 0, y: 0, zoom: 1 }, 1200, 800, true);
  assert.equal(canvas.width, 720);
  assert.equal(canvas.height, 480);
  lighting.draw(objects, { x: 0, y: 0, zoom: 1 }, 1200, 800, false);
  assert.equal(canvas.hidden, true);
  lighting.draw(objects, { x: 0, y: 0, zoom: 1 }, 1200, 800, true);
  assert.equal(canvas.hidden, false);
});
