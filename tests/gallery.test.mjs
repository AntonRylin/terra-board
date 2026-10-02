import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  galleryEdit,
  layoutGallery,
  selectionWithGalleryImages,
  insertGalleryImages,
} from '../src/canvas/gallery.ts';
const gallery = {
  id: 'gallery',
  type: 'frame',
  text: 'Gallery',
  x: 100,
  y: 100,
  width: 432,
  height: 180,
  z: 0,
  gallery: { direction: 'below', size: 400, gap: 12 },
};
const a = {
  id: 'a',
  type: 'image',
  assetId: 'a'.repeat(64),
  x: 0,
  y: 0,
  width: 800,
  height: 400,
  z: 1,
  galleryId: 'gallery',
  galleryIndex: 0,
};
const b = { ...a, id: 'b', width: 300, height: 600, galleryIndex: 1 };
test('gallery column and row share one image dimension without distortion', () => {
  const [g, first, second] = layoutGallery(gallery, [a, b]);
  assert.equal(first.width, 400);
  assert.equal(first.height, 200);
  assert.equal(second.width, 400);
  assert.equal(second.height, 800);
  assert.equal(second.y, first.y + first.height + 12);
  assert.equal(second.x, first.x);
  assert.equal(g.height, 1044);
  const [row, r1, r2] = layoutGallery(
    { ...gallery, gallery: { ...gallery.gallery, direction: 'right' } },
    [a, b],
  );
  assert.equal(r1.height, 400);
  assert.equal(r2.height, 400);
  assert.equal(r2.x, r1.x + r1.width + 12);
  assert.equal(r1.y, r2.y);
  assert.equal(row.width, 1044);
});
test('append, delete, direction change and dissolve expand a single layout transaction', () => {
  const initial = layoutGallery(gallery, [a]);
  const current = new Map(initial.map((o) => [o.id, o]));
  const added = galleryEdit(current, { upserts: [b], deleted: [] });
  assert.ok(added.upserts.some((o) => o.id === 'gallery'));
  assert.equal(added.upserts.find((o) => o.id === 'b').y, 328);
  for (const o of added.upserts) current.set(o.id, o);
  const deleted = galleryEdit(current, { upserts: [], deleted: ['a'] });
  assert.equal(deleted.upserts.find((o) => o.id === 'b').y, 116);
  const dissolved = galleryEdit(current, { upserts: [], deleted: ['gallery'] });
  assert.ok(dissolved.upserts.every((o) => !o.galleryId));
});
test('gallery resize, move and dragging an image outside keep consistent membership', () => {
  const initial = layoutGallery(gallery, [a, b]);
  const current = new Map(initial.map((o) => [o.id, o]));
  const resized = galleryEdit(current, { upserts: [{ ...initial[0], width: 232 }], deleted: [] });
  assert.equal(resized.upserts.find((o) => o.id === 'a').width, 200);
  const moved = galleryEdit(current, { upserts: [{ ...initial[0], x: 500 }], deleted: [] });
  assert.equal(moved.upserts.find((o) => o.id === 'a').x, 516);
  const released = galleryEdit(current, { upserts: [{ ...initial[1], x: 2000 }], deleted: [] });
  assert.equal(released.upserts.find((o) => o.id === 'a').galleryId, undefined);
  assert.equal(released.upserts.find((o) => o.id === 'b').y, 116);
  assert.equal(selectionWithGalleryImages([initial[0], initial[1]], initial).length, 3);
  const inside = galleryEdit(current, {
    upserts: [{ ...initial[1], x: initial[1].x + 10 }],
    deleted: [],
  });
  assert.equal(
    inside.upserts.find((o) => o.id === 'a').x,
    initial[1].x,
    'inside moves snap back to the layout',
  );
  const longAxis = galleryEdit(current, {
    upserts: [{ ...initial[0], height: initial[0].height + 50 }],
    deleted: [],
  });
  assert.equal(
    longAxis.upserts.find((o) => o.id === 'gallery').height,
    initial[0].height,
    'long axis remains content sized',
  );
});

