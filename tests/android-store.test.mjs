// The Android build runs electron/store.cjs on SQLite-WASM with the shims in
// src/mobile/shims (docs/android.md). This runs the same store through the same
// shims in Node, so storage changes that break the Android path fail here.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const shim = (file) => new URL('../src/mobile/shims/' + file, import.meta.url).href;
const shims = {
  'node:sqlite': shim('sqlite.ts'),
  'node:fs': shim('fs.ts'),
  'node:path': shim('path.ts'),
  'node:crypto': shim('crypto.ts'),
  'node:os': shim('node-stubs.ts'),
  'node:stream': shim('node-stubs.ts'),
  sharp: shim('sharp.cjs'),
};
// Only the store's own files see the shims; everything else keeps Node's
// modules. (Module hooks cannot replace built-ins for require().)
const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
const electron = fileURLToPath(new URL('../electron/', import.meta.url));
const redirected = new Set();
Module._load = function (request, parent, isMain) {
  if (shims[request] && parent?.filename?.startsWith(electron)) {
    redirected.add(request);
    return load.call(this, fileURLToPath(shims[request]), parent, isMain);
  }
  return load.call(this, request, parent, isMain);
};

let Store, fs, path;
before(async () => {
  const sqlite3 = await sqlite3InitModule();
  const { setDatabaseOpener } = await import(shims['node:sqlite']);
  fs = await import(shims['node:fs']);
  path = await import(shims['node:path']);
  fs.setFileDatabase(new sqlite3.oo1.DB(':memory:'));
  setDatabaseOpener(() => new sqlite3.oo1.DB(':memory:'));
  ({ Store } = require('../electron/store.cjs'));
  // Never the real disk or SQLite: the store must have loaded every shim.
  for (const name of ['node:sqlite', 'node:fs', 'node:path', 'node:crypto', 'sharp'])
    assert.ok(redirected.has(name), name + ' was not replaced');
});

const note = (id, text, extra = {}) => ({
  id,
  type: 'note',
  x: 0,
  y: 0,
  width: 220,
  height: 220,
  z: 1,
  text,
  color: '#fff2a8',
  fontSize: 24,
  ...extra,
});

test('path shim resolves like POSIX path', () => {
  assert.equal(path.join('/library', 'assets', 'a.original'), '/library/assets/a.original');
  assert.equal(path.resolve('/library', '../x', './y'), '/x/y');
  assert.equal(path.dirname('/library/assets/a'), '/library/assets');
  assert.equal(path.basename('/a/b/photo.jpg'), 'photo.jpg');
  assert.equal(path.extname('photo.JPG'), '.JPG');
  assert.equal(path.extname('.hidden'), '');
});

test('fs shim keeps files, directories, renames and recursive removal', () => {
  fs.mkdirSync('/t/a/b', { recursive: true });
  assert.ok(fs.existsSync('/t/a') && fs.statSync('/t/a').isDirectory());
  const fd = fs.openSync('/t/a/b/file.tmp', 'wx');
  fs.writeFileSync(fd, Buffer.from('hello '));
  fs.writeFileSync(fd, Buffer.from('world'));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  assert.throws(() => fs.openSync('/t/a/b/file.tmp', 'wx'), { code: 'EEXIST' });
  fs.renameSync('/t/a/b/file.tmp', '/t/a/b/file');
  assert.equal(fs.readFileSync('/t/a/b/file', 'utf8'), 'hello world');
  assert.equal(fs.statSync('/t/a/b/file').size, 11);
  assert.deepEqual(fs.readdirSync('/t/a'), ['b']);
  assert.equal(fs.statSync('/t/missing', { throwIfNoEntry: false }), undefined);
  assert.throws(() => fs.readFileSync('/t/missing'), { code: 'ENOENT' });
  fs.rmSync('/t', { recursive: true, force: true });
  assert.equal(fs.existsSync('/t/a/b/file'), false);
  assert.equal(fs.existsSync('/t'), false);
});

test('the store runs on the Android shims: boards, edits, history, search, export', async () => {
  const s = new Store('/library');
  const b = s.createBoard({ name: 'Phone' });
  s.patchBoard({ id: b.id, revision: 0, upserts: [note('n1', 'Hello from Android')] });
  s.patchBoard({ id: b.id, revision: 1, upserts: [note('n2', 'Ünïcödé note', { x: 300 })] });
  s.patchBoard({ id: b.id, revision: 2, deleted: ['n1'] });
  const loaded = s.loadBoard({ id: b.id });
  assert.deepEqual(
    loaded.objects.map((o) => o.text),
    ['Ünïcödé note'],
  );
  // search_contains is a JavaScript SQL function with two arguments.
  const found = s.searchContent({ query: 'ünïcödé' });
  assert.ok(JSON.stringify(found).includes('Ünïcödé'));
  // History keeps the deleted note.
  const history = s.boardHistory({ id: b.id });
  assert.ok(JSON.stringify(history).includes('Hello from Android'));
  s.updateBoard({ id: b.id, patch: { name: 'Renamed' } });
  assert.equal(s.library().boards.find((x) => x.id === b.id).name, 'Renamed');
  const info = s.boardInfo({ id: b.id });
  assert.equal(info.objects, 1);
  // A portable export made here imports as a copy.
  const bytes = await s.exportBoard({ id: b.id });
  const copy = await s.importBoard({ bytes });
  assert.equal(copy.name, 'Renamed');
  assert.equal(s.loadBoard({ id: copy.id }).objects[0].text, 'Ünïcödé note');
  s.updateBoard({ id: copy.id, patch: { trashed: true } });
  assert.equal(s.library().boards.find((x) => x.id === copy.id).trashed, true);
  s.close();
});

test('documents are stored as files in the shim file system', async () => {
  const s = new Store('/library');
  const text = new TextEncoder().encode('plain notes');
  const asset = await s.importAsset({ bytes: text, name: 'notes.txt' });
  assert.equal(asset.mime, 'text/plain');
  const read = await s.readAsset({ id: asset.id, variant: 'original' });
  assert.equal(fs.readFileSync(read.file, 'utf8'), 'plain notes');
  s.close();
});
