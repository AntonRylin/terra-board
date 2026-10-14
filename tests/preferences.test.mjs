import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences, readPreferences } from '../src/settings/preferences.ts';
import { defaultRadialLayout } from '../src/components/radial-layout.ts';

test('missing or corrupt preferences fall back to defaults field by field', () => {
  assert.deepEqual(readPreferences(null), defaultPreferences());
  assert.deepEqual(readPreferences('nonsense'), defaultPreferences());
  const read = readPreferences({
    openLastBoard: false,
    confirmTrash: 'yes',
    wheel: 'pan',
    zoomSpeed: 'ludicrous',
    snapping: false,
  });
  assert.equal(read.openLastBoard, false);
  assert.equal(read.confirmTrash, false);
  assert.equal(read.wheel, 'pan');
  assert.equal(read.zoomSpeed, 'normal');
  assert.equal(read.snapping, false);
});

test('the old radial layout migrates when no new layout is stored', () => {
  const legacy = ['select', 'text', 'note', 'rect', 'frame', 'highlight', 'arrow'];
  assert.deepEqual(readPreferences(null, legacy).radial, legacy);
  const stored = defaultRadialLayout().reverse();
  assert.deepEqual(readPreferences({ radial: stored }, legacy).radial, stored);
  assert.deepEqual(readPreferences({ radial: ['bogus'] }).radial, defaultRadialLayout());
});

test('shortcut overrides are validated on read', () => {
  const read = readPreferences({
    shortcuts: { 'tool.text': [{ code: 'KeyQ' }], nope: [{ code: 'KeyP' }] },
  });
  assert.deepEqual(read.shortcuts, { 'tool.text': [{ code: 'KeyQ' }] });
});
