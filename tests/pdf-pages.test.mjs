import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  baseName,
  clampGap,
  imageKind,
  jpegOrientation,
  mergedName,
  pageImageSize,
  pageName,
  pageRotation,
  readingOrder,
  stackPages,
} from '../src/canvas/pdf-pages.ts';

const image = (id, x, y, width = 100, height = 140, extra = {}) => ({
  id,
  type: 'image',
  x,
  y,
  width,
  height,
  z: 0,
  ...extra,
});

test('pages stack vertically or side by side with the chosen space', () => {
  const sizes = [
    { width: 595, height: 842 },
    { width: 842, height: 595 },
    { width: 595, height: 842 },
  ];
  assert.deepEqual(
    stackPages({ x: 10, y: 20 }, sizes, 'vertical', 100).map(({ x, y }) => [x, y]),
    [
      [10, 20],
      [10, 962],
      [10, 1657],
    ],
  );
  assert.deepEqual(
    stackPages({ x: 10, y: 20 }, sizes, 'horizontal', 0).map(({ x, y }) => [x, y]),
    [
      [10, 20],
      [605, 20],
      [1447, 20],
    ],
  );
});

test('page space is limited to the slider range', () => {
  assert.equal(clampGap(-5), 0);
  assert.equal(clampGap(5000), 1000);
  assert.equal(clampGap(Number.NaN), 40);
  assert.equal(clampGap(42.6), 43);
});

test('page images keep PDF proportions within a readable width', () => {
  assert.deepEqual(pageImageSize(595, 842), { width: 595, height: 842 });
  assert.deepEqual(pageImageSize(200, 100), { width: 400, height: 200 });
  assert.deepEqual(pageImageSize(1800, 900), { width: 900, height: 450 });
});

test('merging reads rows top to bottom and left to right', () => {
  const vertical = [image('c', 0, 400), image('a', 0, 0), image('b', 0, 200)];
  assert.deepEqual(
    readingOrder(vertical).map((o) => o.id),
    ['a', 'b', 'c'],
  );
  // Slightly uneven tops still read as one row.
  const row = [image('b', 160, 12), image('c', 320, -8), image('a', 0, 0, 100, 200)];
  assert.deepEqual(
    readingOrder(row).map((o) => o.id),
    ['a', 'b', 'c'],
  );
  const grid = [image('d', 160, 300), image('b', 160, 0), image('c', 0, 300), image('a', 0, 0)];
  assert.deepEqual(
    readingOrder(grid).map((o) => o.id),
    ['a', 'b', 'c', 'd'],
  );
});

test('only right-angle image turns become page rotations', () => {
  assert.equal(pageRotation(undefined), 0);
  assert.equal(pageRotation(90), 90);
  assert.equal(pageRotation(-90), 270);
  assert.equal(pageRotation(450), 90);
  assert.equal(pageRotation(30), 0);
});

test('page and merged names follow the source document', () => {
  assert.equal(pageName('Lecture notes.pdf', 3, 'png'), 'Lecture notes — page 3.png');
  assert.equal(baseName('Lecture notes — page 3.png'), 'Lecture notes');
  assert.equal(
    mergedName([image('a', 0, 0, 1, 1, { text: 'Lecture notes — page 1.png' })]),
    'Lecture notes.pdf',
  );
  assert.equal(mergedName([image('a', 0, 0)]), 'Merged.pdf');
});

test('image formats and JPEG orientation are read from file bytes', async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  const plain = await sharp(png).jpeg().toBuffer();
  const turned = await sharp(png).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  assert.equal(imageKind(new Uint8Array(png)), 'png');
  assert.equal(imageKind(new Uint8Array(plain)), 'jpg');
  assert.equal(imageKind(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(jpegOrientation(new Uint8Array(plain)), 1);
  assert.equal(jpegOrientation(new Uint8Array(turned)), 6);
});
