import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultToolbarLayout,
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

test('preferences recover missing tools, ignore unknown tools and allow an empty bar', () => {
  const layout = readToolbarLayout({ bar: [], inventory: ['list', 'list', 'old-tool', null] });
  assert.deepEqual(layout.bar, []);
  assert.equal(layout.inventory[0], 'list');
  assert.deepEqual([...layout.inventory].sort(), [...toolbarIds].sort());
  assert.deepEqual(readToolbarLayout(null), defaultToolbarLayout());
  assert.deepEqual(readToolbarLayout({ bar: 'broken' }), defaultToolbarLayout());
});
