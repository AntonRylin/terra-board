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
    a.syncRejoined(); // the first pull found nothing on the server
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
    a.syncRejoined(); // the first pull found nothing on the server
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
    a.syncRejoined(); // the first pull found nothing on the server
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
    a.syncRejoined(); // the first pull found nothing on the server
    b.syncEnable({ workspace });
    b.syncRejoined(); // the first pull found nothing on the server
    server.push(a);
    server.push(b);
    const applied = await server.pull(b);
    assert.deepEqual(applied.boards, [board.id]);
    const copy = b.loadBoard({ id: board.id });
    assert.equal(copy.board.name, 'Shared plan');
    assert.equal(copy.board.folderId, folder.id);
    // The other computer shows when the board was made, not when it arrived.
    assert.equal(b.boardInfo({ id: board.id }).created, a.boardInfo({ id: board.id }).created);
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
    a.syncRejoined(); // the first pull found nothing on the server
    b.syncEnable({ workspace });
    b.syncRejoined(); // the first pull found nothing on the server
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
    a.syncRejoined(); // the first pull found nothing on the server
    b.syncEnable({ workspace });
    b.syncRejoined(); // the first pull found nothing on the server
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
    a.syncRejoined(); // the first pull found nothing on the server
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

test('remote rows this version cannot read are kept and retried', () =>
  withStores((a) => {
    a.syncEnable({ workspace });
    a.syncRejoined(); // the first pull found nothing on the server
    const board = a.createBoard({ name: 'Newer' });
    a.syncAck({ entries: a.syncTake({ limit: 500 }).entries });
    const bad = { kind: 'object', board_id: board.id, id: 'future', seq: 1 };
    a.syncApply({ cursor: 1, rows: [{ ...bad, data: { id: 'future', type: 'hologram' } }] });
    assert.equal(a.syncStatus().held, 1);
    // A newer version of the app can read it: the next sync applies it.
    a.db
      .prepare('UPDATE sync_held SET row=?')
      .run(JSON.stringify({ ...bad, data: note('future', 'from a newer app') }));
    a.syncApply({ cursor: 1, rows: [] });
    assert.deepEqual(
      a.loadBoard({ id: board.id }).objects.map((o) => o.text),
      ['from a newer app'],
    );
    assert.equal(a.syncStatus().held, 0);
    // A newer change to a held object replaces it.
    a.syncApply({
      cursor: 2,
      rows: [{ ...bad, id: 'x', seq: 2, data: { id: 'x', type: 'nope' } }],
    });
    assert.equal(a.syncStatus().held, 1);
    a.syncApply({ cursor: 3, rows: [{ ...bad, id: 'x', seq: 3, data: note('x', 'fixed') }] });
    assert.equal(a.syncStatus().held, 0);
    assert.equal(a.loadBoard({ id: board.id }).objects.length, 2);
  }));

const ownerWs = '11111111-2222-4333-8444-555555555555';
const friendWs = '99999999-8888-4777-8666-555555555555';
const entriesOf = (store) => store.syncTake({ limit: 500 });

