import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const sharp = require('sharp');

const workspace = '6f1c7a52-3f2d-4d55-9a3e-0d6b8c1e2f40';
const note = (id, text) => ({ id, type: 'note', x: 0, y: 0, width: 200, height: 160, text, z: 1 });

async function withStores(fn) {
  const roots = [0, 1].map(() => mkdtempSync(join(tmpdir(), 'terra-sync-test-')));
  const stores = roots.map((root) => new Store(root));
  try {
    await fn(...stores);
  } finally {
    stores.forEach((s) => s.close());
    roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  }
}

// A minimal stand-in for the server: rows keyed like the entities table, with a seq.
function fakeServer() {
  const rows = new Map();
  const files = new Map();
  let seq = 0;
  return {
    push(store) {
      for (;;) {
        const batch = store.syncTake({ limit: 50 });
        if (!batch.entries.length) return;
        for (const a of batch.assets) {
          files.set(a.id, readFileSync(a.file));
          rows.set(`asset::${a.id}`, {
            kind: 'asset',
            board_id: '',
            id: a.id,
            data: { name: a.name, mime: a.mime },
            deleted: false,
            seq: ++seq,
          });
        }
        for (const e of batch.entries)
          rows.set(`${e.kind}:${e.board_id}:${e.id}`, {
            kind: e.kind,
            board_id: e.board_id,
            id: e.id,
            data: e.data,
            deleted: e.deleted,
            seq: ++seq,
          });
        store.syncAck({ entries: batch.entries, assets: batch.assets.map((a) => a.id) });
      }
    },
    async pull(store) {
      const { cursor } = store.syncStatus();
      const changed = [...rows.values()]
        .filter((r) => r.seq > cursor)
        .sort((a, b) => a.seq - b.seq);
      if (!changed.length) return { boards: [], library: false };
      for (const r of changed.filter((r) => r.kind === 'asset'))
        if (store.syncMissingAssets({ ids: [r.id] }).length)
          await store.syncImportAsset({ bytes: files.get(r.id), name: r.data.name });
      return store.syncApply({ rows: changed, cursor: changed.at(-1).seq });
    },
    rows,
  };
}

test('nothing is queued until sync is on, then the whole library is', () =>
  withStores((a) => {
    a.createFolder({ name: 'Work' });
    const b = a.createBoard({ name: 'Plans' });
    a.patchBoard({ id: b.id, revision: 0, upserts: [note('n1', 'hi')] });
    assert.equal(a.syncStatus().pending, 0);
    a.syncEnable({ workspace });
    const { entries } = a.syncTake({ limit: 500 });
    const kinds = entries.map((e) => e.kind);
    assert.ok(kinds.includes('board') && kinds.includes('object') && kinds.includes('folder'));
    assert.deepEqual(
      kinds,
      [...kinds].sort((x, y) => 'fbo'.indexOf(x[0]) - 'fbo'.indexOf(y[0])),
    );
  }));

test('camera moves and revision bumps are not synced, content edits are', () =>
  withStores((a) => {
    const b = a.createBoard({ name: 'Plans' });
    a.syncEnable({ workspace });
    a.syncAck({ entries: a.syncTake({ limit: 500 }).entries });
    assert.equal(a.syncStatus().pending, 0);
    a.saveCamera({ id: b.id, camera: { x: 5, y: 5, zoom: 2 } });
    assert.equal(a.syncStatus().pending, 0);
    a.updateBoard({ id: b.id, patch: { name: 'Renamed' } });
    assert.equal(a.syncStatus().pending, 1);
  }));

test('an edit made after take survives the acknowledgement', () =>
  withStores((a) => {
    const b = a.createBoard({ name: 'Plans' });
    a.syncEnable({ workspace });
    const taken = a.syncTake({ limit: 500 });
    a.updateBoard({ id: b.id, patch: { name: 'Changed meanwhile' } });
    a.syncAck({ entries: taken.entries });
    const again = a.syncTake({ limit: 500 }).entries;
    assert.equal(again.length, 1);
    assert.equal(again[0].data.name, 'Changed meanwhile');
  }));

