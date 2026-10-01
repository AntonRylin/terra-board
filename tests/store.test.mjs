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
  const root = mkdtempSync(join(tmpdir(), 'local-canvas-test-'));
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
      upserts: [{ ...note(), type: 'image', assetId: asset.id }],
      deleted: [],
    });
    const packed = await s.exportBoard({ id: b.id });
    const copy = await s.importBoard({ bytes: packed });
    assert.equal(s.loadBoard({ id: copy.id }).objects[0].assetId, asset.id);
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
