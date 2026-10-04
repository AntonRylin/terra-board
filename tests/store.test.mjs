import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const note = (text = 'hello') => ({
  id: 'note-1',
  type: 'note',
  x: -120,
  y: 40,
  width: 220,
  height: 180,
  text,
  color: '#f8efd4',
  z: 0,
});
async function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'terra-board-test-'));
  let s = new Store(root);
  try {
    await fn(s, root);
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
}
test('acknowledged objects and Unicode names survive close and reopen', () =>
  withStore(async (s, root) => {
    const b = s.createBoard({ name: 'Идеи 日本' });
    s.patchBoard({
      id: b.id,
      revision: 0,
      upserts: [note()],
      deleted: [],
      camera: { x: 12, y: -9, zoom: 0.5 },
    });
    s.close();
    s = new Store(root);
    try {
      const d = s.loadBoard({ id: b.id });
      assert.equal(d.objects[0].text, 'hello');
      assert.equal(d.board.name, 'Идеи 日本');
      assert.equal(d.revision, 1);
      assert.equal(d.camera.zoom, 0.5);
    } finally {
      s.close();
    }
  }));
test('a stale revision is rejected without overwriting saved work', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Work' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [note('new')], deleted: [] });
    assert.throws(
      () => s.patchBoard({ id: b.id, revision: 0, upserts: [note('old')], deleted: [] }),
      /changed|revision/i,
    );
    assert.equal(s.loadBoard({ id: b.id }).objects[0].text, 'new');
  }));

test('independent stale edits merge but changed and deleted objects stay protected', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Concurrent' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [note(), { ...note(), id: 'other' }] });
    s.patchBoard({ id: b.id, revision: 1, upserts: [note('human')] });
    const ai = {
      id: b.id,
      revision: 1,
      upserts: [{ ...note('AI'), id: 'other' }],
      operationId: 'ai',
    };
    assert.equal(s.patchBoard(ai).revision, 3);
    assert.equal(s.patchBoard(ai).revision, 3);
    assert.deepEqual(
      s
        .loadBoard({ id: b.id })
        .objects.map((o) => o.text)
        .sort(),
      ['AI', 'human'],
    );
    assert.throws(
      () => s.patchBoard({ id: b.id, revision: 1, deleted: ['note-1'] }),
      /changed|conflict/i,
    );
    s.patchBoard({ id: b.id, revision: 3, deleted: ['other'] });
    assert.throws(
      () => s.patchBoard({ id: b.id, revision: 3, upserts: [{ ...note(), id: 'other' }] }),
      /changed|conflict/i,
    );
    assert.throws(() => s.patchBoard({ id: b.id, revision: 99, upserts: [] }), /revision/i);
  }));

test('camera-only saves leave content revision, object rows and modified time unchanged', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'View' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [note()] });
    const before = s.loadBoard({ id: b.id });
    s.patchBoard({ id: b.id, revision: 0, camera: { x: 80, y: -40, zoom: 2 } });
    const after = s.loadBoard({ id: b.id });
    assert.equal(after.revision, before.revision);
    assert.equal(after.board.updated, before.board.updated);
    assert.deepEqual(after.objects, before.objects);
    assert.deepEqual(after.camera, { x: 80, y: -40, zoom: 2 });
  }));

test('concurrent edits are atomic, retain conflict history across reopen and bound old history', () =>
  withStore((s, root) => {
    const b = s.createBoard({ name: 'History' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [note()] });
    s.patchBoard({ id: b.id, revision: 1, upserts: [note('new')] });
    const second = new Store(root);
    try {
      assert.throws(
        () =>
          second.patchBoard({
            id: b.id,
            revision: 1,
            upserts: [{ ...note(), id: 'must-not-appear' }],
            deleted: ['note-1'],
          }),
        /changed/i,
      );
      assert.equal(second.loadBoard({ id: b.id }).objects.length, 1);
      assert.equal(
        second.patchBoard({ id: b.id, revision: 1, upserts: [{ ...note(), id: 'independent' }] })
          .revision,
        3,
      );
      for (let revision = 3; revision < 505; revision++)
        second.patchBoard({ id: b.id, revision, deleted: ['deleted-' + revision] });
      assert.throws(
        () => second.patchBoard({ id: b.id, revision: 1, upserts: [{ ...note(), id: 'too-old' }] }),
        /too old/i,
      );
      assert.ok(
        second.db.prepare('SELECT count(*) AS n FROM object_revisions WHERE boardId=?').get(b.id)
          .n <= 500,
      );
      assert.equal(
        second.patchBoard({
          id: b.id,
          revision: 504,
          upserts: [{ ...note(), id: 'recent-independent' }],
        }).revision,
        506,
      );
    } finally {
      second.close();
    }
  }));

