import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const appearance = { blur: 18, brightness: 125, saturation: 145, sharpness: 35, filter: 'sepia' };
const defaults = { blur: 0, brightness: 100, saturation: 100, sharpness: 0, filter: 'none' };

test('board wallpaper persists independently through reopen, duplication, and portable transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'terra-wallpaper-'));
  let source = new Store(join(root, 'source'));
  const target = new Store(join(root, 'target'));
  try {
    const board = source.createBoard({ name: 'Wallpaper' });
    const other = source.createBoard({ name: 'Plain' });
    const asset = await source.importAsset({
      name: 'wallpaper.png',
      bytes: await sharp({
        create: { width: 160, height: 90, channels: 4, background: '#336699' },
      })
        .png()
        .toBuffer(),
    });
    source.updateBoard({
      id: board.id,
      patch: { backgroundAssetId: asset.id, backgroundAppearance: appearance },
    });
    assert.deepEqual(source.board(board.id).backgroundAppearance, appearance);
    assert.deepEqual(source.board(other.id).backgroundAppearance, defaults);
    assert.equal(source.loadBoard({ id: board.id }).board.backgroundAssetId, asset.id);
    assert.equal(source.board(other.id).backgroundAssetId, null);
    assert.equal(
      source.library().boards.find((b) => b.id === board.id).backgroundAssetId,
      asset.id,
    );
    const copy = source.duplicateBoard({ id: board.id });
    assert.equal(copy.backgroundAssetId, asset.id);
    assert.deepEqual(copy.backgroundAppearance, appearance);
    source.close();
    source = new Store(join(root, 'source'));
    assert.equal(source.board(board.id).backgroundAssetId, asset.id);
    assert.deepEqual(source.board(board.id).backgroundAppearance, appearance);
    const packed = await source.exportBoard({ id: board.id });
    const imported = await target.importBoard({ bytes: packed });
    assert.equal(imported.backgroundAssetId, asset.id);
    assert.deepEqual(imported.backgroundAppearance, appearance);
    assert.equal(target.asset({ id: asset.id }).mime, 'image/png');
    source.updateBoard({ id: board.id, patch: { backgroundAssetId: null } });
    assert.equal(source.board(board.id).backgroundAssetId, null);
    assert.equal(source.board(copy.id).backgroundAssetId, asset.id);
    const broken = unzipSync(packed);
    const manifest = JSON.parse(strFromU8(broken['manifest.json']));
    manifest.assets = [];
    broken['manifest.json'] = strToU8(JSON.stringify(manifest));
    await assert.rejects(target.importBoard({ bytes: zipSync(broken) }), /missing media/i);
    // Libraries and portable boards from before wallpapers still open normally.
    delete manifest.backgroundAssetId;
    delete manifest.backgroundAppearance;
    broken['manifest.json'] = strToU8(JSON.stringify(manifest));
    assert.equal((await target.importBoard({ bytes: zipSync(broken) })).backgroundAssetId, null);
    assert.deepEqual(
      (await target.importBoard({ bytes: zipSync(broken) })).backgroundAppearance,
      defaults,
    );
    source.db.exec('ALTER TABLE boards DROP COLUMN backgroundAssetId');
    source.db.exec('ALTER TABLE boards DROP COLUMN backgroundAppearance');
    source.close();
    source = new Store(join(root, 'source'));
    assert.equal(source.board(board.id).backgroundAssetId, null);
    assert.deepEqual(source.board(board.id).backgroundAppearance, defaults);
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('wallpapers reject missing assets, invalid identifiers and non-images without changing a board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'terra-wallpaper-validation-'));
  const store = new Store(root);
  try {
    const board = store.createBoard({ name: 'Validation' });
    const document = await store.importAsset({ name: 'notes.txt', bytes: Buffer.from('notes') });
    for (const backgroundAppearance of [
      null,
      [],
      false,
      { blur: -1 },
      { blur: 41 },
      { brightness: 201 },
      { saturation: -1 },
      { sharpness: 101 },
      { blur: NaN },
      { filter: 'unknown' },
    ]) {
      assert.throws(
        () => store.updateBoard({ id: board.id, patch: { backgroundAppearance } }),
        /background/i,
      );
    }
    for (const filter of ['none', 'sepia', 'mono', 'warm', 'cool']) {
      store.updateBoard({ id: board.id, patch: { backgroundAppearance: { ...defaults, filter } } });
      assert.equal(store.board(board.id).backgroundAppearance.filter, filter);
    }
    for (const backgroundAssetId of ['', false, 12, {}, '../file', '0'.repeat(64), document.id]) {
      assert.throws(
        () => store.updateBoard({ id: board.id, patch: { backgroundAssetId } }),
        /background/i,
      );
      assert.equal(store.board(board.id).backgroundAssetId, null);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
