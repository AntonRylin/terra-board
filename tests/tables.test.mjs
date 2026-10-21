import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { clipboardObjects } from '../src/canvas/content.ts';
import { resizeObject } from '../src/canvas/resize.ts';
import {
  cellValue,
  fitTableHeight,
  starterTable,
  tableLayoutWidth,
  tableScale,
  tableText,
  tableValue,
  withTable,
} from '../src/canvas/table.ts';
const { Store, objectValue, tableValue: storeTableValue } = createRequire(import.meta.url)(
  '../electron/store.cjs',
);

const columns = [
  { id: 'name', name: 'Name', type: 'text', width: 200 },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    width: 140,
    options: [
      { id: 'todo', name: 'To do', color: 'gray' },
      { id: 'done', name: 'Done', color: 'green' },
    ],
  },
  { id: 'hours', name: 'Hours', type: 'number', width: 110 },
  { id: 'ok', name: 'OK', type: 'checkbox', width: 80 },
  { id: 'due', name: 'Due', type: 'date', width: 140 },
  { id: 'progress', name: 'Progress', type: 'progress', width: 150 },
];
const table = {
  columns,
  rows: [
    {
      id: 'r1',
      cells: { name: 'Add hangar', status: 'done', hours: 3.5, ok: true, due: '2026-11-02', progress: 40 },
    },
    { id: 'r2', cells: {} },
  ],
};
const object = {
  id: 'table',
  type: 'table',
  x: 10,
  y: 20,
  width: tableLayoutWidth(columns),
  height: 300,
  z: 1,
  text: 'Game tasks',
  table,
};

test('tables survive saving, search, clipboard, reopen and export', async () => {
  const root = mkdtempSync(join(tmpdir(), 'terra-tables-'));
  let source = new Store(join(root, 'source'));
  const target = new Store(join(root, 'target'));
  try {
    const board = source.createBoard({ name: 'Tables' });
    source.patchBoard({ id: board.id, revision: 0, upserts: [object], deleted: [] });
    assert.equal(source.searchContent({ query: 'hangar' }).results[0].objectId, object.id);
    assert.equal(source.searchContent({ query: 'Progress' }).results[0].objectId, object.id);
    // Option ids are not searchable text.
    assert.equal(source.searchContent({ query: 'todo' }).results.length, 0);
    assert.deepEqual(clipboardObjects([object])[0], objectValue(object));
    source.close();
    source = new Store(join(root, 'source'));
    assert.deepEqual(source.loadBoard({ id: board.id }).objects[0], object);
    const imported = await target.importBoard({ bytes: await source.exportBoard({ id: board.id }) });
    assert.deepEqual(target.loadBoard({ id: imported.id }).objects[0].table, table);
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('table validation drops cells that do not fit and rejects broken structure', () => {
  const messy = {
    columns: [
      ...columns.slice(0, 5).map((c, i) => (i === 0 ? { ...c, width: 5 } : c)),
      { ...columns[5], extra: 1 },
    ],
    rows: [
      {
        id: 'r1',
        cells: {
          name: 12,
          status: 'Done',
          hours: 'many',
          ok: 'yes',
          due: '2026-13-45',
          progress: 140,
          unknown: 'x',
        },
      },
    ],
  };
  const expected = {
    columns: [{ ...columns[0], width: 60 }, ...columns.slice(1)],
    rows: [{ id: 'r1', cells: { name: '12', status: 'done', progress: 100 } }],
  };
  assert.deepEqual(tableValue(messy), expected);
  assert.deepEqual(storeTableValue(messy), expected);
  for (const broken of [
    null,
    { columns: [], rows: [] },
    { columns: [{ id: 'a', type: 'formula' }], rows: [] },
    { columns: [columns[0], columns[0]], rows: [] },
    { columns, rows: [{ id: 'r' }, { id: 'r' }] },
    { columns, rows: [{ id: 'bad id' }] },
  ]) {
    assert.throws(() => tableValue(broken), /table/i);
    assert.throws(() => storeTableValue(broken), /table/i);
    assert.throws(() => objectValue({ ...object, table: broken }), /table/i);
  }
  assert.throws(() => objectValue({ ...object, type: 'note', table }), /table/i);
});

test('the app and the store validate tables the same way', () => {
  const starter = starterTable(
    (
      (n) => () =>
        `id-${n++}`
    )(0),
  );
  assert.deepEqual(storeTableValue(starter), tableValue(starter));
  assert.deepEqual(storeTableValue(table), tableValue(table));
});

test('changing columns keeps the scale; resizing scales the whole table', () => {
  const scaled = { ...object, width: object.width * 2, height: 600 };
  assert.equal(tableScale(scaled), 2);
  const wider = withTable(scaled, {
    ...table,
    columns: [...columns, { id: 'notes', name: 'Notes', type: 'text', width: 200 }],
  });
  assert.equal(tableScale(wider), 2);
  assert.equal(wider.x, scaled.x);
  const fitted = fitTableHeight(wider, 150);
  assert.equal(fitted.height, 300);
  assert.equal(fitTableHeight(fitted, 150), null);
  const resized = resizeObject(object, 'e', object.width, 0, false);
  assert.ok(Math.abs(tableScale(resized) - 2) < 1e-9);
  assert.ok(Math.abs(resized.height - object.height * 2) < 1e-9);
});

test('cells convert when a column changes type, and search text reads like the table', () => {
  assert.equal(cellValue({ type: 'number' }, '1,5'), 1.5);
  assert.equal(cellValue({ type: 'progress' }, '35%'), 35);
  assert.equal(cellValue({ type: 'text' }, 7), '7');
  assert.equal(cellValue(columns[1], 'to do'), 'todo');
  assert.equal(cellValue(columns[1], 'Later'), undefined);
  assert.match(tableText(table), /Add hangar.*Done/);
});
