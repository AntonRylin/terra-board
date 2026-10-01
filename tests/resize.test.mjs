import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeObject } from '../src/canvas/resize.ts';
import { selectionToolsPosition } from '../src/canvas/selection-tools.ts';

test('text scaling respects font limits, even when dragged past the opposite corner', () => {
  const o = { type: 'text', x: 100, y: 100, width: 300, height: 60, fontSize: 24 };
  const large = resizeObject(o, 'nw', -100000, -100000, false);
  assert.equal(large.fontSize, 300);
  assert.equal(large.width, 3750);
  assert.equal(large.x + large.width, 400);
  const small = resizeObject(o, 'se', -100000, -100000, false);
  assert.equal(small.fontSize, 8);
  assert.equal(small.width, 100);
  assert.equal(small.height, 20);
  const vertical = resizeObject(o, 'se', 0, 100, false);
  assert.ok(vertical.fontSize > 24, 'vertical dragging must also scale text');
  const fractional = resizeObject({ ...o, width: 360, height: 72 }, 'se', 14, 0, false);
  const minimum = resizeObject(fractional, 'se', -100000, -100000, false);
  assert.equal(minimum.fontSize, 8, 'rounding must not produce an invalid font size');
  const tiny = resizeObject(
    { ...o, width: 100, height: 20, fontSize: 300 },
    'se',
    -100000,
    -100000,
    false,
  );
  assert.ok(tiny.width >= 1 && tiny.height >= 1, 'geometry must stay valid');
});

test('images preserve aspect ratio from every corner and allow Shift free resize', () => {
  const o = { type: 'image', x: 100, y: 100, width: 300, height: 150 };
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const dx = corner.includes('w') ? -60 : 60,
      dy = corner.includes('n') ? -60 : 60;
    const scaled = resizeObject(o, corner, dx, dy, false);
    assert.equal(scaled.width / scaled.height, 2);
    const free = resizeObject(o, corner, dx, dy, true);
    assert.equal(free.width, 360);
    assert.equal(free.height, 210);
  }
});

test('selection controls stay close above or below, and remain inside the viewport', () => {
  const viewport = { width: 1200, height: 800 },
    tools = { width: 300, height: 44 };
  const bounds = { x: 400, y: 600, width: 400, height: 100 };
  assert.deepEqual(selectionToolsPosition(bounds, viewport, tools), { left: 450, top: 542 });
  assert.deepEqual(selectionToolsPosition({ ...bounds, y: 10 }, viewport, tools), {
    left: 450,
    top: 124,
  });
  for (const x of [-1000, 0, 1100, 2000])
    for (const y of [-1000, 0, 750, 2000]) {
      const p = selectionToolsPosition({ ...bounds, x, y }, viewport, tools);
      assert.ok(p.left >= 10 && p.left + tools.width <= 1190);
      assert.ok(p.top >= 10 && p.top + tools.height <= 790);
    }
});
