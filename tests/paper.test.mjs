import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resizeObject, resizeSelection } from '../src/canvas/resize.ts';
import { localToWorld } from '../src/canvas/transform.ts';
import {
  paginateLines,
  paperContentHeight,
  paperHeight,
  paperPages,
  paperWidth,
  withPaperPages,
} from '../src/canvas/paper-layout.ts';

const require = createRequire(import.meta.url);
const paper = (pages = 1, scale = 0.5) => ({
  id: 'paper',
  type: 'paper',
  x: 10,
  y: 20,
  width: paperWidth * scale,
  height: paperHeight(pages, scale),
  z: 1,
  text: 'Hello',
});

test('page count follows the height at any scale', () => {
  for (const scale of [0.1, 0.5, 1, 3])
    for (const pages of [1, 2, 7]) assert.equal(paperPages(paper(pages, scale)), pages);
});

test('adding and removing pages keeps the top-left corner, also when rotated', () => {
  const grown = withPaperPages(paper(1), 3);
  assert.equal(paperPages(grown), 3);
  assert.equal(grown.x, 10);
  assert.equal(grown.y, 20);
  const rotated = { ...paper(2), rotation: 30 };
  const corner = localToWorld(rotated, { x: 0, y: 0 });
  const shrunk = withPaperPages(rotated, 1);
  const after = localToWorld(shrunk, { x: 0, y: 0 });
  assert.equal(paperPages(shrunk), 1);
  assert.ok(Math.abs(after.x - corner.x) < 1e-9 && Math.abs(after.y - corner.y) < 1e-9);
});

test('lines that would cross the bottom margin move to the next page', () => {
  const lines = Array.from({ length: 50 }, () => ({ height: 24 }));
  const pages = paginateLines(lines);
  const perPage = Math.floor(paperContentHeight / 24);
  assert.equal(pages[0].length, perPage);
  assert.equal(pages.flat().length, 50);
  assert.ok(
    pages.every((page) => page.reduce((sum, l) => sum + l.height, 0) <= paperContentHeight),
  );
  // A line taller than a whole page still gets a page of its own.
  assert.equal(paginateLines([{ height: 5000 }, { height: 24 }]).length, 2);
});

test('every handle scales a document uniformly and keeps its page count', () => {
  const o = paper(3);
  for (const [handle, dx, dy] of [
    ['se', 40, 40],
    ['e', 60, 0],
    ['s', 0, 200],
    ['nw', -30, -10],
  ]) {
    const resized = resizeObject(o, handle, dx, dy, false);
    assert.ok(resized.width > o.width, handle);
    assert.ok(Math.abs(resized.width / resized.height - o.width / o.height) < 1e-9, handle);
    assert.equal(paperPages(resized), 3, handle);
  }
  const [scaled] = resizeSelection([o], { x: 10, y: 20, width: 100, height: 100 }, 'se', 50, 50);
  assert.equal(paperPages(scaled), 3);
});

test('storage accepts documents with formatted text', () => {
  const { objectValue } = require('../electron/store.cjs');
  const saved = objectValue({
    ...paper(2),
    text: 'Bold start',
    textMarks: [{ start: 0, end: 4, bold: true }],
  });
  assert.equal(saved.type, 'paper');
  assert.deepEqual(saved.textMarks, [{ start: 0, end: 4, bold: true }]);
});
