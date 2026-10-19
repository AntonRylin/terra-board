import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  addToAlbum,
  canMakeAlbum,
  makeAlbum,
  releaseAlbum,
  removeFromAlbum,
  setAlbumCover,
} from '../src/canvas/album.ts';
import { clipboardObjects } from '../src/canvas/content.ts';
import { insertGalleryImages } from '../src/canvas/gallery.ts';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');

const png = (background, width = 40, height = 20) =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
const image = (id, x, y, extra = {}) => ({
  id,
  type: 'image',
  x,
  y,
  width: 200,
  height: 100,
  z: 1,
  assetId: id.repeat(64).slice(0, 64),
  ...extra,
});
const library = (name) => {
  mkdirSync(resolve('.local-test'), { recursive: true });
  return mkdtempSync(resolve(`.local-test/${name}-`));
};

test('a selection becomes one album card in reading order, and comes back out', () => {
  const second = image('b', 260, 0, {
    imageTitle: 'Second',
    crop: { x: 0, y: 0, width: 0.5, height: 1 },
  });
  const first = image('a', 0, 4);
  const third = image('c', 0, 160, { z: 4 });
  assert.equal(canMakeAlbum([first]), false);
  assert.equal(canMakeAlbum([first, { ...second, locked: true }]), false);
  assert.equal(canMakeAlbum([first, { ...second, type: 'document' }]), false);
  assert.ok(canMakeAlbum([second, third, first]));
  const { id, upserts, deleted } = makeAlbum([third, second, first]);
  const [card] = upserts;
  assert.equal(card.id, id);
  assert.deepEqual(deleted.sort(), ['a', 'b', 'c']);
  assert.equal(card.assetId, first.assetId);
  assert.equal(card.z, 4);
  assert.deepEqual(
    card.album.images.map((i) => i.id),
    ['a', 'b', 'c'],
  );
  assert.equal(card.album.images[1].title, 'Second');
  assert.deepEqual(card.album.images[1].crop, second.crop);
  assert.equal(card.album.storage, 'copy');

  const released = releaseAlbum(card);
  assert.deepEqual(released.deleted, [id]);
  assert.deepEqual(
    released.upserts.map((o) => [o.assetId, o.imageTitle, o.crop]),
    [
      [first.assetId, undefined, undefined],
      [second.assetId, 'Second', second.crop],
      [third.assetId, undefined, undefined],
    ],
  );
  assert.equal(released.upserts[0].x, card.x);
  assert.ok(released.upserts[1].x >= released.upserts[0].x + 200);
});

test('albums merge, take new images, change cover and let one image out', () => {
  const one = makeAlbum([image('a', 0, 0), image('b', 300, 0)]).upserts[0];
  const named = { ...one, album: { ...one.album, name: 'Trip', storage: 'link' } };
  const merged = makeAlbum([named, image('c', 0, 300)]).upserts[0];
  assert.equal(merged.album.name, 'Trip');
  assert.equal(merged.album.storage, 'link');
  assert.equal(merged.album.images.length, 3);

  const grown = addToAlbum(merged, [
    { id: 'd'.repeat(64), name: 'd.png', mime: 'image/png', width: 960, height: 480, bytes: 1 },
    { id: 'e'.repeat(64), name: 'e.pdf', mime: 'application/pdf', width: 0, height: 0, bytes: 1 },
  ]);
  assert.equal(grown.album.images.length, 4);
  assert.deepEqual([grown.album.images[3].width, grown.album.images[3].height], [480, 240]);

  const covered = setAlbumCover(grown, grown.album.images[3].id);
  assert.equal(covered.assetId, 'd'.repeat(64));
  assert.equal(covered.width, grown.width);
  assert.equal(covered.height, grown.width / 2);

  const out = removeFromAlbum(covered, grown.album.images[3].id);
  assert.equal(out.upserts[0].album.images.length, 3);
  assert.notEqual(out.upserts[0].assetId, 'd'.repeat(64));
  assert.equal(out.upserts[1].assetId, 'd'.repeat(64));
  const last = { ...one, album: { ...one.album, images: [one.album.images[0]] } };
  assert.deepEqual(removeFromAlbum(last, last.album.images[0].id), { upserts: [], deleted: [] });
});

test('an album stays a card: never a gallery member, and pastes whole', () => {
  const card = makeAlbum([image('a', 0, 0), image('b', 300, 0)]).upserts[0];
  const gallery = {
    id: 'g',
    type: 'frame',
    x: 0,
    y: 0,
    width: 400,
    height: 200,
    z: 0,
    gallery: { direction: 'right', size: 200, gap: 12 },
  };
  const edit = insertGalleryImages(new Map([['g', gallery]]), [card], { galleryId: 'g' });
  assert.equal(edit.upserts[0].galleryId, undefined);
  assert.deepEqual(clipboardObjects([card])[0].album, card.album);
  assert.throws(
    () => clipboardObjects([{ ...card, album: { ...card.album, images: [] } }]),
    /album/i,
  );
});

