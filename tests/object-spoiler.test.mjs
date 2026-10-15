import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipboardObjects } from '../src/canvas/content.ts';
import {
  canBeSpoiler,
  concealedBy,
  hidesContents,
  isSpoiler,
} from '../src/canvas/spoiler-objects.ts';
const { Store, objectValue } = createRequire(import.meta.url)('../electron/store.cjs');

const item = (id, type, x, y, width, height, z, extra = {}) => ({
  id,
  type,
  x,
  y,
  width,
  height,
  z,
  ...extra,
});

test('whole-object spoilers apply to media, documents, links and frames only', () => {
  for (const type of ['image', 'video', 'document', 'link', 'frame'])
    assert.ok(canBeSpoiler({ type }), type);
  for (const type of ['text', 'note', 'rect', 'ellipse', 'arrow', 'highlight', 'list'])
    assert.ok(!canBeSpoiler({ type }), type);
  assert.ok(isSpoiler({ type: 'image', spoiler: true }));
  assert.ok(!isSpoiler({ type: 'note', spoiler: true }));
  assert.ok(!isSpoiler({ type: 'image' }));
});

test('plain frames and galleries hide their contents; workspaces and linked frames blur', () => {
  assert.ok(hidesContents({ type: 'frame' }));
  assert.ok(hidesContents({ type: 'frame', gallery: { direction: 'right', size: 200, gap: 8 } }));
  assert.ok(!hidesContents({ type: 'frame', pdfComposer: { sources: [], columns: [] } }));
  assert.ok(!hidesContents({ type: 'frame', frameLink: { boardId: 'b', frameId: 'f' } }));
  assert.ok(!hidesContents({ type: 'image' }));
});

test('a hidden frame conceals what lies inside it and above it, plus its gallery images', () => {
  const frame = item('frame', 'frame', 0, 0, 500, 400, 5, { spoiler: true });
  const inside = item('inside', 'note', 50, 50, 100, 100, 6);
  const below = item('below', 'image', 50, 50, 100, 100, 1);
  const outside = item('outside', 'note', 600, 50, 100, 100, 7);
  const crossing = item('crossing', 'note', 450, 50, 100, 100, 8);
  const member = item('member', 'image', 900, 900, 100, 100, 2, { galleryId: 'frame' });
  assert.equal(concealedBy(inside, [frame])?.id, 'frame');
  assert.equal(concealedBy(member, [frame])?.id, 'frame');
  assert.equal(concealedBy(below, [frame]), undefined);
  assert.equal(concealedBy(outside, [frame]), undefined);
  assert.equal(concealedBy(crossing, [frame]), undefined);
  assert.equal(concealedBy(frame, [frame]), undefined);
});

test('the spoiler flag survives copy and paste', () => {
  const [hidden, plain] = clipboardObjects([
    item('a', 'frame', 0, 0, 100, 100, 0, { spoiler: true }),
    item('b', 'frame', 200, 0, 100, 100, 1),
  ]);
  assert.equal(hidden.spoiler, true);
  assert.equal(plain.spoiler, undefined);
});

test('the store validates and keeps the spoiler flag', () => {
  assert.throws(() => objectValue(item('x', 'frame', 0, 0, 100, 100, 0, { spoiler: 'yes' })));
  const root = mkdtempSync(join(tmpdir(), 'terra-spoiler-'));
  let store = new Store(root);
  try {
    const board = store.createBoard({ name: 'Spoilers' });
    store.patchBoard({
      id: board.id,
      revision: 0,
      upserts: [item('frame', 'frame', 0, 0, 300, 200, 1, { text: 'Ending', spoiler: true })],
    });
    store.close();
    store = new Store(root);
    assert.equal(store.loadBoard({ id: board.id }).objects[0].spoiler, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
