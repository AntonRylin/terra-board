import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { textPlacement } from '../src/canvas/text-alignment.ts';
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

test('frame names sit outside the top-left edge even with legacy centering flags', () => {
  const frame = { ...note, type: 'frame', centerX: true, centerY: true };
  const a = { padding: 0, wrapWidth: 240, lineHeight: 20 };
  assert.deepEqual(textPlacement(frame, a, 2), { left: 0, top: -48, height: 40 });
});
test('horizontal and vertical centering are independent and overflow stays top-aligned', () => {
  const a = { padding: 20, wrapWidth: 194, lineHeight: 30 };
  assert.deepEqual(textPlacement(note, a, 2), { left: 20, top: 20, height: 60 });
  assert.deepEqual(textPlacement({ ...note, centerX: true }, a, 2), {
    left: 23,
    top: 20,
    height: 60,
  });
  assert.deepEqual(textPlacement({ ...note, centerY: true }, a, 2), {
    left: 20,
    top: 70,
    height: 60,
  });
  assert.deepEqual(textPlacement({ ...note, centerX: true, centerY: true }, a, 2), {
    left: 23,
    top: 70,
    height: 60,
  });
  assert.equal(textPlacement({ ...note, centerY: true }, a, 20).top, 20);
});
test('alignment survives clipboard, save/reopen and portable export, rejecting non-boolean flags', async () => {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/alignment-'));
  let store = new Store(root);
  try {
    const board = store.createBoard({ name: 'Alignment' });
    const aligned = { ...note, centerX: true, centerY: false };
    assert.deepEqual(clipboardObjects([aligned])[0], aligned);
    store.patchBoard({ id: board.id, revision: 0, upserts: [aligned], deleted: [] });
    store.close();
    store = new Store(root);
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0], aligned);
    const imported = await store.importBoard({ bytes: await store.exportBoard({ id: board.id }) });
    assert.deepEqual(store.loadBoard({ id: imported.id }).objects[0], aligned);
    for (const axis of ['centerX', 'centerY'])
      for (const value of ['true', 1, null]) {
        assert.throws(() => clipboardObjects([{ ...note, [axis]: value }]), /alignment/i);
        assert.throws(
          () =>
            store.patchBoard({
              id: board.id,
              revision: 1,
              upserts: [{ ...note, [axis]: value }],
              deleted: [],
            }),
          /alignment/i,
        );
      }
  } finally {
    store.close();
  }
});
