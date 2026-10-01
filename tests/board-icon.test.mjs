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

test('uploaded board icons survive reopen, duplication and transfer to a fresh library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-icons-'));
  let source = new Store(join(root, 'source'));
  const target = new Store(join(root, 'target'));
  try {
    const asset = await source.importAsset({
      name: 'icon.png',
      bytes: await sharp({
        create: { width: 128, height: 128, channels: 4, background: '#a34fd2' },
      })
        .png()
        .toBuffer(),
    });
    const board = source.createBoard({ name: 'Custom icon' });
    const icon = 'asset-' + asset.id;
    source.updateBoard({ id: board.id, patch: { icon } });
    assert.equal(source.duplicateBoard({ id: board.id }).icon, icon);
    source.close();
    source = new Store(join(root, 'source'));
    assert.equal(source.loadBoard({ id: board.id }).board.icon, icon);
    const packed = await source.exportBoard({ id: board.id });
    const imported = await target.importBoard({ bytes: packed });
    assert.equal(imported.icon, icon);
    assert.ok(target.asset({ id: asset.id, variant: 'thumb' }).file);
    assert.throws(
      () => source.updateBoard({ id: board.id, patch: { icon: 'asset-' + '0'.repeat(64) } }),
      /icon/i,
    );
    assert.throws(
      () => source.updateBoard({ id: board.id, patch: { icon: 'https://example.com/image.png' } }),
      /icon/i,
    );
    const entries = unzipSync(packed);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    manifest.assets = [];
    entries['manifest.json'] = strToU8(JSON.stringify(manifest));
    await assert.rejects(target.importBoard({ bytes: zipSync(entries) }), /icon|media/i);
    source.updateBoard({ id: board.id, patch: { icon: 'lightbulb' } });
    assert.equal(source.board(board.id).icon, 'lightbulb');
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});
