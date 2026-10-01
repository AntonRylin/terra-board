import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { textAppearance } from '../src/canvas/text-style.ts';
import { clipboardObjects } from '../src/canvas/content.ts';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const note = {
  id: 'note',
  type: 'note',
  x: 0,
  y: 0,
  width: 240,
  height: 200,
  z: 1,
  text: 'Two\nlines',
};

test('formatting survives clipboard, save/reopen and portable export, rejecting non-boolean flags', async () => {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/formatting-'));
  let store = new Store(root);
  try {
    const board = store.createBoard({ name: 'Formatting' });
    const aligned = { ...note, bold: true, strikethrough: false };
    assert.deepEqual(clipboardObjects([aligned])[0], aligned);
    store.patchBoard({ id: board.id, revision: 0, upserts: [aligned], deleted: [] });
    store.close();
    store = new Store(root);
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0], aligned);
    const imported = await store.importBoard({ bytes: await store.exportBoard({ id: board.id }) });
    assert.deepEqual(store.loadBoard({ id: imported.id }).objects[0], aligned);
    for (const axis of ['bold', 'strikethrough'])
      for (const value of ['true', 1, null]) {
        assert.throws(() => clipboardObjects([{ ...note, [axis]: value }]), /formatting/i);
        assert.throws(
          () =>
            store.patchBoard({
              id: board.id,
              revision: 1,
              upserts: [{ ...note, [axis]: value }],
              deleted: [],
            }),
          /formatting/i,
        );
      }
  } finally {
    store.close();
  }
});

test('bold uses the same weight for layout, rasterization and the editor', () => {
  assert.equal(textAppearance(note).fontWeight, '400');
  assert.equal(textAppearance({ ...note, bold: true }).fontWeight, '700');
});
