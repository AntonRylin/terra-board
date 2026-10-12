import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const require = createRequire(import.meta.url);
const { createVisualExport } = require('../electron/visual-export.cjs');
const { Store } = require('../electron/store.cjs');
import sharp from 'sharp';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
test('TIFF export fallback retains original resolution and pixels, not the 1600px preview', async () => {
  await mkdir(resolve('.local-test'), { recursive: true });
  const root = await mkdtemp(resolve('.local-test/export-tiff-'));
  const store = new Store(root);
  try {
    const bytes = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: '#23afde' },
    })
      .tiff({ compression: 'lzw' })
      .toBuffer();
    const asset = await store.importAsset({ name: 'original.tiff', bytes });
    const file = await store.readAsset({ id: asset.id, variant: 'export' });
    const meta = await sharp(file.file).metadata();
    assert.deepEqual([meta.width, meta.height], [2400, 1200]);
    assert.deepEqual(await sharp(file.file).raw().toBuffer(), await sharp(bytes).raw().toBuffer());
    assert.equal((await store.readAsset({ id: asset.id, variant: 'export' })).file, file.file);
  } finally {
    store.close();
  }
});

test('save, overwrite, and open actions use only successfully exported files', async () => {
  await mkdir(resolve('.local-test'), { recursive: true });
  const dir = await mkdtemp(resolve('.local-test/export-service-'));
  const file = join(dir, 'Board.png');
  const actions = [];
  const service = createVisualExport({
    getWindow: () => null,
    dialog: { showSaveDialog: async () => ({ filePath: file }) },
    shell: {
      openPath: async (p) => {
        actions.push(['file', p]);
        return '';
      },
      showItemInFolder: (p) => actions.push(['folder', p]),
    },
    copyImage: (p) => actions.push(['copy', p]),
  });
  await assert.rejects(service.open(file, false), /no longer available/);
  await assert.rejects(service.copy(file), /no longer available/);
  const first = await service.save({ format: 'png', name: 'Board', bytes: png });
  const second = await service.save({ format: 'png', name: 'Board', bytes: png });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await readFile(file), Buffer.from(png));
  assert.deepEqual(await readdir(dir), ['Board.png']);
  await service.open(second.id, false);
  await service.open(second.id, true);
  await service.copy(second.id);
  assert.deepEqual(actions, [
    ['file', file],
    ['folder', file],
    ['copy', file],
  ]);
});
test('cancellation never yields a success token; invalid data never opens a dialog', async () => {
  let dialogs = 0;
  const service = createVisualExport({
    getWindow: () => null,
    shell: {},
    dialog: {
      showSaveDialog: async () => {
        dialogs++;
        return { canceled: true };
      },
    },
  });
  assert.equal(await service.save({ format: 'png', name: 'Board', bytes: png }), null);
  await assert.rejects(service.save({ format: 'jpg', bytes: png }), /match/);
  await assert.rejects(service.save({ format: 'exe', bytes: png }), /format/);
  assert.equal(dialogs, 1);
});
test('a failed write does not yield an export token', async () => {
  const service = createVisualExport({
    getWindow: () => null,
    shell: {},
    dialog: {
      showSaveDialog: async () => ({
        filePath: resolve('.local-test/missing-export-directory/file.png'),
      }),
    },
  });
  await assert.rejects(service.save({ format: 'png', name: 'Board', bytes: png }), /ENOENT/);
});