test('the store keeps albums and refuses broken ones', async () => {
  const root = library('album');
  const store = new Store(root);
  try {
    const a = await store.importAsset({ name: 'a.png', bytes: await png('#336699') });
    const b = await store.importAsset({ name: 'b.png', bytes: await png('#993366') });
    const board = store.createBoard({ name: 'Albums' });
    const card = makeAlbum([
      image('x', 0, 0, { assetId: a.id }),
      image('y', 300, 0, { assetId: b.id }),
    ]).upserts[0];
    store.patchBoard({ id: board.id, revision: 0, upserts: [card], deleted: [] });
    assert.deepEqual(store.loadBoard({ id: board.id }).objects[0].album, card.album);
    for (const [broken, why] of [
      [{ ...card, album: { ...card.album, storage: 'cloud' } }, /album/i],
      [{ ...card, assetId: 'f'.repeat(64) }, /asset|album/i],
      [{ ...card, album: { ...card.album, images: [] } }, /album/i],
      [{ ...card, type: 'document' }, /album|asset/i],
      [
        {
          ...card,
          album: {
            ...card.album,
            images: [
              ...card.album.images,
              { ...card.album.images[0], id: 'z', assetId: 'e'.repeat(64) },
            ],
          },
        },
        /album image/i,
      ],
    ])
      assert.throws(
        () => store.patchBoard({ id: board.id, revision: 1, upserts: [broken], deleted: [] }),
        why,
      );
    // Every album image travels in a portable board.
    const imported = await store.importBoard({ bytes: await store.exportBoard({ id: board.id }) });
    assert.deepEqual(store.loadBoard({ id: imported.id }).objects[0].album, card.album);
    assert.equal(store.boardSyncs({ id: board.id }), false);
  } finally {
    store.close();
  }
});

test('a linked image keeps only its preview, reads the file, and says why when it is gone', async () => {
  const root = library('album-link');
  const outside = mkdtempSync(resolve('.local-test/album-files-'));
  const file = join(outside, 'holiday.png');
  const bytes = await png('#55aa33', 64, 32);
  writeFileSync(file, bytes);
  let store = new Store(root);
  try {
    const linked = await store.importAsset({ name: 'holiday.png', bytes, link: { file } });
    const assets = join(root, 'assets', linked.id);
    assert.equal(existsSync(assets + '.original'), false);
    assert.ok(existsSync(assets + '.preview') && existsSync(assets + '.thumb'));
    assert.equal(store.asset({ id: linked.id, variant: 'original' }).file, resolve(file));
    assert.deepEqual(store.assetLinks({ ids: [linked.id, linked.id] }), [
      { id: linked.id, path: resolve(file), state: 'ok' },
    ]);
    const shown = await store.readAsset({ id: linked.id, variant: 'export' });
    assert.ok(shown.file.startsWith(join(root, 'temp', 'linked')));
    assert.equal((await sharp(shown.file).metadata()).width, 64);

    // Moved away: the board draws the preview; strict reads say why.
    const moved = join(outside, 'moved.png');
    renameSync(file, moved);
    assert.equal(store.assetLinks({ ids: [linked.id] })[0].state, 'missing');
    assert.throws(
      () => store.asset({ id: linked.id, variant: 'original' }),
      (e) =>
        e.message.includes('holiday.png') &&
        e.message.includes('is missing') &&
        e.message.includes('Locate file'),
    );
    const fallback = await store.readAsset({ id: linked.id, variant: 'export' });
    assert.match(fallback.file, /export-preview\.png$/);
    const tile = await store.readAsset({ id: linked.id, variant: 'tile-2-2-1-1' });
    assert.match(tile.file, /-preview$/);
    const board = store.createBoard({ name: 'Linked' });
    const card = makeAlbum([
      image('x', 0, 0, { assetId: linked.id }),
      image('y', 0, 0, { assetId: linked.id }),
    ]).upserts[0];
    store.patchBoard({ id: board.id, revision: 0, upserts: [card], deleted: [] });
    await assert.rejects(store.exportBoard({ id: board.id }), /holiday\.png.*is missing/);

    // Locate file…: a different picture is refused, the same one is accepted.
    const other = join(outside, 'other.png');
    writeFileSync(other, await png('#000000', 64, 32));
    assert.throws(() => store.relinkAsset({ id: linked.id, file: other }), /different picture/);
    assert.equal(store.relinkAsset({ id: linked.id, file: moved }).state, 'ok');
    assert.equal(store.asset({ id: linked.id, variant: 'original' }).file, resolve(moved));

    // Edited after it was added: 'changed', not silently a new picture.
    const later = new Date(Date.now() + 60000);
    utimesSync(moved, later, later);
    assert.equal(store.assetLinks({ ids: [linked.id] })[0].state, 'changed');

    // The same picture added as a copy takes its copy; the link is gone.
    await store.importAsset({ name: 'holiday.png', bytes });
    assert.ok(existsSync(assets + '.original'));
    assert.deepEqual(store.assetLinks({ ids: [linked.id] }), []);
    assert.equal(store.asset({ id: linked.id, variant: 'original' }).file, assets + '.original');

    // Linked state survives reopening; the cache in temp does not.
    const second = join(outside, 'second.png');
    writeFileSync(second, await png('#123456', 30, 30));
    const kept = await store.importAsset({
      name: 'second.png',
      bytes: await png('#123456', 30, 30),
      link: { file: second },
    });
    await store.readAsset({ id: kept.id, variant: 'export' });
    store.close();
    store = new Store(root);
    assert.equal(store.assetLinks({ ids: [kept.id] })[0].state, 'ok');
    assert.equal(existsSync(join(root, 'temp', 'linked', `${kept.id}.export.png`)), false);
  } finally {
    store.close();
  }
});