test('without whole-library sync only shared folders and their boards are queued', () =>
  withStores((a) => {
    const shared = a.createFolder({ name: 'With Sam' });
    const inside = a.createBoard({ name: 'Plan', folderId: shared.id });
    a.patchBoard({ id: inside.id, revision: 0, upserts: [note('n1', 'hi')] });
    const secret = a.createBoard({ name: 'Diary' });
    a.patchBoard({ id: secret.id, revision: 0, upserts: [note('n2', 'private')] });
    a.syncIdentity({ workspace: ownerWs });
    assert.equal(a.syncStatus().pending, 0, 'nothing uploads until something is shared');
    // A share learned from the server (another computer created it) uploads nothing.
    a.syncOwned({ shares: [{ kind: 'folder', targetId: shared.id, shareId: 's1' }] });
    assert.equal(a.syncStatus().pending, 0, 'known shares never resend local copies');
    a.syncOwned({ shares: [] });
    // Creating the share here uploads its content once.
    a.syncOwned({ upload: true, shares: [{ kind: 'folder', targetId: shared.id, shareId: 's1' }] });
    const ids = entriesOf(a).entries.map((e) => e.kind + ':' + e.id);
    assert.deepEqual(ids.sort(), ['board:' + inside.id, 'folder:' + shared.id, 'object:n1'].sort());
    a.syncAck(entriesOf(a));
    a.patchBoard({ id: secret.id, revision: 1, upserts: [note('n2', 'still private')] });
    assert.equal(a.syncStatus().pending, 0, 'private boards stay local');
    // Moving a board into the shared folder brings it and its content along.
    a.updateBoard({ id: secret.id, patch: { folderId: shared.id } });
    const moved = entriesOf(a).entries.map((e) => e.kind + ':' + e.id);
    assert.ok(moved.includes('board:' + secret.id) && moved.includes('object:n2'));
    a.syncAck(entriesOf(a));
    // Moving it out again is pushed so the server stops sharing it.
    a.updateBoard({ id: secret.id, patch: { folderId: null } });
    assert.deepEqual(
      entriesOf(a).entries.map((e) => [e.kind, e.data.folderId]),
      [['board', null]],
    );
  }));

test('shared boards arrive with their rights; edits go back only with edit rights', () =>
  withStores((friend) => {
    friend.syncIdentity({ workspace: friendWs });
    const folder = {
      kind: 'folder',
      board_id: '',
      id: 'f-shared',
      data: { name: 'With Sam', position: 1 },
      seq: 1,
    };
    const board = (id, name) => ({
      kind: 'board',
      board_id: '',
      id,
      data: {
        name,
        icon: 'none',
        color: 'blue',
        folderId: 'f-shared',
        position: 1,
        trashed: false,
      },
      seq: 2,
    });
    const object = (boardId, id, text) => ({
      kind: 'object',
      board_id: boardId,
      id,
      data: note(id, text),
      seq: 3,
    });
    const roles = {
      folders: { 'f-shared': { role: 'edit', owner: 'Anton' } },
      boards: {
        'b-edit': { role: 'edit', owner: 'Anton' },
        'b-view': { role: 'view', owner: 'Anton' },
      },
    };
    friend.syncApply({
      workspace: ownerWs,
      cursor: 3,
      roles,
      rows: [
        folder,
        board('b-edit', 'Editable'),
        board('b-view', 'Read only'),
        object('b-edit', 'e1', 'x'),
        object('b-view', 'v1', 'y'),
      ],
    });
    assert.equal(friend.syncStatus().pending, 0, 'received rows are not echoed');
    const marks = friend.library().sharing;
    assert.equal(marks.boards['b-edit'].shared, 'edit');
    assert.equal(marks.boards['b-view'].shared, 'view');
    assert.equal(marks.folders['f-shared'].owner, 'Anton');

    friend.patchBoard({ id: 'b-edit', revision: 1, upserts: [note('e1', 'changed by friend')] });
    friend.patchBoard({ id: 'b-view', revision: 1, upserts: [note('v1', 'should not leave')] });
    friend.updateBoard({ id: 'b-edit', patch: { name: 'Renamed by friend' } });
    const out = entriesOf(friend);
    assert.deepEqual(
      out.entries.map((e) => [e.kind, e.id, e.workspace]),
      [['object', 'e1', ownerWs]],
    );
    assert.equal(out.dropped.length, 0, 'view-only edits and board renames are never queued');
    assert.equal(friend.syncStatus().pending, 1);

    // Access to the read-only board ends; its copy disappears.
    const result = friend.syncReconcile({
      shares: [
        {
          workspace: ownerWs,
          kind: 'board',
          targetId: 'b-edit',
          role: 'edit',
          boards: ['b-edit'],
          owner: 'Anton',
        },
      ],
    });
    assert.ok(result.changed);
    const left = friend.library().boards.map((b) => b.id);
    assert.ok(left.includes('b-edit') && !left.includes('b-view'));
  }));

