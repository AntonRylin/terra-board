import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listBreak } from '../src/canvas/text-lists.ts';

const enter = (text, at = text.length, end = at) => {
  const result = listBreak(text, at, end);
  return result && { text: result.text, caret: result.caret };
};

test('Enter after a numbered item starts the next number', () => {
  assert.deepEqual(enter('1. eggs\n2. milk'), { text: '1. eggs\n2. milk\n3. ', caret: 19 });
  assert.deepEqual(enter('9) a'), { text: '9) a\n10) ', caret: 9 });
  assert.deepEqual(enter('  4.  deep'), { text: '  4.  deep\n  5.  ', caret: 17 });
});

test('bullets continue with the same symbol', () => {
  assert.deepEqual(enter('- a'), { text: '- a\n- ', caret: 6 });
  assert.deepEqual(enter('• a'), { text: '• a\n• ', caret: 6 });
  assert.deepEqual(enter('* a'), { text: '* a\n* ', caret: 6 });
});

test('Enter on an empty item ends the list', () => {
  assert.deepEqual(enter('1. a\n2. '), { text: '1. a\n', caret: 5 });
  assert.deepEqual(enter('- a\n-  '), { text: '- a\n', caret: 4 });
});

test('splitting an item carries the rest to the new number', () => {
  assert.deepEqual(enter('1. eggs milk', 7), { text: '1. eggs\n2.  milk', caret: 11 });
});

test('items below are renumbered, nested ones left alone', () => {
  assert.deepEqual(enter('1. a\n2. b\n  1. x\n3. c\n\n5. z', 4).text, '1. a\n2. \n3. b\n  1. x\n4. c\n\n5. z');
  assert.deepEqual(enter('1. a\n2. b\n9. c', 9).text, '1. a\n2. b\n3. \n9. c');
});

test('plain text and numbers without a list marker are left alone', () => {
  assert.equal(enter('hello'), null);
  assert.equal(enter('3.14 is pi'), null);
  assert.equal(enter('1.no space'), null);
  assert.equal(enter('2. item', 1), null); // caret inside the marker
  assert.equal(enter('1. a\n2. b', 2, 8), null); // selection spans lines
});
