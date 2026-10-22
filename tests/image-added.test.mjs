import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { addedNow, addedValue, stampAdded } from '../src/canvas/image-added.ts';
import { clipboardObjects } from '../src/canvas/content.ts';
import { makeAlbum, releaseAlbum, addToAlbum } from '../src/canvas/album.ts';
import { readPreferences } from '../src/settings/preferences.ts';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');

const at = Date.UTC(2026, 9, 22, 14, 5, 32);
const image = (id, added) => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  z: 1,
  assetId: 'a'.repeat(64),
  text: 'photo.png',
  ...(added ? { added } : {}),
});

test('added records keep a time and a profile name only when there is one', () => {
  assert.deepEqual(addedNow('Anton', at), { at, by: 'Anton' });
  assert.deepEqual(addedNow('', at), { at });
  assert.deepEqual(addedNow(null, at), { at });
  assert.deepEqual(addedValue({ at, by: '  ' }), { at });
  for (const bad of [null, 'x', { at: 'now' }, { at: -1 }, { at: Infinity }])
    assert.equal(addedValue(bad), undefined);
});

test('new images get a fresh record; other objects and turned-off recording stay clean', () => {
  const note = { id: 'n', type: 'note', x: 0, y: 0, width: 10, height: 10, z: 0 };
  const old = image('i', { at: 1, by: 'Someone' });
  const [stamped, untouched] = stampAdded([old, note], { at, by: 'Anton' });
  assert.deepEqual(stamped.added, { at, by: 'Anton' });
  assert.equal(untouched, note);
  const [off] = stampAdded([old], null);
  assert.equal('added' in off, false);
});

test('recording is on by default and survives a bad saved value', () => {
  assert.equal(readPreferences({}).recordImageDetails, true);
  assert.equal(readPreferences({ recordImageDetails: false }).recordImageDetails, false);
  assert.equal(readPreferences({ recordImageDetails: 'no' }).recordImageDetails, true);
});

test('albums keep each image’s record and give it back on release', () => {
  const made = makeAlbum([image('a', { at, by: 'Anton' }), image('b', { at: at + 1 })]);
  const album = made.upserts.find((o) => o.id === made.id);
  assert.deepEqual(
    album.album.images.map((i) => i.added),
    [{ at, by: 'Anton' }, { at: at + 1 }],
  );
  const grown = addToAlbum(
    album,
    [{ id: 'b'.repeat(64), name: 'new.png', mime: 'image/png', width: 10, height: 10, bytes: 1 }],
    { at: at + 2 },
  );
  assert.deepEqual(grown.album.images.at(-1).added, { at: at + 2 });
  const released = releaseAlbum(grown).upserts;
  assert.deepEqual(
    released.map((o) => o.added),
    [{ at, by: 'Anton' }, { at: at + 1 }, { at: at + 2 }],
  );
});

test('the record survives clipboard, save/reopen and export; invalid ones are refused', async () => {
  const added = { at, by: 'Anton' };
  assert.deepEqual(clipboardObjects([image('c', added)])[0].added, added);
  assert.equal('added' in clipboardObjects([image('c', { at: 'x' })])[0], false);
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/image-added-'));
  let store = new Store(root);
  try {
    const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#4488cc' } })
      .png()
      .toBuffer();
    const asset = await store.importAsset({ name: 'photo.png', bytes: png });
    const saved = { ...image('saved', added), assetId: asset.id };
    const board = store.createBoard({ name: 'Image details' });
    store.patchBoard({ id: board.id, revision: 0, upserts: [saved], deleted: [] });
    store.close();
    store = new Store(root);
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0].added, added);
    const copy = await store.importBoard({ bytes: await store.exportBoard({ id: board.id }) });
    assert.deepEqual(store.loadBoard({ id: copy.id }).objects[0].added, added);
    const info = store.assetInfo({ id: asset.id });
    assert.deepEqual(
      { name: info.name, mime: info.mime, width: info.width, height: info.height },
      { name: 'photo.png', mime: 'image/png', width: 8, height: 6 },
    );
    for (const bad of [{ at: 'now' }, { at, by: 5 }, { at, by: 'x'.repeat(201) }])
      assert.throws(
        () =>
          store.patchBoard({
            id: board.id,
            revision: 1,
            upserts: [{ ...saved, added: bad }],
            deleted: [],
          }),
        /image details/,
      );
    assert.throws(
      () =>
        store.patchBoard({
          id: board.id,
          revision: 1,
          upserts: [
            { id: 'note', type: 'note', x: 0, y: 0, width: 10, height: 10, z: 2, added: { at } },
          ],
          deleted: [],
        }),
      /image details/,
    );
  } finally {
    store.close();
  }
});
