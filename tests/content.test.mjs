import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardObjects, previewText, pastedUrl } from '../src/canvas/content.ts';
const base = { id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 100, z: 0, text: 'hi' };

test('invalid and oversized pasted links stay plain text instead of poisoning the save queue', () => {
  assert.equal(pastedUrl('https://example.com'), 'https://example.com/');
  assert.equal(pastedUrl('https://?'), null);
  assert.equal(pastedUrl('https://example.com/' + 'x'.repeat(8192)), null);
  assert.equal(pastedUrl('https://example.com/' + '🌻'.repeat(2000)), null);
  assert.equal(pastedUrl('javascript:alert(1)'), null);
});
test('clipboard rejects invalid geometry, executable links and foreign object types', () => {
  for (const value of [
    [{ ...base, width: Infinity }],
    [{ ...base, type: 'script' }],
    [{ ...base, type: 'link', url: 'javascript:alert(1)' }],
    [{ ...base, type: 'image', assetId: '../../secret' }],
  ])
    assert.throws(() => clipboardObjects(value), /invalid|unsupported/i);
  assert.deepEqual(clipboardObjects([base]), [base]);
});
test('text preview is bounded before rasterization, including huge explicit line counts', () => {
  const text = previewText(('W'.repeat(5000) + '\n').repeat(100), 200, 1000000, 300);
  assert.ok(text.length < 300);
  assert.ok(text.split('\n').length < 10);
  assert.equal(previewText('Hello\nworld', 400, 200, 20), 'Hello\nworld');
});
