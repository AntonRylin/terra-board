import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPin,
  dragPin,
  pinBar,
  pinKind,
  pinMinimum,
  pinnedObjects,
  placePin,
  readPins,
} from '../src/canvas/pins.ts';

const view = { width: 1600, height: 900 };
const box = (id, type, x, y, width, height, extra = {}) => ({
  id,
  type,
  x,
  y,
  width,
  height,
  z: 0,
  ...extra,
});

test('documents and checklists stay editable; everything else is a picture', () => {
  assert.equal(pinKind({ type: 'paper' }), 'paper');
  assert.equal(pinKind({ type: 'list' }), 'list');
  for (const type of ['image', 'frame', 'note', 'text', 'link', 'html', 'rect'])
    assert.equal(pinKind({ type }), 'picture');
});

test('a pinned frame shows what is inside it; other objects show alone', () => {
  const all = [
    box('frame', 'frame', 0, 0, 400, 300, { z: 1 }),
    box('inside', 'image', 50, 50, 100, 100, { z: 3 }),
    box('note', 'note', 200, 100, 80, 80, { z: 2 }),
    box('across', 'note', 350, 250, 100, 100, { z: 4 }),
    box('outside', 'image', 900, 900, 100, 100),
  ];
  assert.deepEqual(
    pinnedObjects(all, 'frame').map((o) => o.id),
    ['frame', 'note', 'inside'],
  );
  assert.deepEqual(
    pinnedObjects(all, 'inside').map((o) => o.id),
    ['inside'],
  );
  assert.deepEqual(pinnedObjects(all, 'gone'), []);
  // A linked frame draws its original itself; nothing on this board is inside it.
  const link = box('link', 'frame', 0, 0, 400, 300, { frameLink: { boardId: 'b', frameId: 'f' } });
  assert.deepEqual(
    pinnedObjects([link, all[1]], 'link').map((o) => o.id),
    ['link'],
  );
});

test('a picture pin keeps the shape of what it shows while resized', () => {
  const pin = placePin('b', 'o', 'picture', { left: 300, top: 200, width: 400, height: 200 }, view, 2);
  assert.equal(pin.width, 400);
  assert.equal(pin.height, 200 + pinBar);
  assert.equal(pin.top, 200 - pinBar);
  const wider = dragPin(pin, 'se', 200, 0, view, pinMinimum.picture, 2);
  assert.equal(wider.width, 600);
  assert.equal(wider.height, 300 + pinBar);
  assert.equal(wider.left, pin.left);
  const taller = dragPin(pin, 's', 0, 100, view, pinMinimum.picture, 2);
  assert.equal(taller.height - pinBar, 300);
  assert.equal(taller.width, 600);
  // Dragging the left edge keeps the right edge where it was.
  const left = dragPin(pin, 'w', -100, 0, view, pinMinimum.picture, 2);
  assert.equal(left.left + left.width, pin.left + pin.width);
  assert.equal(left.width, 500);
  // It never grows past the window.
  const huge = dragPin(pin, 'se', 5000, 0, view, pinMinimum.picture, 2);
  assert.ok(huge.width <= view.width - 16 && huge.height <= view.height - 16);
  assert.ok(Math.abs(huge.width / (huge.height - pinBar) - 2) < 1e-9);
});

test('documents resize freely and every pin stays on screen', () => {
  const pin = { boardId: 'b', objectId: 'o', left: 100, top: 100, width: 400, height: 500 };
  const resized = dragPin(pin, 'se', 50, -100, view, pinMinimum.paper);
  assert.equal(resized.width, 450);
  assert.equal(resized.height, 400);
  const moved = dragPin(pin, null, 5000, -5000, view, pinMinimum.paper);
  assert.equal(moved.left, view.width - pin.width - 8);
  assert.equal(moved.top, 8);
  const small = clampPin({ ...pin, width: 10, height: 10 }, view, pinMinimum.paper);
  assert.equal(small.width, pinMinimum.paper.width);
  assert.equal(small.height, pinMinimum.paper.height);
});

test('saved pins are validated and kept once each', () => {
  const pin = { boardId: 'a', objectId: '1', left: 1, top: 2, width: 300, height: 200 };
  assert.deepEqual(
    readPins(
      JSON.stringify([
        { ...pin, extra: true },
        pin,
        { ...pin, objectId: 2 },
        { ...pin, objectId: '3', width: 'wide' },
        null,
      ]),
    ),
    [pin],
  );
  assert.deepEqual(readPins('not json'), []);
  assert.deepEqual(readPins(null), []);
});
