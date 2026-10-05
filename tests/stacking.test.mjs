import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectsOverlap, bringToFrontEdit } from '../src/canvas/stacking.ts';
import * as stacking from '../src/canvas/stacking.ts';

const box = (id, x, y, z = 0, extra = {}) => ({
  id,
  type: 'rect',
  x,
  y,
  width: 100,
  height: 100,
  z,
  ...extra,
});

test('overlap requires shared area, including rotated cards', () => {
  const a = box('a', 0, 0);
  assert.equal(objectsOverlap(a, box('b', 80, 80)), true);
  assert.equal(objectsOverlap(a, box('b', 100, 0)), false);
  assert.equal(objectsOverlap(a, box('b', 120, 0)), false);
  assert.equal(objectsOverlap(a, box('b', 20, 20, 0, { width: 10, height: 10 })), true);
  const rotated = { ...a, rotation: 45 };
  assert.equal(objectsOverlap(rotated, box('b', -20, -20, 0, { width: 10, height: 10 })), false);
  assert.equal(objectsOverlap(rotated, box('b', -20, 45, 0, { width: 10, height: 10 })), true);
});

test('bringing a selection forward preserves its internal order and every other property', () => {
  const a = box('a', 0, 0, 2),
    b = box('b', 40, 40, 8),
    c = box('c', 20, 20, 4);
  const edit = bringToFrontEdit([a, b, c], [c, a]);
  assert.deepEqual(edit, {
    upserts: [
      { ...a, z: 9 },
      { ...c, z: 10 },
    ],
    deleted: [],
  });
  assert.equal(a.z, 2);
  assert.equal(b.z, 8);
});

test('an already frontmost selection creates no undo entry', () => {
  const a = box('a', 0, 0, 1),
    b = box('b', 10, 10, 2);
  assert.deepEqual(bringToFrontEdit([a, b], [b]), { upserts: [], deleted: [] });
  assert.deepEqual(bringToFrontEdit([a, b], []), { upserts: [], deleted: [] });
});

test('frames offer ordering only against overlapping peer frames, never their contents', () => {
  assert.equal(typeof stacking.stackingOverlap, 'function');
  const frame = box('frame', 0, 0, 0, { type: 'frame', width: 400, height: 300 });
  const nested = box('nested', 20, 20, 1, { type: 'frame' });
  assert.equal(stacking.stackingOverlap(frame, box('note', 30, 30)), false);
  assert.equal(stacking.stackingOverlap(frame, box('crossing-note', 350, 30)), false);
  assert.equal(stacking.stackingOverlap(frame, nested), false);
  assert.equal(stacking.stackingOverlap(nested, frame), false);
  assert.equal(stacking.stackingOverlap(frame, box('peer', 350, 30, 1, { type: 'frame' })), true);
  assert.equal(stacking.stackingOverlap(frame, { ...frame, id: 'coincident' }), true);
  assert.equal(
    stacking.stackingOverlap(frame, box('outside', 500, 30, 1, { type: 'frame' })),
    false,
  );
});

test('a frame brings its contents forward together, repairing a frame already above its contents', () => {
  const frame = box('frame', 0, 0, 8, { type: 'frame', width: 400, height: 300 });
  const note = box('note', 30, 30, 1),
    text = box('text', 50, 50, 2, { type: 'text' });
  const peer = box('peer', 350, 30, 9, { type: 'frame' });
  const outside = box('outside', 600, 30, 10),
    partial = box('partial', 350, 200, 7);
  const edit = bringToFrontEdit([note, text, partial, frame, peer, outside], [frame]);
  assert.deepEqual(edit, {
    upserts: [
      { ...frame, z: 11 },
      { ...note, z: 12 },
      { ...text, z: 13 },
    ],
    deleted: [],
  });
});

test('nested frames and gallery members stay above their containers without changing geometry', () => {
  const frame = box('frame', 0, 0, 1, { type: 'frame', width: 500, height: 400 });
  const nested = box('nested', 20, 20, 8, { type: 'frame', width: 200, height: 200 });
  const note = box('note', 40, 40, 2);
  const gallery = box('gallery', 280, 20, 3, {
    type: 'frame',
    gallery: { direction: 'below', size: 100, gap: 12 },
  });
  const image = box('image', 600, 30, 4, { type: 'image', galleryId: 'gallery' });
  const peer = box('peer', 450, 250, 9, { type: 'frame' });
  const edit = bringToFrontEdit([frame, nested, note, gallery, image, peer], [frame]);
  assert.deepEqual(
    edit.upserts.map((o) => o.id),
    ['frame', 'gallery', 'image', 'nested', 'note'],
  );
  for (const updated of edit.upserts) {
    const original = [frame, nested, note, gallery, image].find((o) => o.id === updated.id);
    assert.deepEqual({ ...updated, z: original.z }, original);
    assert.ok(updated.z > peer.z);
  }
});

