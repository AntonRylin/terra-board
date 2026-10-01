import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import sharp from 'sharp';
import { imageTiles } from '../src/canvas/image-detail.ts';
import { Worker } from 'node:worker_threads';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(fileURLToPath(new URL('../.local-test/', import.meta.url)), { recursive: true });

test('image detail requests only visible tiles, leaving distant and offscreen images cheap', () => {
  const image = { assetId: 'photo', x: 0, y: 0, width: 4000, height: 4000 };
  assert.deepEqual(imageTiles(image, { x: 0, y: 0, zoom: 0.1 }, 1920, 1080, 2), []);
  assert.deepEqual(imageTiles(image, { x: 5000, y: 5000, zoom: 8 }, 1920, 1080, 2), []);
  const tiles = imageTiles(image, { x: -10000, y: -10000, zoom: 8 }, 1920, 1080, 2);
  assert.ok(
    tiles.length > 0 && tiles.length <= 70,
    `requested ${tiles.length} tiles for one viewport`,
  );
  assert.ok(tiles.every((tile) => tile.width * 8 * 2 <= 512 && tile.height * 8 * 2 <= 512));
  assert.equal(new Set(tiles.map((tile) => tile.key)).size, tiles.length);
});

test('zoom detail comes from original pixels, is bounded and cached, and preserves originals', async () => {
  const root = mkdtempSync(fileURLToPath(new URL('../.local-test/detail-', import.meta.url)));
  const store = new Store(root);
  try {
    const pixels = Buffer.alloc(4096 * 2048 * 3);
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = (i / 3) % 2 ? 255 : 0;
      pixels[i + 1] = 100;
      pixels[i + 2] = 200;
    }
    const bytes = await sharp(pixels, { raw: { width: 4096, height: 2048, channels: 3 } })
      .png()
      .toBuffer();
    const asset = await store.importAsset({ bytes, name: 'detail.png' });
    assert.equal(
      typeof store.readAsset,
      'function',
      'asset delivery needs an on-demand detail path',
    );
    const tile = await store.readAsset({ id: asset.id, variant: 'tile-8-4-3-1' });
    const metadata = await sharp(tile.file).metadata();
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 512);
    const detail = await sharp(tile.file).removeAlpha().raw().toBuffer();
    assert.deepEqual([...detail.subarray(0, 12)], [0, 100, 200, 255, 100, 200, 0, 100, 200, 255, 100, 200]);
    assert.ok(existsSync(tile.file));
    assert.equal(
      (await store.readAsset({ id: asset.id, variant: 'tile-8-4-3-1' })).file,
      tile.file,
    );
    assert.deepEqual(readFileSync(store.asset({ id: asset.id, variant: 'original' }).file), bytes);
    await assert.rejects(
      () => store.readAsset({ id: asset.id, variant: 'tile-8-4-99-0' }),
      /tile/i,
    );
    await assert.rejects(
      () => store.readAsset({ id: asset.id, variant: 'tile-999999-1-0-0' }),
      /tile|asset/i,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a slow image decode cannot block acknowledged board edits in the storage worker', async () => {
  const root = mkdtempSync(
    fileURLToPath(new URL('../.local-test/detail-worker-', import.meta.url)),
  );
  const store = new Store(root);
  const board = store.createBoard({ name: 'Save during decoding' });
  const bytes = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: '#2468ac' },
  })
    .png()
    .toBuffer();
  const asset = await store.importAsset({ bytes, name: 'photo.png' });
  store.close();
  // Delay only the expensive I/O boundary; exercise the real worker, SQLite save,
  // original-source tile generation and acknowledgment routing beneath it.
  const worker = new Worker(
    `
    const { Store } = require(${JSON.stringify(fileURLToPath(new URL('../electron/store.cjs', import.meta.url)))});
    const read = Store.prototype.readAsset;
    Store.prototype.readAsset = async function(args) {
      await new Promise(resolve => setTimeout(resolve, 250));
      return read.call(this, args);
    };
    require(${JSON.stringify(fileURLToPath(new URL('../electron/worker.cjs', import.meta.url)))});
  `,
    { eval: true, workerData: { root } },
  );
  let id = 0;
  const call = (command, args) =>
    new Promise((resolve, reject) => {
      const request = ++id;
      const receive = (message) => {
        if (message.id !== request) return;
        worker.off('message', receive);
        message.error ? reject(Error(message.error)) : resolve(message.result);
      };
      worker.on('message', receive);
      worker.postMessage({ id: request, command, args });
    });
  try {
    const order = [];
    const tile = call('asset', { id: asset.id, variant: 'tile-2-2-0-0' }).then(() =>
      order.push('tile'),
    );
    const save = call('patchBoard', {
      id: board.id,
      revision: 0,
      upserts: [
        {
          id: 'text',
          type: 'text',
          x: 0,
          y: 0,
          width: 240,
          height: 80,
          z: 1,
          text: 'Saved during decode',
        },
      ],
      deleted: [],
    }).then(() => order.push('save'));
    await Promise.all([tile, save]);
    assert.deepEqual(order, ['save', 'tile']);
    const doc = await call('loadBoard', { id: board.id });
    assert.equal(doc.objects[0].text, 'Saved during decode');
    await call('close', {});
  } finally {
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  }
});
