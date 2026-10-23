// The desktop half of accounts: what the claim does to the local library, signing out,
// turning sync off while signed in, and telling this computer's pushes from others'.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CloudSync } = require('../electron/cloud-sync.cjs');
const { Store } = require('../electron/store.cjs');

const oldWs = '11111111-2222-4333-8444-555555555555';
const accountWs = '22222222-3333-4444-8555-666666666666';
const device = '33333333-4444-4555-8666-777777777777';
const note = (id, text) => ({ id, type: 'note', x: 0, y: 0, width: 200, height: 160, text, z: 1 });

function fakeAuth(overrides = {}) {
  const calls = [];
  const account = { state: 'signedIn', userId: 'account', email: 'a@b.eu' };
  return {
    calls,
    account: async () => account,
    session: async () => ({ user: { id: 'account' } }),
    waiting: () => null,
    methods: async () => ({ email: true, google: true, microsoft: false }),
    registerDevice: async () => ({ revoked: false }),
    claim: async (tokens) => {
      calls.push(['claim', tokens]);
      return overrides.claim ? overrides.claim(tokens) : { result: 'moved', workspace: oldWs };
    },
    personalWorkspace: async (name) => {
      calls.push(['personalWorkspace', name]);
      return { workspace: accountWs, name, created: true };
    },
    retireWorkspace: async (old, next) => calls.push(['retire', old, next]),
    signOut: async (options) => calls.push(['signOut', options]),
    cancel: () => {},
  };
}

