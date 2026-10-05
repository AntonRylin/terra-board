import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readHiddenSelectionTools,
  toggleSelectionTool,
  readSelectionToolbarLayout,
} from '../src/components/selection-toolbar-layout.ts';
import { moveVisibleToolbarTool } from '../src/components/toolbar-layout.ts';

test('lock can move into more tools and its position survives reload', () => {
  const initial = readSelectionToolbarLayout(null);
  assert.ok(initial.bar.includes('lock'));
  const moved = moveVisibleToolbarTool(initial, 'lock', 'inventory', 0, ['lock', 'bold']);
  assert.deepEqual(moved.inventory, ['lock']);
  assert.ok(!moved.bar.includes('lock'));
  assert.deepEqual(readSelectionToolbarLayout(JSON.parse(JSON.stringify(moved))), moved);
});

test('ordered layouts migrate hidden controls and survive switching object types', () => {
  let layout = readSelectionToolbarLayout(null, ['bold', 'colors']);
  assert.deepEqual(layout.inventory, ['bold', 'colors']);
  const available = ['colors', 'bold', 'strikethrough', 'duplicate', 'delete'];
  layout = moveVisibleToolbarTool(layout, 'bold', 'bar', 0, available);
  assert.equal(layout.bar.filter((id) => available.includes(id))[0], 'bold');
  layout = moveVisibleToolbarTool(layout, 'strikethrough', 'inventory', 0, available);
  assert.deepEqual(layout.inventory, ['strikethrough', 'colors']);
  assert.ok(layout.bar.includes('preview-document'), 'unavailable controls keep their layout');
  assert.deepEqual(readSelectionToolbarLayout(JSON.parse(JSON.stringify(layout))), layout);
});

test('visible reordering keeps dormant controls and repairs incomplete saved layouts', () => {
  const base = { bar: ['bold', 'preview-document', 'duplicate', 'delete'], inventory: ['colors'] };
  const moved = moveVisibleToolbarTool(base, 'delete', 'bar', 0, [
    'bold',
    'duplicate',
    'delete',
    'colors',
  ]);
  assert.deepEqual(moved.bar, ['delete', 'bold', 'preview-document', 'duplicate']);
  const atEnd = moveVisibleToolbarTool(moved, 'bold', 'bar', 2, [
    'bold',
    'duplicate',
    'delete',
    'colors',
  ]);
  assert.deepEqual(
    atEnd.bar.filter((id) => id !== 'preview-document'),
    ['delete', 'duplicate', 'bold'],
  );
  const repaired = readSelectionToolbarLayout({ bar: [], inventory: ['bold', 'bold', 'obsolete'] });
  assert.ok(!repaired.bar.includes('bold'));
  assert.deepEqual(repaired.inventory, ['bold']);
  assert.ok(repaired.bar.includes('duplicate'), 'new controls stay accessible');
});

test('hidden object controls survive reload and context changes without affecting other choices', () => {
  let hidden = toggleSelectionTool([], 'bold');
  hidden = toggleSelectionTool(hidden, 'preview-document');
  hidden = readHiddenSelectionTools(JSON.parse(JSON.stringify(hidden)));
  assert.deepEqual(hidden, ['bold', 'preview-document']);
  assert.deepEqual(toggleSelectionTool(hidden, 'bold'), ['preview-document']);
  assert.deepEqual(hidden, ['bold', 'preview-document']);
});

test('invalid preferences recover safely, preserve valid hidden controls and remove duplicates', () => {
  assert.deepEqual(readHiddenSelectionTools(null), []);
  assert.deepEqual(readHiddenSelectionTools({ hidden: 'bold' }), []);
  assert.deepEqual(readHiddenSelectionTools(['bold', 'bold', null, 'removed-control', 'colors']), [
    'bold',
    'colors',
  ]);
});
