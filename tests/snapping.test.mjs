import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapTargets, snapMove } from '../src/canvas/snapping.ts';

const box = { x: 0, y: 0, width: 100, height: 80 };
const targets = snapTargets([{ x: 300, y: 200, width: 100, height: 80 }]);
test('moving edges and centers align independently and produce spanning guides', () => {
  const s = snapMove(box, { x: 198, y: 203 }, targets, 1);
  assert.equal(s.delta.x, 200);
  assert.equal(s.delta.y, 200);
  assert.ok(s.guides.some((g) => g.axis === 'x' && g.at === 300));
  assert.ok(s.guides.some((g) => g.axis === 'y' && g.at === 200 && g.from <= 200 && g.to >= 400));
  const centered = snapMove({ ...box, width: 60 }, { x: 322, y: 99 }, targets, 1);
  assert.equal(centered.delta.x, 320);
  assert.equal(centered.delta.y, 99);
});
test('snapping uses screen pixels, releases when pulled away, and supports bypass', () => {
  for (const zoom of [0.1, 1, 4]) {
    const first = snapMove(box, { x: 200 - 4 / zoom, y: 200 }, targets, zoom);
    assert.equal(first.delta.x, 200);
    const held = snapMove(box, { x: 200 - 8 / zoom, y: 200 }, targets, zoom, first.state);
    assert.equal(held.delta.x, 200);
    const free = snapMove(box, { x: 200 - 12 / zoom, y: 200 }, targets, zoom, first.state, true);
    assert.equal(free.delta.x, 200 - 12 / zoom);
    assert.equal(free.guides.length, 0);
  }
  const held = snapMove(box, { x: 198, y: 200 }, targets, 1);
  assert.equal(snapMove(box, { x: 185, y: 200 }, targets, 1, held.state).delta.x, 185);
});
test('empty targets leave motion free; coincident targets share bounded guide entries', () => {
  assert.deepEqual(snapMove(box, { x: 7, y: -9 }, snapTargets([]), 1).delta, { x: 7, y: -9 });
  const many = snapTargets(Array.from({ length: 10000 }, (_, i) => ({ ...box, x: 300, y: i })));
  assert.equal(many.x.length, 3);
  assert.ok(snapMove(box, { x: 198, y: 23 }, many, 1).guides.length <= 6);
});
