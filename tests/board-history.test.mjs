import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');

const text = (value, extra = {}) => ({
  id: 'list',
  type: 'text',
  x: 0,
  y: 0,
  width: 300,
  height: 100,
  z: 1,
  text: value,
  color: '#29313b',
  fontSize: 24,
  ...extra,
});
function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'terra-history-test-'));
  let s = new Store(root);
  try {
    return fn(s, root, () => {
      s.close();
      s = new Store(root);
      return s;
    });
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('every create, edit and delete is kept with the version before it', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Strategic' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [text('1. One')] });
    s.patchBoard({ id: b.id, revision: 1, upserts: [text('1. One\n2. Two')] });
    s.patchBoard({ id: b.id, revision: 2, deleted: ['list'] });
    const { entries } = s.boardHistory({ id: b.id });
    assert.deepEqual(
      entries.map((e) => [e.action, e.revision]),
      [
        ['delete', 3],
        ['edit', 2],
        ['create', 1],
      ],
    );
    assert.equal(entries[0].before.text, '1. One\n2. Two');
    assert.equal(entries[0].after, null);
    assert.equal(entries[0].current, null);
    assert.equal(entries[1].before.text, '1. One');
    assert.equal(entries[1].after.text, '1. One\n2. Two');
    assert.equal(entries[2].before, null);
    assert.equal(entries[0].source, 'local');
  }));

test('a deleted object can be restored from its history entry', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Strategic' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [text('keep me')] });
    s.patchBoard({ id: b.id, revision: 1, deleted: ['list'] });
    const [deleted] = s.boardHistory({ id: b.id, deletedOnly: true }).entries;
    assert.equal(deleted.before.text, 'keep me');
    s.patchBoard({ id: b.id, revision: 2, upserts: [deleted.before] });
    assert.equal(s.loadBoard({ id: b.id }).objects[0].text, 'keep me');
    // Once it is back on the board it no longer counts as deleted.
    assert.equal(s.boardHistory({ id: b.id, deletedOnly: true }).entries.length, 0);
    assert.equal(s.boardHistory({ id: b.id }).entries[1].current.text, 'keep me');
  }));

test('saves that change nothing and camera moves leave no history', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Quiet' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [text('same')] });
    s.patchBoard({ id: b.id, revision: 1, upserts: [text('same')] });
    s.patchBoard({ id: b.id, revision: 2, camera: { x: 1, y: 2, zoom: 3 } });
    s.patchBoard({ id: b.id, revision: 2, deleted: ['never-existed'] });
    assert.equal(s.boardHistory({ id: b.id }).entries.length, 1);
  }));

test('history survives a restart, pages with a cursor and records who changed it', () =>
  withStore((s, root, reopen) => {
    const b = s.createBoard({ name: 'Paged' });
    for (let i = 0; i < 5; i++)
      s.patchBoard({
        id: b.id,
        revision: i,
        upserts: [text('v' + i)],
        source: i === 4 ? 'ai' : undefined,
      });
    s = reopen();
    const first = s.boardHistory({ id: b.id, limit: 2 });
    assert.equal(first.entries.length, 2);
    assert.equal(first.entries[0].source, 'ai');
    const second = s.boardHistory({ id: b.id, limit: 2, before: first.next });
    assert.deepEqual(
      second.entries.map((e) => e.after.text),
      ['v2', 'v1'],
    );
    const third = s.boardHistory({ id: b.id, limit: 2, before: second.next });
    assert.equal(third.entries.length, 1);
    assert.equal(third.next, null);
    // An unknown source is stored as a local edit.
    s.patchBoard({ id: b.id, revision: 5, upserts: [text('x')], source: 'evil' });
    assert.equal(s.boardHistory({ id: b.id, limit: 1 }).entries[0].source, 'local');
  }));

test('old history is pruned by age', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Old' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [text('old')] });
    s.pruneHistory(Date.now() + 31 * 86400000);
    assert.equal(s.boardHistory({ id: b.id }).entries.length, 0);
  }));

test('a removed board takes its history with it', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Gone' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [text('x')] });
    s.db.prepare('DELETE FROM boards WHERE id=?').run(b.id);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM object_history').get().n, 0);
  }));

test('the History panel names each change in plain words', async () => {
  const { editSummary, groupHistory, objectExcerpt, restorable } =
    await import('../src/canvas/board-history.ts');
  const a = text('1. One');
  assert.equal(editSummary(a, { ...a, text: '1. One\n2. Two' }), 'Text changed');
  assert.equal(editSummary(a, { ...a, x: 40, y: 10 }), 'Moved');
  assert.equal(editSummary(a, { ...a, width: 500 }), 'Resized');
  assert.equal(editSummary(a, { ...a, color: '#ff0000', x: 3 }), 'Moved, Restyled');
  assert.equal(editSummary({ ...a, type: 'frame' }, { ...a, type: 'frame', text: 'B' }), 'Renamed');
  assert.equal(editSummary(a, null), 'Edited');
  assert.equal(objectExcerpt(text('  many\n\nlines  ')), 'many lines');
  assert.equal(objectExcerpt(text('x'.repeat(300)), 20).length, 20);
  const entry = (seq, revision, action, source = 'local') => ({
    seq,
    revision,
    action,
    source,
    at: seq,
    objectId: 'o' + seq,
    before: action === 'create' ? null : a,
    after: null,
    current: null,
  });
  const groups = groupHistory([
    entry(5, 3, 'delete'),
    entry(4, 3, 'delete'),
    entry(3, 2, 'edit', 'ai'),
    entry(2, 1, 'create'),
  ]);
  assert.deepEqual(
    groups.map((g) => g.entries.length),
    [2, 1, 1],
  );
  assert.equal(restorable(entry(1, 1, 'create')), null);
  assert.equal(restorable(entry(1, 1, 'delete')).text, '1. One');
});