// A board shared with edit rights, arrived on the friend's computer.
function receiveSharedBoard(friend, id = 'b-shared') {
  friend.syncIdentity({ workspace: friendWs });
  friend.syncApply({
    workspace: ownerWs,
    cursor: 2,
    roles: { folders: {}, boards: { [id]: { role: 'edit', owner: 'Anton' } } },
    rows: [
      {
        kind: 'board',
        board_id: '',
        id,
        data: { name: 'Shared', icon: 'none', color: 'blue', position: 1, trashed: false },
        seq: 1,
      },
      { kind: 'object', board_id: id, id: 'n1', data: note('n1', 'from Anton'), seq: 2 },
    ],
  });
}

test('access ending removes the copy and its unsent edits', () =>
  withStores((friend) => {
    receiveSharedBoard(friend);
    friend.patchBoard({ id: 'b-shared', revision: 1, upserts: [note('n1', 'friend edit')] });
    assert.equal(friend.syncStatus().pending, 1);
    const result = friend.syncReconcile({ shares: [] });
    assert.ok(result.changed);
    assert.ok(!friend.library().boards.some((b) => b.id === 'b-shared'));
    assert.equal(friend.syncStatus().pending, 0, 'nothing is left for the server to refuse');
    assert.deepEqual(friend.library().sharing.boards, {});
  }));

test('signing out removes copies of other people boards, never own ones', () =>
  withStores((friend) => {
    receiveSharedBoard(friend);
    const own = friend.createBoard({ name: 'Mine' });
    assert.deepEqual(friend.syncDropForeign(), { changed: true });
    const ids = friend.library().boards.map((b) => b.id);
    assert.ok(ids.includes(own.id) && !ids.includes('b-shared'));
    assert.deepEqual(friend.syncDropForeign(), { changed: false });
  }));

test('a board newly placed in a shared folder is reported for download', () =>
  withStores((friend) => {
    friend.syncIdentity({ workspace: friendWs });
    const result = friend.syncReconcile({
      shares: [
        {
          workspace: ownerWs,
          kind: 'folder',
          targetId: 'f1',
          role: 'view',
          boards: ['b1', 'b2'],
          owner: 'Anton',
        },
      ],
    });
    assert.deepEqual(result.missing, [
      { workspace: ownerWs, boards: ['b1', 'b2'], folders: ['f1'] },
    ]);
  }));

test('a board taken out of the cloud stays local, and another computer keeps its copy', async () =>
  withStores(async (a, b) => {
    const server = fakeServer();
    a.syncEnable({ workspace });
    a.syncRejoined(); // the first pull found nothing on the server
    b.syncEnable({ workspace });
    b.syncRejoined(); // the first pull found nothing on the server
    const board = a.createBoard({ name: 'Diary' });
    a.patchBoard({ id: board.id, revision: 0, upserts: [note('d1', 'private')] });
    server.push(a);
    await server.pull(b);
    assert.ok(b.library().boards.some((x) => x.id === board.id));

    a.syncKeepLocal({ boardId: board.id });
    assert.deepEqual(a.library().sharing.local, [board.id]);
    // What the cloud side pushes: the marker, then the deletions.
    let seq = Math.max(...[...server.rows.values()].map((r) => r.seq));
    server.rows.set(`board::${board.id}`, {
      kind: 'board',
      board_id: '',
      id: board.id,
      data: { removed: true },
      deleted: false,
      seq: ++seq,
    });
    server.rows.set(`object:${board.id}:d1`, {
      kind: 'object',
      board_id: board.id,
      id: 'd1',
      data: null,
      deleted: true,
      seq: ++seq,
    });
    await server.pull(b);
    assert.equal(
      b.loadBoard({ id: board.id }).objects.length,
      1,
      'the other computer keeps the content',
    );
    assert.deepEqual(b.library().sharing.local, [board.id]);

    // Edits to it are no longer sent from either computer.
    const rev = a.loadBoard({ id: board.id }).revision;
    a.patchBoard({ id: board.id, revision: rev, upserts: [note('d2', 'still private')] });
    a.patchBoard({ id: board.id, revision: rev + 1, deletes: ['d1'] });
    assert.equal(a.syncTake({ limit: 50 }).entries.length, 0);
    a.syncLibrary({ on: false });
    a.syncLibrary({ on: true });
    a.syncRejoined();
    assert.equal(a.syncTake({ limit: 50 }).entries.length, 0, 'library sync leaves it out');

    // Sharing it again puts it back in the cloud.
    a.syncOwned({ upload: true, shares: [{ kind: 'board', targetId: board.id, shareId: 's1' }] });
    assert.deepEqual(a.library().sharing.local, []);
    const kinds = a.syncTake({ limit: 50 }).entries.map((e) => e.kind + ':' + e.id);
    assert.ok(kinds.includes('board:' + board.id) && kinds.includes('object:d2'));
  }));