function setup({ library = true, auth = fakeAuth() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-claim-'));
  const store = new Store(root);
  const sync = new CloudSync({
    call: async (command, args) => store[command](args),
    root,
    config: null,
    transaction: (job) => job(),
  });
  sync.auth = auth;
  sync.deviceId = device;
  const board = store.createBoard({ name: 'Mine' });
  store.patchBoard({ id: board.id, revision: 0, upserts: [note('n1', 'hello')] });
  store.syncIdentity({ workspace: oldWs, name: 'Anton' });
  if (library) {
    store.syncLibrary({ on: true });
    store.syncRejoined();
  }
  // Everything was uploaded before the claim.
  const batch = store.syncTake({ limit: 500 });
  store.syncAck({ entries: batch.entries, dropped: batch.dropped, assets: [] });
  return {
    root,
    store,
    sync,
    auth,
    board,
    done: () => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const keepTokens = (sync) =>
  sync.vault.setItem(
    'terra-cloud-anonymous',
    JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
  );

test('a claim that keeps the workspace changes nothing locally', async () => {
  const { store, sync, auth, done } = setup();
  try {
    keepTokens(sync);
    assert.equal(sync.claimWaiting(), true);
    await sync.runClaim();
    assert.deepEqual(auth.calls, [['claim', { access_token: 'a', refresh_token: 'r' }]]);
    assert.equal(store.syncStatus().workspace, oldWs);
    assert.equal(store.syncStatus().pending, 0, 'nothing uploads again');
    assert.equal(sync.claimWaiting(), false, 'the anonymous session is forgotten');
  } finally {
    done();
  }
});

test('combining uploads the library to the account, then retires the old workspace', async () => {
  const auth = fakeAuth({
    claim: () => ({ result: 'combine', workspace: accountWs, retire: oldWs }),
  });
  const { store, sync, done } = setup({ auth });
  try {
    keepTokens(sync);
    await sync.runClaim();
    assert.equal(store.syncStatus().rejoin, true, 'the account library is pulled first');
    store.syncRejoined();
    const status = store.syncStatus();
    assert.equal(status.workspace, accountWs);
    assert.equal(status.name, 'Anton');
    assert.ok(status.pending >= 2, 'the board and its note are queued for the account');
    assert.ok(!auth.calls.some((c) => c[0] === 'retire'), 'not before the upload');
    assert.equal(sync.claimWaiting(), true, 'the retire is remembered');

    const batch = store.syncTake({ limit: 500 });
    assert.ok(batch.entries.every((e) => e.workspace === accountWs));
    store.syncAck({ entries: batch.entries, dropped: batch.dropped, assets: [] });
    await sync.retireWhenUploaded();
    assert.deepEqual(auth.calls.at(-1), ['retire', oldWs, accountWs]);
    assert.equal(sync.claimWaiting(), false);
  } finally {
    done();
  }
});

test('with only shares synced, a combine queues just the shared boards', async () => {
  const auth = fakeAuth({ claim: () => ({ result: 'none', workspace: null }) });
  const { store, sync, board, done } = setup({ library: false, auth });
  try {
    const other = store.createBoard({ name: 'Private' });
    store.patchBoard({ id: other.id, revision: 0, upserts: [note('p1', 'private')] });
    store.syncOwned({ shares: [{ kind: 'board', targetId: board.id, shareId: 's1' }] });
    keepTokens(sync);
    await sync.runClaim();
    assert.deepEqual(auth.calls[1], ['personalWorkspace', 'Anton']);
    const ids = store.syncTake({ limit: 500 }).entries.map((e) => e.id);
    assert.ok(ids.includes(board.id) && ids.includes('n1'));
    assert.ok(!ids.includes(other.id) && !ids.includes('p1'), 'private boards stay private');
  } finally {
    done();
  }
});

test('a claim that fails offline keeps the newest anonymous session for later', async () => {
  const auth = fakeAuth({
    claim: () => {
      const e = new Error('Could not reach the server.');
      e.code = 'offline';
      e.tokens = { access_token: 'a2', refresh_token: 'r2' };
      throw e;
    },
  });
  const { sync, done } = setup({ auth });
  try {
    keepTokens(sync);
    await assert.rejects(sync.runClaim(), /Could not reach/);
    assert.deepEqual(JSON.parse(sync.vault.getItem('terra-cloud-anonymous')), {
      access_token: 'a2',
      refresh_token: 'r2',
    });
  } finally {
    done();
  }
});

test('turning sync off keeps the account; signing out keeps the boards', async () => {
  const { store, sync, auth, board, done } = setup();
  try {
    await sync.disable();
    assert.equal(store.syncStatus().identity, false);
    assert.ok(!auth.calls.some((c) => c[0] === 'signOut'), 'still signed in');

    store.syncIdentity({ workspace: oldWs, name: 'Anton' });
    sync.makeClient = () => {};
    const status = await sync.signOut();
    assert.deepEqual(auth.calls.at(-1), ['signOut', { device }]);
    assert.equal(status.account.state, 'signedOut');
    assert.equal(store.syncStatus().identity, false);
    assert.ok(
      store.library().boards.some((b) => b.id === board.id),
      'own boards stay',
    );
  } finally {
    done();
  }
});

test('pulls skip only what this computer pushed, not the account other computers', async () => {
  const { store, sync, board, done } = setup();
  try {
    sync.userId = 'account';
    sync.workspace = oldWs;
    const row = (id, text, extra) => ({
      kind: 'object',
      board_id: board.id,
      id,
      data: note(id, text),
      deleted: false,
      ...extra,
    });
    const rows = [
      {
        ...row('n1', 'from this computer', { updated_by: 'account', updated_device: device }),
        seq: 10,
      },
      {
        ...row('n2', 'from my laptop', { updated_by: 'account', updated_device: 'laptop' }),
        seq: 11,
      },
      {
        ...row('n3', 'from a 0.1.28 computer', { updated_by: 'anon', updated_device: null }),
        seq: 12,
      },
    ];
    let served = false;
    const query = {
      select: () => query,
      eq: () => query,
      gt: () => query,
      order: () => query,
      limit: () => query,
      in: () => query,
      then: (resolve) => {
        resolve({ data: served ? [] : rows, error: null });
        served = true;
      },
    };
    sync.client = { from: () => query };
    await sync.pull(oldWs);
    const objects = Object.fromEntries(
      store.loadBoard({ id: board.id }).objects.map((o) => [o.id, o.text]),
    );
    assert.equal(objects.n1, 'hello', 'own push is not applied again');
    assert.equal(objects.n2, 'from my laptop');
    assert.equal(objects.n3, 'from a 0.1.28 computer');
    assert.equal(store.syncStatus().cursor, 12);
  } finally {
    done();
  }
});
