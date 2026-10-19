import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipboardObjects } from '../src/canvas/content.ts';
import { stackingSelection, copySelection } from '../src/canvas/stacking.ts';
import {
  linkedFrameScene,
  linkedFrameTitle,
  independentFrameCopy,
} from '../src/canvas/frame-links.ts';
import { exportPlan } from '../src/canvas/export-plan.ts';
const { Store } = createRequire(import.meta.url)('../electron/store.cjs');
const frame = {
  id: 'original',
  type: 'frame',
  x: 0,
  y: 0,
  width: 500,
  height: 300,
  z: 0,
  text: 'Process A',
};
const link = {
  ...frame,
  id: 'instance',
  x: 600,
  frameLink: { boardId: 'source', frameId: 'original' },
};

test('linked frame references survive storage and clipboard without cloning source contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'terra-frame-links-'));
  const store = new Store(root);
  try {
    const board = store.createBoard({ name: 'Process B' });
    store.patchBoard({ id: board.id, revision: 0, upserts: [link], deleted: [] });
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0].frameLink, link.frameLink);
    assert.deepEqual(clipboardObjects([link])[0].frameLink, link.frameLink);
    assert.equal(store.loadBoard({ id: board.id }).objects.length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('linked frames cannot acquire editable children from overlapping board objects', () => {
  const unrelated = {
    ...frame,
    type: 'note',
    id: 'other',
    x: 650,
    y: 30,
    width: 100,
    height: 100,
    z: 1,
  };
  assert.deepEqual(
    stackingSelection([link, unrelated], [link]).map((o) => o.id),
    ['instance'],
  );
});

test('clipboard rejects invalid references and mixed frame modes', () => {
  for (const invalid of [
    { ...link, frameLink: { boardId: '../bad', frameId: 'original' } },
    { ...link, frameLink: null },
    { ...link, type: 'note' },
    { ...link, gallery: { direction: 'right', size: 100, gap: 10 } },
  ])
    assert.throws(() => clipboardObjects([invalid]), /frame link/i);
});

test('three instances resolve current source contents and title without altering source geometry', () => {
  const note = {
    ...frame,
    id: 'step',
    type: 'note',
    x: 50,
    y: 50,
    width: 100,
    height: 80,
    text: 'Before',
    z: 1,
  };
  const boards = new Map([['source', [frame, note]]]);
  const instances = [0, 1, 2].map((i) => ({ ...link, id: `link-${i}`, x: 600 + i * 550 }));
  for (const instance of instances)
    assert.equal(linkedFrameScene(instance, boards).children[0].object.text, 'Before');
  boards.set('source', [
    { ...frame, text: 'Renamed A' },
    { ...note, text: 'After' },
  ]);
  for (const instance of instances) {
    const scene = linkedFrameScene(instance, boards);
    assert.equal(linkedFrameTitle(scene), 'Renamed A');
    assert.equal(scene.children[0].object.text, 'After');
  }
  assert.equal(note.text, 'Before');
  assert.equal(frame.text, 'Process A');
});

test('rotated source frames project only fully contained objects into source-local coordinates', () => {
  const source = { ...frame, x: 100, y: 100, width: 300, height: 300, rotation: 90 };
  const note = {
    ...frame,
    id: 'inside',
    type: 'note',
    x: 300,
    y: 150,
    width: 50,
    height: 50,
    rotation: 90,
    z: 1,
  };
  const outside = { ...note, id: 'outside', x: 600 };
  const scene = linkedFrameScene(link, new Map([['source', [source, note, outside]]]));
  assert.equal(scene.children.length, 1);
  assert.equal(scene.children[0].object.rotation, 0);
  assert.ok(Math.abs(scene.children[0].object.x - 50) < 1e-8);
  assert.ok(Math.abs(scene.children[0].object.y - 50) < 1e-8);
});

test('missing and loading sources recover and circular cross-board branches terminate', () => {
  const boards = new Map();
  assert.equal(linkedFrameScene(link, boards).status, 'loading');
  boards.set('source', null);
  assert.equal(linkedFrameScene(link, boards).status, 'missing');
  const aToB = {
    ...link,
    id: 'a-b',
    x: 10,
    y: 10,
    width: 100,
    height: 100,
    frameLink: { boardId: 'b', frameId: 'b-root' },
  };
  const bToA = { ...aToB, id: 'b-a', frameLink: link.frameLink };
  boards.set('source', [frame, aToB]);
  boards.set('b', [{ ...frame, id: 'b-root' }, bToA]);
  const scene = linkedFrameScene(link, boards);
  assert.equal(scene.source.id, frame.id);
  assert.equal(scene.children[0].children[0].status, 'circular');
});

test('exporting a linked frame does not include unrelated overlapping destination objects', () => {
  const other = {
    ...frame,
    type: 'note',
    id: 'other',
    x: 650,
    y: 30,
    width: 100,
    height: 100,
    z: 1,
  };
  const plan = exportPlan(
    [link, other],
    [link.id],
    'selection',
    { x: 0, y: 0, zoom: 1 },
    { width: 1400, height: 900 },
  );
  assert.deepEqual(
    plan.objects.map((o) => o.id),
    [link.id],
  );
});

test('copying a frame takes its contents along in stacking order', () => {
  const inside = { id: 'note', type: 'note', x: 40, y: 40, width: 100, height: 80, z: 2 };
  const below = { id: 'shape', type: 'rect', x: 200, y: 60, width: 50, height: 50, z: 1 };
  const outside = { id: 'away', type: 'rect', x: 900, y: 0, width: 50, height: 50, z: 3 };
  const all = [frame, inside, below, outside];
  assert.deepEqual(
    copySelection(all, [frame]).map((o) => o.id),
    ['original', 'shape', 'note'],
  );
  assert.deepEqual(copySelection(all, [inside]), [inside]);
});

test('an independent copy of a linked frame is the original, centred over the link', () => {
  const inside = { id: 'note', type: 'note', x: 40, y: 40, width: 100, height: 80, z: 1 };
  const nested = { ...link, id: 'nested', x: 300, y: 100, width: 100, height: 60, z: 2 };
  const small = { ...link, width: 250, height: 150 };
  const copy = independentFrameCopy(small, [frame, inside, nested]);
  assert.deepEqual(
    copy.map((o) => o.id),
    ['original', 'note', 'nested'],
  );
  assert.equal(copy[0].frameLink, undefined);
  assert.equal(copy[0].width, 500);
  assert.deepEqual([copy[0].x, copy[0].y], [600 + 125 - 250, 75 - 150]);
  assert.deepEqual([copy[1].x, copy[1].y], [40 + 475, 40 - 75]);
  // Linked frames inside the original stay links.
  assert.deepEqual(copy[2].frameLink, link.frameLink);
  assert.equal(independentFrameCopy(small, [inside]), null);
  assert.equal(independentFrameCopy(frame, [frame]), null);
});
