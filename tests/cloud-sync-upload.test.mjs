import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CloudSync } = require('../electron/cloud-sync.cjs');
const { Store } = require('../electron/store.cjs');

const ownerWs = '11111111-2222-4333-8444-555555555555';

// A server that keeps the owner's shares and records every call.
function shareServer(calls) {
  const shares = [];
  let next = 1;
  const query = {
    select: () => query,
    eq: () => query,
    gt: () => query,
    in: () => query,
    order: () => query,
    range: () => query,
    limit: () => query,
    then: (resolve) => resolve({ data: [], error: null }),
  };
  return {
    shares,
    rpc: async (name, args) => {
      calls.push(name);
      if (name === 'create_share') {
        const id = `00000000-0000-4000-8000-00000000000${next++}`;
        shares.push({ share_id: id, kind: args.p_kind, target_id: args.p_target, people: 0 });
        return { data: id, error: null };
      }
      if (name === 'delete_share') {
        shares.splice(
          shares.findIndex((s) => s.share_id === args.p_share),
          1,
        );
        return { data: null, error: null };
      }
      if (name === 'my_shares') return { data: shares.map((s) => ({ ...s })), error: null };
      if (name === 'shared_with_me') return { data: [], error: null };
      return { data: 0, error: null };
    },
    from: () => query,
    channel: () => ({ on: () => ({ subscribe() {}, send() {} }) }),
    removeChannel: async () => {},
    realtime: { setAuth: async () => {} },
    auth: { stopAutoRefresh() {} },
  };
}

test('upload to cloud shares with nobody; stop sharing keeps it in the cloud', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-upload-'));
  const store = new Store(root);
  const calls = [];
  const sync = new CloudSync({
    call: async (command, args) => store[command](args),
    root,
    config: null,
    transaction: (job) => job(),
  });
  try {
    store.syncIdentity({ workspace: ownerWs });
    const board = store.createBoard({ name: 'Trip to Lisbon' });
    const server = shareServer(calls);
    sync.client = server;
    sync.auth = { account: async () => ({ state: 'signedIn', userId: 'u1' }) };
    sync.workspace = ownerWs;
    sync.userId = 'u1';

    await sync.uploadToCloud('board', board.id);
    assert.equal(server.shares.length, 1);
    assert.ok(!calls.includes('create_share_invite'), 'uploading invites nobody');
    assert.equal(store.library().sharing.boards[board.id]?.shared, 'owner');
    const first = sync.status.shared[0].shareId;

    // Uploading again changes nothing.
    await sync.uploadToCloud('board', board.id);
    assert.equal(calls.filter((c) => c === 'create_share').length, 1);

    // Stop sharing: the old share (with its people and codes) goes, a new empty one keeps
    // the board in the cloud.
    await sync.stopSharing(first);
    assert.equal(server.shares.length, 1);
    assert.notEqual(server.shares[0].share_id, first);
    assert.deepEqual(
      sync.status.shared.map((s) => s.targetId),
      [board.id],
    );
    assert.equal(store.library().sharing.boards[board.id]?.shared, 'owner');
  } finally {
    sync.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uploading needs an account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-upload-'));
  const store = new Store(root);
  const sync = new CloudSync({
    call: async (command, args) => store[command](args),
    root,
    config: null,
    transaction: (job) => job(),
  });
  try {
    sync.client = shareServer([]);
    sync.auth = { account: async () => ({ state: 'anonymous' }) };
    await assert.rejects(sync.uploadToCloud('board', 'b1'), /Sign in to upload/);
  } finally {
    sync.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
