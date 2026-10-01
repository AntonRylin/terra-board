import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoomAt, screenToWorld, boundsOf, SpatialIndex } from '../src/canvas/geometry.ts';
import { History } from '../src/canvas/history.ts';
const obj = (id, x, y) => ({ id, type: 'rect', x, y, width: 100, height: 80, z: 0 });
test('zoom keeps the point under the cursor stationary at negative coordinates', () => {
  const c = { x: 180, y: -90, zoom: 0.75 },
    p = { x: 324, y: 145 };
  const before = screenToWorld(p, c);
  const next = zoomAt(c, p, 2);
  assert.deepEqual(screenToWorld(p, next), before);
});
test('spatial lookup excludes offscreen objects and follows moved objects', () => {
  const index = new SpatialIndex();
  index.reset([obj('left', -300, -100), obj('right', 5000, 5000)]);
  assert.deepEqual(
    index.search({ x: -400, y: -200, width: 600, height: 600 }).map((x) => x.id),
    ['left'],
  );
  index.upsert(obj('left', 6000, 6000));
  assert.equal(index.search({ x: -400, y: -200, width: 600, height: 600 }).length, 0);
});
test('selection bounds include negative positions and object extents', () => {
  assert.deepEqual(boundsOf([obj('a', -50, -40), obj('b', 200, 100)]), {
    x: -50,
    y: -40,
    width: 350,
    height: 220,
  });
});
test('undo and redo retain inverse edits and new work clears the redo branch', () => {
  const h = new History();
  const e = { upserts: [obj('a', 0, 0)], deleted: [] },
    inverse = { upserts: [], deleted: ['a'] };
  h.push(e, inverse);
  assert.deepEqual(h.undo(), inverse);
  assert.deepEqual(h.redo(), e);
  h.undo();
  h.push({ upserts: [obj('b', 0, 0)], deleted: [] }, { upserts: [], deleted: ['b'] });
  assert.equal(h.redo(), null);
});
