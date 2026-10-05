import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textInkBounds } from '../src/canvas/text-ink.ts';
import { textPlacement } from '../src/canvas/text-alignment.ts';

const measure = (text) => ({
  fontBoundingBoxAscent: 86,
  fontBoundingBoxDescent: 18,
  actualBoundingBoxAscent: text === 'É' ? 80 : 60,
  actualBoundingBoxDescent: text.includes('g') ? 17 : 0,
});

test('free text has equal visible top and bottom margins with descenders', () => {
  const ink = textInkBounds(['etrgerg'], 104, measure);
  const appearance = {
    padding: 11.2,
    lineHeight: 104,
    wrapWidth: 200,
    inkTop: ink.top,
    inkHeight: ink.height,
  };
  const object = { type: 'text', width: 222.4, height: ink.height + 22.4 };
  for (const centerY of [false, true]) {
    const placement = textPlacement({ ...object, centerY }, appearance, 1);
    const top = placement.top + ink.top;
    const bottom = object.height - (top + ink.height);
    assert.ok(Math.abs(top - 11.2) < 1e-8);
    assert.ok(Math.abs(top - bottom) < 1e-8);
  }
});

test('ink bounds cover accents, multiline descenders and explicit blank lines', () => {
  assert.deepEqual(textInkBounds(['É', 'g'], 104, measure), { top: 6, height: 201 });
  assert.deepEqual(textInkBounds([''], 104, measure), { top: 0, height: 104 });
  assert.deepEqual(textInkBounds(['É', ''], 104, measure), { top: 6, height: 202 });
});
