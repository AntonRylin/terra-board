import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrowFromPoints, arrowPath, arrowHandles, hitsArrow } from '../src/canvas/arrows.ts';

test('curved arrow ends follow steep terminal segments and insertion handles stay on the curve', () => {
  const o = arrowFromPoints({ id: 'a', type: 'arrow', z: 1 }, [
    { x: 0, y: 120 },
    { x: 380, y: 260 },
    { x: 610, y: 275 },
    { x: 700, y: 0 },
  ]);
  const path = arrowPath(o),
    end = path.at(-1),
    previous = path.at(-2);
  assert.ok(
    end.y - previous.y < -2 * Math.abs(end.x - previous.x),
    'head must point steeply upward',
  );
  for (const p of path) {
    assert.ok(p.x >= -1e-8 && p.x <= o.width + 1e-8);
    assert.ok(p.y >= -1e-8 && p.y <= o.height + 1e-8);
  }
  for (const handle of arrowHandles(o).filter((h) => h.insert))
    assert.ok(hitsArrow(o, handle, 0.01), 'insertion dot must lie on its curve');
});

test('arrows preserve endpoint direction and stay hittable on horizontal and vertical paths', () => {
  const base = { id: 'a', type: 'arrow', x: 0, y: 0, width: 1, height: 1, z: 1 };
  for (const points of [
    [
      { x: 400, y: 100 },
      { x: 100, y: 100 },
    ],
    [
      { x: 100, y: 400 },
      { x: 100, y: 100 },
    ],
  ]) {
    const o = arrowFromPoints(base, points),
      path = arrowPath(o);
    assert.ok(o.width >= 1 && o.height >= 1);
    assert.equal(path[0].x + o.x, points[0].x);
    assert.equal(path[0].y + o.y, points[0].y);
    assert.equal(path.at(-1).x + o.x, points[1].x);
    assert.equal(path.at(-1).y + o.y, points[1].y);
    assert.ok(hitsArrow(o, path[0], 8));
  }
});
test('curve has an insertable midpoint on each segment and ignores empty bounds', () => {
  const o = arrowFromPoints({ id: 'a', type: 'arrow', z: 1 }, [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
    { x: 200, y: 0 },
  ]);
  assert.equal(arrowHandles(o).length, 5);
  assert.ok(arrowPath(o).length > 3);
  assert.equal(hitsArrow(o, { x: 100, y: 0 }, 5), false);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { clipboardObjects } from '../src/canvas/content.ts';
const { Store, objectValue } = createRequire(import.meta.url)('../electron/store.cjs');

test('arrow geometry and styling survive storage, clipboard and portable transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-arrows-'));
  let store = new Store(join(root, 'source'));
  const target = new Store(join(root, 'target'));
  try {
    const board = store.createBoard({ name: 'Arrows' });
    const o = arrowFromPoints(
      { id: 'arrow', type: 'arrow', z: 1, color: '#123456', text: 'A label', fontSize: 18 },
      [
        { x: 10, y: 20 },
        { x: 200, y: 150 },
        { x: 400, y: 20 },
      ],
    );
    o.arrow = {
      ...o.arrow,
      line: 'elbow',
      dash: 'dashed',
      start: 'diamond',
      end: 'open',
      thickness: 6,
    };
    assert.deepEqual(clipboardObjects([o])[0], objectValue(o));
    store.patchBoard({ id: board.id, revision: 0, upserts: [o], deleted: [] });
    store.close();
    store = new Store(join(root, 'source'));
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0], objectValue(o));
    const copy = await target.importBoard({ bytes: await store.exportBoard({ id: board.id }) });
    assert.deepEqual(target.loadBoard({ id: copy.id }).objects[0].arrow, o.arrow);
    for (const patch of [
      { points: [{ x: 0, y: 0 }] },
      { thickness: NaN },
      { line: 'invalid' },
      {
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      },
    ]) {
      const bad = { ...o, arrow: { ...o.arrow, ...patch } };
      assert.throws(() => objectValue(bad), /arrow/i);
      assert.throws(() => clipboardObjects([bad]), /arrow/i);
    }
  } finally {
    store.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import { resizeSelection } from '../src/canvas/resize.ts';
test('horizontal and vertical arrows can shrink with a multi-selection', () => {
  for (const end of [
    { x: 200, y: 0 },
    { x: 0, y: 200 },
  ]) {
    const o = arrowFromPoints({ id: 'arrow', type: 'arrow', z: 1, fontSize: 18 }, [
      { x: 0, y: 0 },
      end,
    ]);
    const [small] = resizeSelection([o], { x: 0, y: 0, width: 200, height: 200 }, 'se', -100, -100);
    const p = arrowPath(small).at(-1);
    assert.equal(p.x, end.x / 2);
    assert.equal(p.y, end.y / 2);
    assert.ok(small.width >= 1 && small.height >= 1);
    assert.equal(small.arrow.thickness, 1.5);
  }
});

import { drawArrow } from '../src/canvas/arrow-rendering.ts';
test('vertical elbow arrows begin at the actual endpoint even with zero-length elbows', () => {
  const o = arrowFromPoints({ id: 'a', type: 'arrow', z: 1 }, [
    { x: 100, y: 300 },
    { x: 100, y: 100 },
  ]);
  o.arrow = { ...o.arrow, line: 'elbow', start: 'none', end: 'none' };
  const calls = [];
  const graphics = {
    moveTo(x, y) {
      calls.push(['move', x, y]);
      return this;
    },
    lineTo(x, y) {
      calls.push(['line', x, y]);
      return this;
    },
    stroke() {
      return this;
    },
  };
  drawArrow(graphics, o);
  assert.deepEqual(calls[0], ['move', 0, 200]);
  assert.deepEqual(calls.at(-1), ['line', 0, 0]);
});
