import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  localToWorld,
  worldToLocal,
  rotatePoint,
  objectBounds,
  localViewport,
  rotationFromDrag,
} from '../src/canvas/transform.ts';
import { resizeObject, handlePoint } from '../src/canvas/resize.ts';
import { SpatialIndex } from '../src/canvas/geometry.ts';
import { cropImage, uncroppedImage } from '../src/canvas/crop.ts';
import { clipboardObjects } from '../src/canvas/content.ts';
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const samePoint = (a, b) => {
  close(a.x, b.x);
  close(a.y, b.y);
};
const text = {
  id: 'text',
  type: 'text',
  x: 100,
  y: 200,
  width: 300,
  height: 120,
  fontSize: 24,
  text: 'Resize',
  z: 1,
};
test('rotated local/world coordinates, bounds and spatial lookup agree', () => {
  for (const rotation of [0, 37, 90, 180, 270]) {
    const o = { ...text, rotation };
    for (const p of [
      { x: 0, y: 0 },
      { x: 300, y: 120 },
      { x: 150, y: 60 },
    ])
      samePoint(worldToLocal(o, localToWorld(o, p)), p);
    const b = objectBounds(o),
      index = new SpatialIndex();
    index.reset([o]);
    const point = localToWorld(o, { x: 1, y: 1 });
    assert.equal(index.search({ ...point, width: 0, height: 0 })[0].id, 'text');
    assert.ok(b.width >= 120 && b.height >= 120 - 1e-7);
  }
  const b = objectBounds({ ...text, rotation: 90 });
  close(b.width, 120);
  close(b.height, 300);
});
test('all edge handles preserve font, extend one axis and anchor the opposite rotated edge', () => {
  for (const rotation of [0, 37, 90, 180])
    for (const edge of ['n', 'e', 's', 'w']) {
      const o = { ...text, rotation };
      const delta = rotatePoint(
        {
          x: edge === 'e' ? 40 : edge === 'w' ? -40 : 0,
          y: edge === 's' ? 40 : edge === 'n' ? -40 : 0,
        },
        rotation,
      );
      const result = resizeObject(o, edge, delta.x, delta.y, false);
      assert.equal(result.fontSize, 24);
      assert.equal(result.textBox, true);
      close(result.width, o.width + (/[ew]/.test(edge) ? 40 : 0));
      close(result.height, o.height + (/[ns]/.test(edge) ? 40 : 0));
      const opposite = { n: 's', s: 'n', w: 'e', e: 'w' }[edge];
      samePoint(
        localToWorld(o, handlePoint(o, opposite)),
        localToWorld(result, handlePoint(result, opposite)),
      );
    }
});
test('rotated corners still scale text and pin the opposite corner', () => {
  const o = { ...text, rotation: 42 };
  const delta = rotatePoint({ x: 150, y: 60 }, 42),
    resized = resizeObject(o, 'se', delta.x, delta.y, false);
  close(resized.fontSize, 36);
  samePoint(localToWorld(o, { x: 0, y: 0 }), localToWorld(resized, { x: 0, y: 0 }));
});
test('rotation remains centered and supports 15 degree snapping', () => {
  const o = { ...text, rotation: 0 },
    center = { x: 250, y: 260 };
  close(rotationFromDrag(o, { x: 250, y: 360 }, { x: 150, y: 260 }, false), 90);
  const target = rotatePoint({ x: 0, y: 100 }, 32);
  close(
    rotationFromDrag(
      o,
      { x: 250, y: 360 },
      { x: center.x + target.x, y: center.y + target.y },
      true,
    ),
    30,
  );
});
test('rotated viewport and crop geometry preserve visible source pixels', () => {
  const image = { ...text, type: 'image', rotation: 90, width: 4000, height: 2000, x: 0, y: 0 };
  const v = localViewport(image, { x: -1000, y: 0, zoom: 1 }, 500, 500, 0);
  close(v.left, 1000);
  close(v.top, 1500);
  close(v.right, 1500);
  close(v.bottom, 2000);
  const crop = { x: 0.2, y: 0.1, width: 0.6, height: 0.7 },
    result = cropImage(image, crop),
    restored = uncroppedImage(result);
  samePoint(restored, image);
  close(restored.width, image.width);
  close(restored.height, image.height);
  samePoint(
    localToWorld(result, { x: 0, y: 0 }),
    localToWorld(image, { x: crop.x * image.width, y: crop.y * image.height }),
  );
});
test('rotation and manual text boxes survive save, clipboard and export/reopen', async () => {
  const { Store } = createRequire(import.meta.url)('../electron/store.cjs');
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/transform-'));
  let store = new Store(root);
  try {
    const board = store.createBoard({ name: 'Transforms' }),
      o = { ...text, rotation: 37.5, textBox: true };
    assert.deepEqual(clipboardObjects([o])[0], o);
    store.patchBoard({ id: board.id, revision: 0, upserts: [o], deleted: [] });
    store.close();
    store = new Store(root);
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0], o);
    const imported = await store.importBoard({ bytes: await store.exportBoard({ id: board.id }) });
    assert.deepEqual(store.loadBoard({ id: imported.id }).objects[0], o);
    for (const rotation of [-1, 361, NaN, '90']) {
      assert.throws(() => clipboardObjects([{ ...o, rotation }]), /rotation/i);
      assert.throws(
        () =>
          store.patchBoard({
            id: board.id,
            revision: 1,
            upserts: [{ ...o, rotation }],
            deleted: [],
          }),
        /rotation/i,
      );
    }
  } finally {
    store.close();
  }
});
