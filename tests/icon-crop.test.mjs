import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iconCrop } from '../src/canvas/icon-crop.ts';
test('square icon crops cover landscape and portrait images and clamp drag edges', () => {
  assert.deepEqual(iconCrop(800, 400, 1, 0.5, 0.5), { x: 200, y: 0, size: 400 });
  assert.deepEqual(iconCrop(400, 800, 1, 0.5, 0.5), { x: 0, y: 200, size: 400 });
  assert.deepEqual(iconCrop(800, 400, 2, 0, 1), { x: 0, y: 200, size: 200 });
  assert.deepEqual(iconCrop(800, 400, 4, 1, 0), { x: 700, y: 0, size: 100 });
});
