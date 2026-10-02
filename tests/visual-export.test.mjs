import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const require = createRequire(import.meta.url);
const { createVisualExport } = require('../electron/visual-export.cjs');
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

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
  });
  await assert.rejects(service.open(file, false), /no longer available/);
  const first = await service.save({ format: 'png', name: 'Board', bytes: png });
  const second = await service.save({ format: 'png', name: 'Board', bytes: png });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await readFile(file), Buffer.from(png));
  assert.deepEqual(await readdir(dir), ['Board.png']);
  await service.open(second.id, false);
  await service.open(second.id, true);
  assert.deepEqual(actions, [
    ['file', file],
    ['folder', file],
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