test('gallery metadata survives clipboard, storage, duplication and portable export', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { Store } = require('../electron/store.cjs');
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { clipboardObjects } = await import('../src/canvas/content.ts');
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/gallery-store-'));
  let store = new Store(root);
  try {
    const bytes = await require('sharp')({
      create: { width: 12, height: 8, channels: 3, background: '#647c95' },
    })
      .png()
      .toBuffer();
    const asset = await store.importAsset({ bytes, name: 'image.png' });
    const objects = layoutGallery({ ...gallery, text: 'Vehicle references' }, [
      { ...a, assetId: asset.id, galleryRow: 0, galleryColumn: 0 },
      {
        ...a,
        id: 'variation',
        assetId: asset.id,
        galleryIndex: 1,
        galleryRow: 0,
        galleryColumn: 1,
      },
    ]);
    assert.deepEqual(clipboardObjects(objects), objects);
    const board = store.createBoard({ name: 'Gallery' });
    store.patchBoard({ id: board.id, revision: 0, upserts: objects, deleted: [] });
    const copy = store.duplicateBoard({ id: board.id });
    assert.deepEqual(
      store.loadBoard({ id: copy.id }).objects.sort((a, b) => a.id.localeCompare(b.id)),
      [...objects].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const packed = await store.exportBoard({ id: board.id });
    const imported = await store.importBoard({ bytes: packed });
    assert.deepEqual(
      store.loadBoard({ id: imported.id }).objects.sort((a, b) => a.id.localeCompare(b.id)),
      [...objects].sort((a, b) => a.id.localeCompare(b.id)),
    );
    store.close();
    store = new Store(root);
    assert.deepEqual(
      store.loadBoard({ id: board.id }).objects.sort((a, b) => a.id.localeCompare(b.id)),
      [...objects].sort((a, b) => a.id.localeCompare(b.id)),
    );
    for (const bad of [
      { ...gallery, gallery: { ...gallery.gallery, direction: 'up' } },
      { ...a, galleryIndex: -1 },
    ]) {
      assert.throws(() => clipboardObjects([bad]), /gallery/);
      assert.throws(
        () => store.patchBoard({ id: board.id, revision: 1, upserts: [bad], deleted: [] }),
        /gallery/,
      );
    }
  } finally {
    store.close();
  }
});

test('gallery matrix inserts variations and steps without collisions, then transposes', () => {
  const current = new Map(layoutGallery(gallery, [a, b]).map((o) => [o.id, o]));
  const apply = (edit) => {
    const result = galleryEdit(current, edit);
    for (const o of result.upserts) current.set(o.id, o);
    for (const id of result.deleted) current.delete(id);
  };
  const insert = (id, anchorId, direction) =>
    apply(
      insertGalleryImages(current, [{ ...a, id, galleryId: undefined, galleryIndex: undefined }], {
        galleryId: gallery.id,
        anchorId,
        direction,
      }),
    );
  insert('variation', 'a', 'right');
  assert.equal(current.get('variation').galleryRow, 0);
  assert.equal(current.get('variation').galleryColumn, 1);
  assert.equal(current.get('b').galleryRow, 1);
  assert.equal(current.get('b').galleryColumn, 0);
  insert('closer', 'a', 'right');
  assert.equal(current.get('closer').galleryColumn, 1);
  assert.equal(current.get('variation').galleryColumn, 2);
  insert('step', 'a', 'below');
  assert.equal(current.get('step').galleryRow, 1);
  assert.equal(current.get('b').galleryRow, 2);
  assert.equal(current.get('variation').galleryRow, 0);
  const before = [...current.values()].filter((o) => o.type === 'image');
  assert.equal(
    new Set(before.map((o) => o.galleryRow + ',' + o.galleryColumn)).size,
    before.length,
  );
  for (const first of before)
    for (const second of before) {
      if (first.id === second.id) continue;
      assert.ok(
        first.x + first.width <= second.x ||
          second.x + second.width <= first.x ||
          first.y + first.height <= second.y ||
          second.y + second.height <= first.y,
        'no overlaps',
      );
    }
  const parent = current.get(gallery.id);
  apply({
    upserts: [{ ...parent, gallery: { ...parent.gallery, direction: 'right' } }],
    deleted: [],
  });
  for (const o of before) {
    assert.equal(current.get(o.id).galleryRow, o.galleryColumn);
    assert.equal(current.get(o.id).galleryColumn, o.galleryRow);
  }
  insert('under-variation', 'variation', 'below');
  assert.equal(
    current.get('under-variation').galleryColumn,
    current.get('variation').galleryColumn,
  );
  assert.equal(current.get('under-variation').galleryRow, current.get('variation').galleryRow + 1);
});
