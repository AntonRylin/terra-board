import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { clipboardObjects } from '../src/canvas/content.ts';
import { resizeObject, resizeSelection } from '../src/canvas/resize.ts';
const { Store, objectValue } = createRequire(import.meta.url)('../electron/store.cjs');
const list = {
  id: 'list',
  type: 'list',
  x: 120,
  y: 100,
  width: 320,
  height: 190,
  z: 1,
  text: '',
  items: [
    { id: 'first', text: 'Plan the trip', checked: false },
    { id: 'second', text: 'Book train', checked: true },
  ],
};

test('unnamed lists and checked items survive clipboard, reopen and portable export', async () => {
  const root = mkdtempSync(join(tmpdir(), 'terra-lists-'));
  let source = new Store(join(root, 'source'));
  const target = new Store(join(root, 'target'));
  try {
    const board = source.createBoard({ name: 'Lists' });
    source.patchBoard({ id: board.id, revision: 0, upserts: [list], deleted: [] });
    assert.equal(source.searchContent({ query: 'Book train' }).results[0].objectId, list.id);
    assert.deepEqual(clipboardObjects([list])[0], objectValue(list));
    const copied = clipboardObjects([list])[0];
    copied.items[0].checked = true;
    assert.equal(list.items[0].checked, false);
    source.close();
    source = new Store(join(root, 'source'));
    assert.deepEqual(source.loadBoard({ id: board.id }).objects[0], list);
    const imported = await target.importBoard({
      bytes: await source.exportBoard({ id: board.id }),
    });
    assert.deepEqual(target.loadBoard({ id: imported.id }).objects[0].items, list.items);
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('list validation rejects corrupt rows and repeated row IDs', () => {
  for (const items of [
    null,
    [{ id: 'a', text: 4, checked: false }],
    [{ id: 'a', text: '', checked: 'yes' }],
    [
      { id: 'a', text: '', checked: false },
      { id: 'a', text: '', checked: true },
    ],
  ]) {
    assert.throws(() => objectValue({ ...list, items }), /list/i);
    assert.throws(() => clipboardObjects([{ ...list, items }]), /list/i);
  }
});

test('resizing a list alone or with other objects preserves room for its editable rows', () => {
  const minHeight = 100 + list.items.length * 44;
  const resized = resizeObject(list, 'se', -300, -180, true);
  assert.ok(resized.width >= 240 && resized.height >= minHeight);
  const [grouped] = resizeSelection(
    [list],
    { x: 120, y: 100, width: 320, height: 190 },
    'se',
    -300,
    -180,
  );
  assert.ok(grouped.width >= 240 && grouped.height >= minHeight);
});