test('two libraries converge on boards, objects, deletions and images', async () =>
  withStores(async (a, b) => {
    const server = fakeServer();
    const folder = a.createFolder({ name: 'Work' });
    const board = a.createBoard({ name: 'Shared plan', folderId: folder.id });
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#3366ff' },
    })
      .png()
      .toBuffer();
    const image = await a.importAsset({ bytes: png, name: 'blue.png' });
    a.patchBoard({
      id: board.id,
      revision: 0,
      upserts: [
        note('n1', 'first'),
        { id: 'img', type: 'image', x: 0, y: 0, width: 8, height: 8, z: 2, assetId: image.id },
      ],
    });
    a.syncEnable({ workspace });
    b.syncEnable({ workspace });
    server.push(a);
    server.push(b);
    const applied = await server.pull(b);
    assert.deepEqual(applied.boards, [board.id]);
    const copy = b.loadBoard({ id: board.id });
    assert.equal(copy.board.name, 'Shared plan');
    assert.equal(copy.board.folderId, folder.id);
    assert.deepEqual(copy.objects.map((o) => o.id).sort(), ['img', 'n1']);
    assert.ok(b.asset({ id: image.id, variant: 'original' }));
    // Applying remote rows must not queue them to be pushed back.
    assert.equal(b.syncStatus().pending, 0);

    // B edits and deletes; A receives it.
    b.patchBoard({
      id: board.id,
      revision: copy.revision,
      upserts: [note('n1', 'edited on B')],
      deleted: ['img'],
    });
    server.push(b);
    await server.pull(a);
    const back = a.loadBoard({ id: board.id });
    assert.deepEqual(
      back.objects.map((o) => o.text),
      ['edited on B'],
    );
    // The image was uploaded once, by A.
    assert.equal([...server.rows.values()].filter((r) => r.kind === 'asset').length, 1);
  }));

test('a local unsent edit wins over an incoming change to the same object', async () =>
  withStores(async (a, b) => {
    const server = fakeServer();
    const board = a.createBoard({ name: 'Race' });
    a.patchBoard({ id: board.id, revision: 0, upserts: [note('n1', 'base')] });
    a.syncEnable({ workspace });
    b.syncEnable({ workspace });
    server.push(a);
    await server.pull(b);
    const rev = b.loadBoard({ id: board.id }).revision;
    b.patchBoard({ id: board.id, revision: rev, upserts: [note('n1', 'local on B')] });
    a.patchBoard({ id: board.id, revision: 1, upserts: [note('n1', 'remote from A')] });
    server.push(a);
    await server.pull(b);
    assert.equal(b.loadBoard({ id: board.id }).objects[0].text, 'local on B');
    server.push(b);
    await server.pull(a);
    assert.equal(a.loadBoard({ id: board.id }).objects[0].text, 'local on B');
  }));

test('remote edits bump the revision so stale local saves are detected', async () =>
  withStores(async (a, b) => {
    const server = fakeServer();
    const board = a.createBoard({ name: 'Rev' });
    a.patchBoard({ id: board.id, revision: 0, upserts: [note('n1', 'one')] });
    a.syncEnable({ workspace });
    b.syncEnable({ workspace });
    server.push(a);
    await server.pull(b);
    const before = b.loadBoard({ id: board.id }).revision;
    a.patchBoard({ id: board.id, revision: 1, upserts: [note('n1', 'two')] });
    server.push(a);
    await server.pull(b);
    assert.equal(b.loadBoard({ id: board.id }).revision, before + 1);
    assert.throws(
      () => b.patchBoard({ id: board.id, revision: before, upserts: [note('n1', 'stale')] }),
      /changed since this revision/,
    );
  }));

test('malformed remote rows are skipped without blocking the batch', () =>
  withStores((a) => {
    a.syncEnable({ workspace });
    const board = a.createBoard({ name: 'Mixed' });
    a.syncAck({ entries: a.syncTake({ limit: 500 }).entries });
    const result = a.syncApply({
      cursor: 2,
      rows: [
        {
          kind: 'object',
          board_id: board.id,
          id: 'bad',
          data: { id: 'bad', type: 'nope' },
          seq: 1,
        },
        { kind: 'object', board_id: board.id, id: 'ok', data: note('ok', 'fine'), seq: 2 },
      ],
    });
    assert.deepEqual(result.boards, [board.id]);
    assert.deepEqual(
      a.loadBoard({ id: board.id }).objects.map((o) => o.id),
      ['ok'],
    );
    assert.equal(a.syncStatus().cursor, 2);
  }));
