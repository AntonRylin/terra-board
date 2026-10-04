import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapTargets, snapMove, snapResize } from '../src/canvas/snapping.ts';
import { resizeObject, resizeSelection } from '../src/canvas/resize.ts';
import { objectBounds, localToWorld } from '../src/canvas/transform.ts';
import { boundsOf } from '../src/canvas/geometry.ts';

const box = { x: 0, y: 0, width: 100, height: 80 };
const targets = snapTargets([{ x: 300, y: 200, width: 100, height: 80 }]);

test('resizing snaps dragged edges and corners without moving the opposite anchor', () => {
  const o = { ...box, type: 'rect' };
  for (const handle of ['e', 'se', 'w', 'nw']) {
    const west = handle.includes('w');
    const raw = { x: west ? -198 : 198, y: handle.length > 1 ? (west ? -118 : 118) : 0 };
    const resize = (d) => objectBounds(resizeObject(o, handle, d.x, d.y, true));
    const t = snapTargets([{ x: west ? -200 : 300, y: west ? -120 : 200, width: 40, height: 40 }]);
    const result = snapResize(raw, t, 1, resize);
    const b = resize(result.delta);
    assert.ok(Math.abs((west ? b.x : b.x + b.width) - (west ? -200 : 300)) < 1e-6);
    assert.equal(west ? b.x + b.width : b.x, west ? 100 : 0);
    assert.ok(result.guides.some((g) => g.axis === 'x'));
    if (handle.length > 1)
      assert.ok(Math.abs((west ? b.y : b.y + b.height) - (west ? -120 : 200)) < 1e-6);
    if (handle === 'e') {
      const held = snapResize({ x: 192, y: 0 }, t, 1, resize, result.state);
      assert.ok(Math.abs(resize(held.delta).width - 300) < 1e-6);
      assert.equal(snapResize({ x: 185, y: 0 }, t, 1, resize, result.state).guides.length, 0);
    }
    if (handle === 'e' || handle === 'w')
      assert.equal(
        result.guides.some((g) => g.axis === 'y'),
        false,
      );
  }
});

test('resize snapping preserves constrained image proportions and rotated anchors', () => {
  for (const rotation of [0, 30, 90]) {
    const o = { ...box, type: 'image', rotation };
    const resize = (d) => objectBounds(resizeObject(o, 'se', d.x, d.y, false));
    const raw = { x: 60, y: 40 },
      b = resize(raw),
      target = (rotation === 90 ? b.x : b.x + b.width) + 3;
    const result = snapResize(
      raw,
      snapTargets([{ x: target, y: 500, width: 50, height: 50 }]),
      1,
      resize,
    );
    const after = resizeObject(o, 'se', result.delta.x, result.delta.y, false);
    assert.ok(Math.abs(after.width / after.height - o.width / o.height) < 1e-8);
    assert.ok(result.guides.some((g) => Math.abs(g.at - target) < 1e-6));
    const beforeAnchor = localToWorld(o, { x: 0, y: 0 }),
      afterAnchor = localToWorld(after, { x: 0, y: 0 });
    assert.ok(Math.hypot(beforeAnchor.x - afterAnchor.x, beforeAnchor.y - afterAnchor.y) < 1e-6);
  }
});

test('resize snapping handles selection scale, zoom, bypass and minimum-size clamps', () => {
  const objects = [
    { ...box, type: 'rect' },
    { ...box, x: 120, type: 'rect' },
  ];
  const bounds = boundsOf(objects);
  const resize = (d) => boundsOf(resizeSelection(objects, bounds, 'se', d.x, d.y));
  for (const zoom of [0.25, 1, 4]) {
    const raw = { x: 30, y: 10 },
      b = resize(raw);
    const t = snapTargets([{ x: b.x + b.width + 4 / zoom, y: 500, width: 40, height: 40 }]);
    const result = snapResize(raw, t, zoom, resize);
    assert.ok(result.guides.length);
    assert.deepEqual(snapResize(raw, t, zoom, resize, result.state, true).delta, raw);
    assert.equal(snapResize(raw, t, zoom, resize, result.state, true).guides.length, 0);
  }
  const list = { ...box, type: 'list', width: 300, height: 200, items: [{ text: 'One' }] };
  const clamp = (d) => objectBounds(resizeObject(list, 'e', d.x, d.y, true));
  const limited = snapResize(
    { x: -100, y: 0 },
    snapTargets([{ x: 238, y: 500, width: 50, height: 50 }]),
    1,
    clamp,
  );
  assert.equal(clamp(limited.delta).width, 240);
  assert.equal(limited.guides.length, 0, 'do not show a guide for an unreachable alignment');
});
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
