import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { cropImage, uncroppedImage, fullCrop, adjustCrop } from '../src/canvas/crop.ts';
import { imageTiles } from '../src/canvas/image-detail.ts';
import { clipboardObjects } from '../src/canvas/content.ts';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const image = {
  id: 'photo',
  type: 'image',
  assetId: 'a'.repeat(64),
  x: 100,
  y: 200,
  width: 800,
  height: 400,
  z: 1,
};
test('reopening a tiny crop at a smaller zoom keeps every dragged edge inside its source', () => {
  for (const crop of [
    { x: 0, y: 0, width: 0.012, height: 0.012 },
    { x: 0.988, y: 0.988, width: 0.012, height: 0.012 },
  ]) {
    for (const edge of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'move']) {
      for (const delta of [-1, -0.01, 0, 0.01, 1]) {
        const next = adjustCrop(crop, edge, delta, delta, 0.024, 0.024);
        assert.ok(
          next.x >= 0 &&
            next.y >= 0 &&
            next.width > 0 &&
            next.height > 0 &&
            next.x + next.width <= 1 + 1e-9 &&
            next.y + next.height <= 1 + 1e-9,
          JSON.stringify({ crop, edge, delta, next }),
        );
      }
    }
  }
});

test('cropping keeps the retained pixels in place and reset restores the complete image', () => {
  const crop = { x: 0.25, y: 0.125, width: 0.5, height: 0.75 };
  const result = cropImage(image, crop);
  assert.deepEqual(
    { x: result.x, y: result.y, width: result.width, height: result.height },
    { x: 300, y: 250, width: 400, height: 300 },
  );
  assert.equal(result.assetId, image.assetId);
  assert.deepEqual(result.crop, crop);
  assert.deepEqual(uncroppedImage(result), image);
  assert.deepEqual(cropImage(result, fullCrop), image);
  assert.deepEqual(
    cropImage(result, { x: 0.5, y: 0.25, width: 0.25, height: 0.5 }),
    cropImage(image, { x: 0.5, y: 0.25, width: 0.25, height: 0.5 }),
  );
});

test('cropped detail requests the original source region and clips edge tiles', () => {
  const original = { ...image, width: 4000, height: 2000, x: 0, y: 0 };
  const crop = { x: 0.33, y: 0.2, width: 0.21, height: 0.55 };
  const result = cropImage(original, crop);
  const camera = { x: -result.x * 4 + 30, y: -result.y * 4 + 30, zoom: 4 };
  const tiles = imageTiles(result, camera, 1200, 800, 2);
  assert.ok(tiles.length > 0 && tiles.length < 50);
  assert.ok(
    tiles.every(
      (t) =>
        t.x >= 0 &&
        t.y >= 0 &&
        t.x + t.width <= result.width + 1e-6 &&
        t.y + t.height <= result.height + 1e-6,
    ),
  );
  assert.ok(tiles.some((t) => t.frame.width < 1 || t.frame.height < 1));
  const full = imageTiles(original, camera, 1200, 800, 2);
  assert.ok(
    tiles.every((t) => full.some((f) => f.key === t.key)),
    'crop reused the wrong original source tiles',
  );
  assert.deepEqual(imageTiles(result, { x: 1e6, y: 1e6, zoom: 4 }, 1200, 800, 2), []);
});

test('crop survives clipboard and durable export/reopen while preserving the original bytes', async () => {
  mkdirSync(fileURLToPath(new URL('../.local-test/', import.meta.url)), { recursive: true });
  const root = mkdtempSync(fileURLToPath(new URL('../.local-test/crop-', import.meta.url)));
  let store = new Store(root);
  try {
    const bytes = await sharp({
      create: { width: 256, height: 128, channels: 3, background: '#3792dd' },
    })
      .png()
      .toBuffer();
    const asset = await store.importAsset({ bytes, name: 'original.png' });
    const board = store.createBoard({ name: 'Crop test' });
    const result = cropImage(
      { ...image, assetId: asset.id },
      { x: 0.2, y: 0.1, width: 0.6, height: 0.8 },
    );
    assert.deepEqual(clipboardObjects([result])[0].crop, result.crop);
    store.patchBoard({ id: board.id, revision: 0, upserts: [result], deleted: [] });
    store.close();
    store = new Store(root);
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0], result);
    const imported = await store.importBoard({ bytes: await store.exportBoard({ id: board.id }) });
    assert.deepEqual(store.loadBoard({ id: imported.id }).objects[0].crop, result.crop);
    assert.deepEqual(readFileSync(store.asset({ id: asset.id, variant: 'original' }).file), bytes);
    for (const crop of [
      { x: -0.1, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0.5, y: 0, width: 0.6, height: 1 },
      { x: 0, y: 0, width: NaN, height: 1 },
    ]) {
      assert.throws(() => clipboardObjects([{ ...result, crop }]), /crop/i);
      assert.throws(
        () =>
          store.patchBoard({
            id: board.id,
            revision: 1,
            upserts: [{ ...result, crop }],
            deleted: [],
          }),
        /crop/i,
      );
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
