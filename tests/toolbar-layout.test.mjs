import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultToolbarLayout,
  phoneToolbarLayout,
  readToolbarLayout,
  moveToolbarTool,
  toolbarIds,
} from '../src/components/toolbar-layout.ts';

test('tools can move both ways and reorder without duplicates or loss', () => {
  const initial = defaultToolbarLayout();
  let layout = moveToolbarTool(initial, 'gallery', 'bar', 2);
  assert.equal(layout.bar[2], 'gallery');
  assert.ok(!layout.inventory.includes('gallery'));
  layout = moveToolbarTool(layout, 'gallery', 'bar', 0);
  assert.equal(layout.bar[0], 'gallery');
  layout = moveToolbarTool(layout, 'select', 'inventory', 0);
  assert.equal(layout.inventory[0], 'select');
  assert.deepEqual([...layout.bar, ...layout.inventory].sort(), [...toolbarIds].sort());
  assert.deepEqual(initial, defaultToolbarLayout());
  assert.deepEqual(readToolbarLayout(JSON.parse(JSON.stringify(layout))), layout);
});

test('the pen joins a saved toolbar beside the highlighter', () => {
  const saved = { bar: ['select', 'highlight', 'frame'], inventory: ['note'] };
  const layout = readToolbarLayout(saved);
  assert.deepEqual(layout.bar, ['select', 'pen', 'highlight', 'frame']);
  assert.ok(defaultToolbarLayout().bar.includes('pen'));
  // Someone who put the pen away keeps it away.
  const away = readToolbarLayout({ bar: ['highlight'], inventory: ['pen'] });
  assert.deepEqual(away.bar, ['highlight']);
  assert.equal(away.inventory[0], 'pen');
});

test('preferences recover missing tools, ignore unknown tools and allow an empty bar', () => {
  const layout = readToolbarLayout({ bar: [], inventory: ['list', 'list', 'old-tool', null] });
  assert.deepEqual(layout.bar, []);
  assert.equal(layout.inventory[0], 'list');
  assert.deepEqual([...layout.inventory].sort(), [...toolbarIds].sort());
  assert.deepEqual(readToolbarLayout(null), defaultToolbarLayout());
  assert.deepEqual(readToolbarLayout({ bar: 'broken' }), defaultToolbarLayout());
});

test('the phone layout shows five tools and keeps every other tool under +', () => {
  const phone = phoneToolbarLayout();
  assert.equal(phone.bar.length, 5);
  assert.deepEqual(readToolbarLayout(phone), phone, 'a saved phone layout reads back unchanged');
  assert.equal(
    new Set([...phone.bar, ...phone.inventory]).size,
    phone.bar.length + phone.inventory.length,
  );
  assert.equal(
    phone.bar.length + phone.inventory.length,
    defaultToolbarLayout().bar.length + defaultToolbarLayout().inventory.length,
  );
});