test('libraries without conflict history require a fresh read before merging', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Existing library' });
    s.patchBoard({ id: b.id, revision: 0, upserts: [note()] });
    s.db.exec('DELETE FROM object_revisions; DELETE FROM merge_floors;');
    assert.throws(
      () => s.patchBoard({ id: b.id, revision: 0, upserts: [{ ...note(), id: 'new' }] }),
      /too old/i,
    );
    s.patchBoard({ id: b.id, revision: 1, upserts: [{ ...note(), id: 'new' }] });
    assert.equal(s.patchBoard({ id: b.id, revision: 1, upserts: [note('safe')] }).revision, 3);
  }));
test('duplicates have independent documents and keep folder placement', () =>
  withStore((s) => {
    const f = s.createFolder({ name: 'Study' }),
      b = s.createBoard({ name: 'Work', folderId: f.id });
    s.patchBoard({ id: b.id, revision: 0, upserts: [note()], deleted: [] });
    const c = s.duplicateBoard({ id: b.id });
    assert.equal(c.folderId, f.id);
    s.patchBoard({ id: c.id, revision: 0, upserts: [note('changed copy')], deleted: [] });
    assert.equal(s.loadBoard({ id: b.id }).objects[0].text, 'hello');
  }));
test('trash and restore preserve content and original folder', () =>
  withStore((s) => {
    const f = s.createFolder({ name: 'Study' }),
      b = s.createBoard({ name: 'Work', folderId: f.id });
    s.updateBoard({ id: b.id, patch: { trashed: true } });
    assert.equal(s.library().boards.find((x) => x.id === b.id).trashed, true);
    s.restoreBoard({ id: b.id });
    assert.equal(s.loadBoard({ id: b.id }).board.folderId, f.id);
  }));
test('invalid objects roll back the complete edit', () =>
  withStore((s) => {
    const b = s.createBoard({ name: 'Work' });
    assert.throws(
      () =>
        s.patchBoard({
          id: b.id,
          revision: 0,
          upserts: [note(), { ...note(), id: 'bad', width: NaN }],
          deleted: [],
        }),
      /invalid/i,
    );
    assert.equal(s.loadBoard({ id: b.id }).objects.length, 0);
    assert.throws(
      () =>
        s.patchBoard({
          id: b.id,
          revision: 0,
          upserts: [{ ...note(), type: 'image', assetId: 'missing' }],
          deleted: [],
        }),
      /asset/i,
    );
  }));
test('folder removal dissolves the folder without deleting boards', () =>
  withStore((s) => {
    const f = s.createFolder({ name: 'Study' }),
      b = s.createBoard({ name: 'Work', folderId: f.id });
    s.removeFolder({ id: f.id });
    assert.equal(s.loadBoard({ id: b.id }).board.folderId, null);
  }));
test('portable export/import preserves image bytes and rejects malformed input', () =>
  withStore(async (s) => {
    const png = await require('sharp')({
      create: { width: 8, height: 8, channels: 3, background: '#547862' },
    })
      .png()
      .toBuffer();
    const asset = await s.importAsset({ bytes: png, name: 'pixel.png' });
    const b = s.createBoard({ name: 'Images' });
    s.patchBoard({
      id: b.id,
      revision: 0,
      upserts: [
        { ...note(), type: 'image', assetId: asset.id },
        {
          ...note(),
          id: 'compact-link',
          type: 'link',
          url: 'https://example.com',
          assetId: asset.id,
          linkCompact: true,
          linkPreviewHeight: 390,
          height: 112,
        },
      ],
      deleted: [],
    });
    const packed = await s.exportBoard({ id: b.id });
    const copy = await s.importBoard({ bytes: packed });
    assert.equal(s.loadBoard({ id: copy.id }).objects[0].assetId, asset.id);
    const link = s.loadBoard({ id: copy.id }).objects.find((o) => o.id === 'compact-link');
    assert.equal(link.linkCompact, true);
    assert.equal(link.linkPreviewHeight, 390);
    const { clipboardObjects } = await import('../src/canvas/content.ts');
    assert.deepEqual(clipboardObjects([link])[0], link);
    assert.throws(() => clipboardObjects([{ ...link, linkCompact: 'yes' }]), /appearance/);
    assert.throws(
      () =>
        s.patchBoard({
          id: b.id,
          revision: 1,
          upserts: [{ ...link, linkPreviewHeight: -1 }],
          deleted: [],
        }),
      /preview height/,
    );
    assert.deepEqual(readFileSync(s.asset({ id: asset.id, variant: 'original' }).file), png);
    assert.throws(
      () =>
        s.patchBoard({
          id: b.id,
          revision: 1,
          upserts: [{ ...note(), url: 'javascript:alert(1)', type: 'link' }],
          deleted: [],
        }),
      /url/i,
    );
    await assert.rejects(s.importBoard({ bytes: Buffer.from('not a board') }));
  }));
