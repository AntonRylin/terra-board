import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const sharp = require('sharp');
const note = (id, text = 'hello') => ({
  id,
  type: 'note',
  x: 0,
  y: 0,
  width: 220,
  height: 180,
  text,
  color: '#f8efd4',
  z: 0,
});
const picture = (background) =>
  sharp({ create: { width: 16, height: 12, channels: 3, background } })
    .png()
    .toBuffer();
async function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'terra-board-info-'));
  const s = new Store(root);
  try {
    await fn(s, root);
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const onDisk = (root, id) =>
  ['original', 'preview', 'thumb'].reduce((n, variant) => {
    try {
      return n + statSync(join(root, 'assets', `${id}.${variant}`)).size;
    } catch {
      return n;
    }
  }, 0);

test('boardInfo counts objects, their text and the pictures they use', () =>
  withStore(async (s, root) => {
    const before = Date.now();
    const b = s.createBoard({ name: 'Trip' });
    const asset = await s.importAsset({ bytes: await picture('#547862'), name: 'pixel.png' });
    const unused = await s.importAsset({ bytes: await picture('#a03030'), name: 'other.png' });
    const objects = [
      note('a'),
      note('b', 'Привет'),
      { ...note('img'), type: 'image', assetId: asset.id },
      { ...note('again'), type: 'image', assetId: asset.id },
    ];
    s.patchBoard({ id: b.id, revision: 0, upserts: objects, deleted: [] });
    const info = s.boardInfo({ id: b.id });
    const stored = s.loadBoard({ id: b.id }).objects;
    assert.equal(info.objects, 4);
    assert.equal(
      info.contentBytes,
      stored.reduce((n, o) => n + Buffer.byteLength(JSON.stringify(o)), 0),
    );
    assert.equal(info.files, 1, 'one picture, used twice; the unused one is not counted');
    assert.ok(onDisk(root, asset.id) > 0);
    assert.equal(info.fileBytes, onDisk(root, asset.id));
    assert.ok(unused.id !== asset.id);
    assert.equal(info.linkedFiles, 0);
    assert.ok(info.created >= before && info.created <= Date.now());
    assert.ok(info.updated >= info.created);
  }));

test('boardInfo counts board icons and backgrounds, and linked pictures apart', () =>
  withStore(async (s, root) => {
    const b = s.createBoard({ name: 'Linked' });
    const icon = await s.importAsset({ bytes: await picture('#3050a0'), name: 'icon.png' });
    const file = join(root, 'outside.png');
    writeFileSync(file, await picture('#20a050'));
    const linked = await s.importAsset({
      bytes: await picture('#20a050'),
      name: 'outside.png',
      link: { file },
    });
    s.updateBoard({ id: b.id, patch: { icon: 'asset-' + icon.id } });
    s.patchBoard({
      id: b.id,
      revision: 0,
      upserts: [{ ...note('img'), type: 'image', assetId: linked.id }],
      deleted: [],
    });
    const info = s.boardInfo({ id: b.id });
    assert.equal(info.files, 1);
    assert.equal(info.linkedFiles, 1);
    // A linked original stays outside the library; its preview and thumbnail count.
    assert.equal(info.fileBytes, onDisk(root, icon.id) + onDisk(root, linked.id));
  }));

test('boards from before creation times were kept show none, and copies get their own', () =>
  withStore(async (s) => {
    const b = s.createBoard({ name: 'Old' });
    s.db.prepare('UPDATE boards SET created=NULL WHERE id=?').run(b.id);
    assert.equal(s.boardInfo({ id: b.id }).created, null);
    const copy = s.duplicateBoard({ id: b.id });
    assert.equal(typeof s.boardInfo({ id: copy.id }).created, 'number');
    const empty = s.boardInfo({ id: b.id });
    assert.equal(empty.objects, 0);
    assert.equal(empty.contentBytes, 0);
    assert.equal(empty.files, 0);
    assert.equal(empty.fileBytes, 0);
    assert.throws(() => s.boardInfo({ id: 'missing' }), /not found/);
  }));