test('a shared board whose owner combined libraries keeps its copy and follows the new workspace', () =>
  withStores((friend) => {
    receiveSharedBoard(friend);
    friend.patchBoard({ id: 'b-shared', revision: 1, upserts: [note('n1', 'friend edit')] });
    const combined = '7a7a7a7a-1111-4222-8333-444444444444';
    const result = friend.syncReconcile({
      shares: [
        {
          workspace: combined,
          kind: 'board',
          targetId: 'b-shared',
          role: 'edit',
          boards: ['b-shared'],
          owner: 'Anton',
        },
      ],
    });
    assert.ok(result.changed);
    assert.deepEqual(result.missing, [], 'nothing to download again');
    assert.equal(friend.library().boards.filter((b) => b.id === 'b-shared').length, 1);
    // The unsent edit goes to the new workspace.
    assert.deepEqual(
      entriesOf(friend).entries.map((e) => [e.id, e.workspace]),
      [['n1', combined]],
    );
  }));

test('signing in again pulls first: newer edits from elsewhere survive, new local boards upload', async () =>
  withStores(async (a, b) => {
    const server = fakeServer();
    const board = a.createBoard({ name: 'Plans' });
    a.patchBoard({
      id: board.id,
      revision: 0,
      upserts: [note('n1', 'first'), note('n2', 'to delete')],
    });
    a.syncEnable({ workspace });
    a.syncRejoined();
    server.push(a);
    b.syncEnable({ workspace });
    await server.pull(b);
    b.syncRejoined();
    assert.equal(b.syncStatus().pending, 0, 'nothing of a is sent back');

    // a signs out; b keeps working.
    a.syncDisable();
    const onB = b.loadBoard({ id: board.id });
    b.patchBoard({
      id: board.id,
      revision: onB.revision,
      upserts: [note('n1', 'newer on b')],
      deleted: ['n2'],
    });
    server.push(b);
    // a, signed out, makes a new board.
    const fresh = a.createBoard({ name: 'Made while signed out' });
    a.patchBoard({ id: fresh.id, revision: 0, upserts: [note('f1', 'new')] });

    // a signs in again: same workspace.
    a.syncEnable({ workspace });
    assert.equal(a.syncStatus().pending, 0, 'nothing is pushed before the pull');
    await server.pull(a);
    a.syncRejoined();
    const objects = Object.fromEntries(
      a.loadBoard({ id: board.id }).objects.map((o) => [o.id, o.text]),
    );
    assert.equal(objects.n1, 'newer on b');
    assert.ok(!('n2' in objects), 'the deletion made elsewhere stays');
    const queued = a.syncTake({ limit: 500 }).entries.map((e) => e.id);
    assert.deepEqual(queued.sort(), [fresh.id, 'f1'].sort());
  }));
