import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { Store } = require('../electron/store.cjs');
const { DatabaseSync } = require('node:sqlite');
const item = {
  id: 'a',
  type: 'text',
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  z: 1,
  text: 'Important work',
};
test('retry after a lost save acknowledgement is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-retry-')),
    store = new Store(root);
  try {
    const board = store.createBoard({ name: 'Work' }),
      edit = { id: board.id, revision: 0, operationId: 'save-001', upserts: [item], deleted: [] };
    assert.equal(store.patchBoard(edit).revision, 1);
    assert.equal(store.patchBoard(edit).revision, 1);
    assert.equal(store.loadBoard({ id: board.id }).revision, 1);
    assert.throws(
      () => store.patchBoard({ ...edit, upserts: [{ ...item, text: 'different' }] }),
      /operation|reused/i,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('future schema is rejected without downgrading the library', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-schema-'));
  const file = join(root, 'library.sqlite');
  let db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=99');
  db.close();
  try {
    assert.throws(() => new Store(root), /newer version/);
    db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Unicode graphemes remain intact when a long board name is duplicated', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-unicode-')),
    store = new Store(root);
  try {
    const name = '👨‍👩‍👧‍👦'.repeat(120);
    const board = store.createBoard({ name });
    const copy = store.duplicateBoard({ id: board.id });
    assert.equal(copy.name, '👨‍👩‍👧‍👦'.repeat(110) + ' copy');
    assert.throws(() => store.createBoard({ name: name + 'a' }), /120/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt later media entry leaves no board, asset rows, or asset files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-staged-')),
    store = new Store(root);
  try {
    const { zipSync, strToU8 } = require('fflate');
    const { createHash } = require('node:crypto');
    const good = await require('sharp')({
      create: { width: 8, height: 8, channels: 3, background: '#668877' },
    })
      .png()
      .toBuffer();
    const bad = Buffer.from('not an image');
    const assets = [good, bad].map((data, i) => ({
      id: createHash('sha256').update(data).digest('hex'),
      name: `image-${i}.png`,
    }));
    const manifest = {
      format: 'local-canvas',
      version: 1,
      name: 'Test',
      icon: 'image',
      color: 'green',
      camera: { x: 0, y: 0, zoom: 1 },
      objects: [],
      assets,
    };
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      ['assets/' + assets[0].id]: good,
      ['assets/' + assets[1].id]: bad,
    });
    await assert.rejects(store.importBoard({ bytes }));
    assert.equal(store.library().boards.length, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM assets').get().n, 0);
    assert.deepEqual(readdirSync(join(root, 'assets')), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('invalid import metadata never leaves a visible partially imported board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-atomic-')),
    store = new Store(root);
  try {
    const { zipSync, strToU8 } = require('fflate');
    const bytes = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          format: 'local-canvas',
          version: 1,
          name: 'Bad',
          icon: '<script>',
          color: 'blue',
          objects: [item],
          assets: [],
          camera: { x: 0, y: 0, zoom: 1 },
        }),
      ),
    });
    await assert.rejects(store.importBoard({ bytes }));
    assert.equal(store.library().boards.length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