test('nested item ordering stays within the innermost frame', () => {
  const outer = box('outer', 0, 0, 1, { type: 'frame', width: 600, height: 500 });
  const inner = box('inner', 20, 20, 2, { type: 'frame', width: 200, height: 200 });
  const a = box('a', 30, 30, 3),
    b = box('b', 40, 40, 4);
  const peerFrame = box('peer', 150, 50, 5, { type: 'frame', width: 300, height: 300 });
  const peerItem = box('peer-item', 180, 90, 6);
  const all = [outer, inner, a, b, peerFrame, peerItem];
  const edit = bringToFrontEdit(all, [a]);
  const next = all.map((o) => edit.upserts.find((p) => p.id === o.id) || o);
  assert.deepEqual(
    [...next].sort((a, b) => a.z - b.z).map((o) => o.id),
    ['outer', 'inner', 'b', 'a', 'peer', 'peer-item'],
  );
});

test('a lone framed item makes no ordering edit even when another frame covers it', () => {
  const frame = box('a', 0, 0, 1, { type: 'frame', width: 400, height: 300 });
  const note = box('note', 230, 30, 2);
  const overlay = box('b', 200, 0, 4, { type: 'frame', width: 400, height: 300 });
  const other = box('other', 250, 40, 5);
  assert.deepEqual(bringToFrontEdit([frame, note, overlay, other], [note]), {
    upserts: [],
    deleted: [],
  });
});

test('rotated frame membership excludes items outside its actual rotated outline', () => {
  const frame = box('frame', 0, 0, 1, { type: 'frame', rotation: 45, width: 200, height: 200 });
  const inside = box('inside', 80, 80, 2, { width: 20, height: 20 });
  const outside = box('outside', -30, -30, 3, { width: 20, height: 20 });
  const peer = box('peer', 170, 50, 4, { type: 'frame' });
  assert.deepEqual(
    bringToFrontEdit([frame, inside, outside, peer], [frame]).upserts.map((o) => o.id),
    ['frame', 'inside'],
  );
});

test('an item ignores its parent frame and overlapping items belonging to another frame', () => {
  const frame = box('a', 0, 0, 1, { type: 'frame', width: 400, height: 300 });
  const note = box('note', 230, 30, 2);
  const overlay = box('b', 200, 0, 4, { type: 'frame', width: 400, height: 300 });
  const otherNote = box('other', 250, 40, 5);
  const all = [frame, note, overlay, otherNote];
  assert.equal(stacking.stackingOverlap(note, frame, all), false);
  assert.equal(stacking.stackingOverlap(note, overlay, all), false);
  assert.equal(stacking.stackingOverlap(note, otherNote, all), false);
});

test('local bring-to-front stays below an overlying frame and its contents', () => {
  const frame = box('a', 0, 0, 1, { type: 'frame', width: 400, height: 300 });
  const note = box('note', 230, 30, 2),
    sibling = box('sibling', 240, 40, 3);
  const overlay = box('b', 200, 0, 4, { type: 'frame', width: 400, height: 300 });
  const otherNote = box('other', 250, 40, 5);
  const all = [frame, note, sibling, overlay, otherNote];
  assert.equal(stacking.stackingOverlap(note, sibling, all), true);
  const edit = bringToFrontEdit(all, [note]);
  const next = all.map((o) => edit.upserts.find((p) => p.id === o.id) || o);
  assert.deepEqual(
    [...next].sort((a, b) => a.z - b.z).map((o) => o.id),
    ['a', 'sibling', 'note', 'b', 'other'],
  );
  assert.equal(stacking.stackingOverlap(next[1], next[4], next), false);
});

test('a frame raises only its own descendants, including when peer-frame contents occupy shared space', () => {
  const frame = box('a', 0, 0, 1, { type: 'frame', width: 400, height: 300 });
  const note = box('note', 230, 30, 2);
  const overlay = box('b', 200, 0, 4, { type: 'frame', width: 400, height: 300 });
  const otherNote = box('other', 250, 40, 5);
  const all = [frame, note, overlay, otherNote];
  const edit = bringToFrontEdit(all, [frame]);
  const next = all.map((o) => edit.upserts.find((p) => p.id === o.id) || o);
  assert.deepEqual(
    [...next].sort((a, b) => a.z - b.z).map((o) => o.id),
    ['b', 'other', 'a', 'note'],
  );
  assert.equal(stacking.stackingOverlap(next[1], next[3], next), false);
  assert.deepEqual(
    stacking
      .stackingSelection(next, [next[0]])
      .map((o) => o.id)
      .sort(),
    ['a', 'note'],
  );
});
