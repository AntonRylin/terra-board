import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStyle,
  commonStyle,
  rebaseMarks,
  sanitizeMarks,
  spoilerRegions,
  styleRuns,
} from '../src/canvas/rich-text.ts';

test('styles split, merge and toggle across ranges', () => {
  let marks = applyStyle(11, [], 0, 5, { bold: true });
  marks = applyStyle(11, marks, 3, 8, { bold: true, color: '#e5484d' });
  assert.deepEqual(marks, [
    { start: 0, end: 3, bold: true },
    { start: 3, end: 8, bold: true, color: '#e5484d' },
  ]);
  assert.deepEqual(commonStyle(11, marks, 1, 6), { bold: true });
  assert.deepEqual(commonStyle(11, marks, 1, 9), {});
  marks = applyStyle(11, marks, 0, 11, { bold: null, color: null });
  assert.deepEqual(marks, []);
});

test('edits move ranges and typed text inherits the style before the caret', () => {
  const marks = [{ start: 6, end: 11, bold: true }];
  // Typing at the end of a bold word continues it.
  assert.deepEqual(rebaseMarks('Hello world', 'Hello worlds', marks, null, 12), [
    { start: 6, end: 12, bold: true },
  ]);
  // Typing before it shifts it.
  assert.deepEqual(rebaseMarks('Hello world', 'Oh Hello world', marks, null, 3), [
    { start: 9, end: 14, bold: true },
  ]);
  // Deleting into it shrinks it; replacing styled text keeps the style.
  assert.deepEqual(rebaseMarks('Hello world', 'Hello wd', marks, null, 7), [
    { start: 6, end: 8, bold: true },
  ]);
  assert.deepEqual(rebaseMarks('Hello world', 'Hello X', marks, null, 7), [
    { start: 6, end: 7, bold: true },
  ]);
  // A pending style applies to new text only.
  assert.deepEqual(rebaseMarks('ab', 'abc', [], { italic: true }, 3), [
    { start: 2, end: 3, italic: true },
  ]);
  // Repeated letters: the caret decides where the insertion happened.
  assert.deepEqual(rebaseMarks('aa', 'aaa', [{ start: 1, end: 2, bold: true }], null, 1), [
    { start: 2, end: 3, bold: true },
  ]);
});

test('untrusted marks are clamped and cleaned, and spoilers group', () => {
  assert.deepEqual(
    sanitizeMarks(
      [
        { start: 0, end: 99, spoiler: true, evil: 'x', color: 'red' },
        { start: -1, end: 2, bold: true },
        'nope',
      ],
      4,
    ),
    [{ start: 0, end: 4, spoiler: true }],
  );
  assert.equal(sanitizeMarks([{ start: 0, end: 2 }], 4), undefined);
  const runs = styleRuns(10, [
    { start: 1, end: 3, spoiler: true },
    { start: 3, end: 5, spoiler: true, bold: true },
    { start: 7, end: 9, spoiler: true },
  ]);
  assert.deepEqual(spoilerRegions(runs), [
    { start: 1, end: 5 },
    { start: 7, end: 9 },
  ]);
});

test('formatting survives storage and clipboard validation, malformed ranges are dropped', async () => {
  const { createRequire } = await import('node:module');
  const { objectValue } = createRequire(import.meta.url)('../electron/store.cjs');
  const { clipboardObjects } = await import('../src/canvas/content.ts');
  const list = {
    id: 'list',
    type: 'list',
    x: 0,
    y: 0,
    width: 320,
    height: 190,
    z: 1,
    text: 'Plan',
    textMarks: [{ start: 0, end: 4, font: 'hand', highlight: '#ffd43b' }],
    listScale: 1,
    items: [
      {
        id: 'a',
        text: 'Secret ending',
        checked: false,
        marks: [
          { start: 0, end: 6, bold: true, color: '#e5484d' },
          { start: 7, end: 13, spoiler: true, size: 1.25 },
          { start: 9, end: 99, italic: true, script: 'x' },
        ],
      },
      { id: 'b', text: 'Plain', checked: true },
    ],
  };
  const expectedItems = [
    {
      id: 'a',
      text: 'Secret ending',
      checked: false,
      marks: [
        { start: 0, end: 6, bold: true, color: '#e5484d' },
        { start: 7, end: 13, spoiler: true, size: 1.25 },
      ],
    },
    { id: 'b', text: 'Plain', checked: true },
  ];
  for (const value of [objectValue(list), clipboardObjects([list])[0]]) {
    assert.deepEqual(value.items, expectedItems);
    assert.deepEqual(value.textMarks, [{ start: 0, end: 4, highlight: '#ffd43b', font: 'hand' }]);
  }
});
