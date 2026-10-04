import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
const { Store } = createRequire(import.meta.url)('../electron/store.cjs');
const object = (id, patch = {}) => ({
  id,
  type: 'note',
  x: 12000,
  y: -7000,
  width: 240,
  height: 180,
  z: 0,
  ...patch,
});
async function withStore(run) {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/search-'));
  const store = new Store(root);
  try {
    await run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
test('search finds visible text fields across boards and folders, without matching object metadata', () =>
  withStore(async (s) => {
    const folder = s.createFolder({ name: 'Projects' });
    const board = s.createBoard({ name: 'Unrelated name', folderId: folder.id });
    const other = s.createBoard({ name: 'Second' });
    const asset = await s.importAsset({
      name: 'reference.png',
      bytes: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
        .png()
        .toBuffer(),
    });
    const items = [
      object('note', { text: 'A NEBULA\nlaunch plan' }),
      object('text', { type: 'text', text: 'Nebula research' }),
      object('frame', { type: 'frame', text: 'Nebula references' }),
      object('image', { type: 'image', assetId: asset.id, imageTitle: 'Nebula photograph' }),
      object('link', {
        type: 'link',
        text: 'Website',
        url: 'https://example.com/nebula',
        linkDescription: 'Nebula details',
      }),
      object('nebula-only-id', { text: 'Unrelated' }),
    ];
    s.patchBoard({ id: board.id, revision: 0, upserts: items });
    s.patchBoard({
      id: other.id,
      revision: 0,
      upserts: [object('unicode', { text: 'ПРИВЕТ — Österreich' })],
    });
    const before = s.loadBoard({ id: board.id });
    const found = s.searchContent({ query: ' nebula ' });
    assert.deepEqual(found.results.map((r) => r.objectId).sort(), [
      'frame',
      'image',
      'link',
      'note',
      'text',
    ]);
    assert.ok(found.results.every((r) => r.boardId === board.id && /nebula/i.test(r.excerpt)));
    assert.equal(s.searchContent({ query: 'nebula launch' }).results[0].objectId, 'note');
    assert.equal(s.searchContent({ query: 'привет' }).results[0].boardId, other.id);
    assert.equal(s.searchContent({ query: 'öSTERREICH' }).results[0].objectId, 'unicode');
    assert.equal(s.searchContent({ query: '12000' }).results.length, 0);
    assert.deepEqual(
      s.loadBoard({ id: board.id }),
      before,
      'search never modifies content or camera',
    );
  }));
test('content search immediately follows saves, deletions, trash, and restore', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Notes' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [object('one', { text: 'first wording' })] });
    s.patchBoard({ id: b.id, revision: 1, upserts: [object('one', { text: 'second wording' })] });
    assert.equal(s.searchContent({ query: 'first' }).results.length, 0);
    assert.equal(s.searchContent({ query: 'second' }).results.length, 1);
    s.updateBoard({ id: b.id, patch: { trashed: true } });
    assert.equal(s.searchContent({ query: 'second' }).results.length, 0);
    s.restoreBoard({ id: b.id });
    assert.equal(s.searchContent({ query: 'second' }).results.length, 1);
    s.patchBoard({ id: b.id, revision: 2, deleted: ['one'] });
    assert.equal(s.searchContent({ query: 'second' }).results.length, 0);
  }));
test('search treats punctuation literally and bounds results and matching excerpts', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Large board' });
    s.patchBoard({
      id: b.id,
      revision: 0,
      upserts: Array.from({ length: 65 }, (_, i) =>
        object(`item-${i}`, { text: 'context '.repeat(500) + "50%_ 'match' tail" }),
      ),
    });
    const found = s.searchContent({ query: "50%_ 'match'" });
    assert.equal(found.results.length, 60);
    assert.equal(found.hasMore, true);
    assert.ok(
      found.results.every((r) => r.excerpt.includes("50%_ 'match'") && r.excerpt.length <= 262),
    );
    assert.equal(s.searchContent({ query: 'absent' }).hasMore, false);
    assert.deepEqual(s.searchContent({ query: '   ' }), { results: [], hasMore: false });
    assert.throws(() => s.searchContent({ query: 42 }), /query/i);
    assert.throws(() => s.searchContent({ query: 'x'.repeat(201) }), /query/i);
  }));
