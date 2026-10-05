import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { objectValue } = createRequire(import.meta.url)('../electron/store.cjs');
const { Store } = createRequire(import.meta.url)('../electron/store.cjs');

test('external edits cannot modify, delete or unlock locked items and persistence survives reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'terra-lock-'));
  let store = new Store(root);
  try {
    const board = store.createBoard({ name: 'Locks' });
    const object = {
      id: 'item',
      type: 'note',
      x: 0,
      y: 0,
      width: 200,
      height: 150,
      z: 1,
      locked: true,
    };
    store.patchBoard({ id: board.id, revision: 0, upserts: [object] });
    store.close();
    store = new Store(root);
    assert.equal(store.loadBoard({ id: board.id }).objects[0].locked, true);
    for (const edit of [
      { upserts: [{ ...object, x: 80 }] },
      { upserts: [{ ...object, locked: false }] },
      { deleted: [object.id] },
    ]) {
      assert.throws(
        () => store.patchBoard({ id: board.id, revision: 1, protectLocked: true, ...edit }),
        /Objects are locked/,
      );
      assert.equal(store.loadBoard({ id: board.id }).revision, 1);
    }
    store.patchBoard({ id: board.id, revision: 1, upserts: [{ ...object, locked: false }] });
    store.patchBoard({
      id: board.id,
      revision: 2,
      protectLocked: true,
      upserts: [{ ...object, locked: false, x: 80 }],
    });
    assert.equal(store.loadBoard({ id: board.id }).objects[0].x, 80);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
const note = {
  id: 'locked-note',
  type: 'note',
  x: 0,
  y: 0,
  width: 200,
  height: 150,
  z: 1,
  assetId: 'a'.repeat(64),
  url: 'https://example.com',
};

test('object locks survive persisted object validation for every item type', () => {
  for (const type of [
    'note',
    'text',
    'rect',
    'ellipse',
    'frame',
    'image',
    'video',
    'document',
    'link',
    'arrow',
    'list',
  ]) {
    const object = {
      ...note,
      type,
      ...(type === 'arrow'
        ? {
            arrow: {
              points: [
                { x: 0, y: 0 },
                { x: 1, y: 1 },
              ],
              line: 'straight',
              start: 'none',
              end: 'arrow',
              dash: 'solid',
              thickness: 2,
            },
          }
        : {}),
      ...(type === 'list' ? { items: [] } : {}),
    };
    assert.equal(objectValue({ ...object, locked: true }).locked, true, type);
    assert.equal(objectValue({ ...object, locked: false }).locked, false, type);
  }
  assert.throws(() => objectValue({ ...note, locked: 'true' }), /Invalid/);
});

import { editTouchesLocked } from '../src/canvas/object-lock.ts';
import { History } from '../src/canvas/history.ts';
import { stackingSelection } from '../src/canvas/stacking.ts';

test('locked items reject movement, edits, deletion and gallery insertions atomically', () => {
  const objects = new Map([[note.id, { ...note, locked: true }]]);
  for (const patch of [
    { x: 100 },
    { text: 'changed' },
    { locked: false },
    { width: 300 },
    { rotation: 90 },
  ])
    assert.equal(
      editTouchesLocked(objects, { upserts: [{ ...note, ...patch }], deleted: [] }),
      true,
    );
  assert.equal(editTouchesLocked(objects, { upserts: [], deleted: [note.id] }), true);
  assert.equal(
    editTouchesLocked(objects, {
      upserts: [{ ...note, id: 'new', galleryId: note.id }],
      deleted: [],
    }),
    true,
  );
  assert.equal(
    editTouchesLocked(objects, { upserts: [{ ...note, id: 'unrelated' }], deleted: [] }),
    false,
  );
});

test('blocked undo and redo retain their entries until the item is unlocked', () => {
  const history = new History();
  const objects = new Map([[note.id, { ...note, locked: true }]]);
  const before = { upserts: [note], deleted: [] };
  const after = { upserts: [{ ...note, x: 20 }], deleted: [] };
  history.push(after, before);
  const allow = (edit) => !editTouchesLocked(objects, edit);
  assert.equal(history.undo(allow), null);
  assert.equal(history.canUndo, true);
  objects.set(note.id, note);
  assert.deepEqual(history.undo(allow), before);
  objects.set(note.id, { ...note, locked: true });
  assert.equal(history.redo(allow), null);
  assert.equal(history.canRedo, true);
  objects.set(note.id, note);
  assert.deepEqual(history.redo(allow), after);
});

test('locking a frame includes nested contents and gallery members', () => {
  const frame = { ...note, id: 'frame', type: 'frame', width: 800, height: 600, z: 0 };
  const gallery = {
    ...note,
    id: 'gallery',
    type: 'frame',
    x: 300,
    gallery: { direction: 'below', size: 100, gap: 12 },
  };
  const image = {
    ...note,
    id: 'image',
    type: 'image',
    x: 310,
    y: 20,
    width: 50,
    height: 50,
    galleryId: gallery.id,
  };
  assert.deepEqual(
    new Set(stackingSelection([frame, note, gallery, image], [frame]).map((o) => o.id)),
    new Set(['frame', note.id, 'gallery', 'image']),
  );
});
