import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { textAppearance } from '../src/canvas/text-style.ts';
import { textPlacement } from '../src/canvas/text-alignment.ts';
import { clipboardObjects } from '../src/canvas/content.ts';
import sharp from 'sharp';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const image = {
  id: 'image',
  type: 'image',
  x: 40,
  y: 80,
  width: 300,
  height: 200,
  z: 1,
  assetId: 'a'.repeat(64),
  text: 'original-file.png',
  imageTitle: 'Desert flight',
};

test('image titles use smaller frame styling above the image without centering', () => {
  const appearance = textAppearance(image);
  assert.ok(appearance.fontSize < textAppearance({ ...image, type: 'frame' }).fontSize);
  assert.equal(appearance.padding, 0);
  const placement = textPlacement(
    { ...image, centerX: true, centerY: true },
    { ...appearance, wrapWidth: image.width },
    2,
  );
  assert.equal(placement.left, 0);
  assert.ok(placement.top + placement.height < 0);
});

test('optional image titles survive clipboard and save/reopen independently of filenames', async () => {
  assert.deepEqual(clipboardObjects([image])[0], image);
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/image-title-'));
  let store = new Store(root);
  try {
    const asset = await store.importAsset({
      name: image.text,
      bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4488cc' } })
        .png()
        .toBuffer(),
    });
    const saved = { ...image, assetId: asset.id };
    const board = store.createBoard({ name: 'Image titles' });
    store.patchBoard({ id: board.id, revision: 0, upserts: [saved], deleted: [] });
    store.close();
    store = new Store(root);
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0], saved);
    const imported = await store.importBoard({ bytes: await store.exportBoard({ id: board.id }) });
    assert.deepEqual(store.loadBoard({ id: imported.id }).objects[0], saved);
    const cleared = { ...saved, imageTitle: '' };
    store.patchBoard({ id: board.id, revision: 1, upserts: [cleared], deleted: [] });
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0], cleared);
    for (const value of [42, null, 'a'.repeat(100001)]) {
      assert.throws(() => clipboardObjects([{ ...image, imageTitle: value }]), /title/i);
      assert.throws(
        () =>
          store.patchBoard({
            id: board.id,
            revision: 2,
            upserts: [{ ...image, imageTitle: value }],
            deleted: [],
          }),
        /title/i,
      );
    }
  } finally {
    store.close();
  }
});
