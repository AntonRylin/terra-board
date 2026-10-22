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
const friendWs = '99999999-8888-4777-8666-555555555555';
const note = (id, text) => ({ id, type: 'note', x: 0, y: 0, width: 200, height: 160, text, z: 1 });

// The server after the owner took the friend's access away: nothing is shared
// with them, and edits to the owner's workspace are refused.
function revokedServer(calls) {
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
    rpc: async (name, args) => {
      calls.push(name);
      if (name === 'my_shares' || name === 'shared_with_me') return { data: [], error: null };
      if (name === 'push_entities' && args.p_workspace === ownerWs)
        return { data: null, error: { message: 'You cannot edit this workspace', code: '42501' } };
      return { data: 0, error: null };
    },
    from: () => query,
    channel: () => ({ on: () => ({ subscribe() {}, send() {} }) }),
    removeChannel: async () => {},
    realtime: { setAuth: async () => {} },
    auth: { stopAutoRefresh() {} },
  };
}

test('a revoked board with unsent edits disappears on the next sync', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-revoke-'));
  const store = new Store(root);
  const calls = [];
  const sync = new CloudSync({
    call: async (command, args) => store[command](args),
    root,
    config: null,
    transaction: (job) => job(),
  });
  try {
    store.syncIdentity({ workspace: friendWs });
    store.syncApply({
      workspace: ownerWs,
      cursor: 2,
      roles: { folders: {}, boards: { 'b-shared': { role: 'edit', owner: 'Anton' } } },
      rows: [
        {
          kind: 'board',
          board_id: '',
          id: 'b-shared',
          data: { name: 'Shared', icon: 'none', color: 'blue', position: 1, trashed: false },
          seq: 1,
        },
        { kind: 'object', board_id: 'b-shared', id: 'n1', data: note('n1', 'from Anton'), seq: 2 },
      ],
    });
    // Edited while the friend was offline, after the owner revoked access.
    store.patchBoard({ id: 'b-shared', revision: 1, upserts: [note('n1', 'friend edit')] });
    sync.client = revokedServer(calls);
    sync.workspace = friendWs;
    sync.userId = 'friend';
    await sync.run();
    assert.equal(sync.status.state, 'synced', String(sync.status.error));
    assert.ok(!store.library().boards.some((b) => b.id === 'b-shared'));
    assert.ok(!calls.includes('push_entities'), 'the refused edits were never sent');
  } finally {
    sync.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
