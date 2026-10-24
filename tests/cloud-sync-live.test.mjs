// How soon changes travel: the store's check of live edits, and the order of a sync round
// (the others are told about an upload before this computer downloads).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CloudSync } = require('../electron/cloud-sync.cjs');
const { Store } = require('../electron/store.cjs');

const workspace = '11111111-2222-4333-8444-555555555555';
const note = (id, extra = {}) => ({
  id,
  type: 'note',
  x: 0,
  y: 0,
  width: 200,
  height: 160,
  z: 1,
  text: id,
  ...extra,
});

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-live-'));
  const store = new Store(root);
  return Promise.resolve(fn(store, root)).finally(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('live edits are checked like synced objects; nothing is written', () =>
  withStore((store) => {
    const board = store.createBoard({ name: 'Plan' });
    const before = store.loadBoard({ id: board.id });
    const checked = store.syncLiveObjects({
      objects: [note('a', { extra: 'dropped' }), { id: 'bad', type: 'note' }, note('b')],
      deleted: ['c', '', 7],
    });
    assert.deepEqual(
      checked.objects.map((o) => o.id),
      ['a', 'b'],
    );
    assert.equal(checked.objects[0].extra, undefined, 'unknown fields are left out');
    assert.deepEqual(checked.deleted, ['c']);
    assert.deepEqual(store.loadBoard({ id: board.id }), before);
    assert.throws(() => store.syncLiveObjects({ objects: 'x' }), /Invalid live edit/);
  }));

// A server that records what the sync round does, in order.
function recordingServer(log) {
  const query = () => {
    const q = {
      select: () => q,
      eq: () => q,
      gt: () => q,
      in: () => q,
      order: () => q,
      range: () => q,
      limit: () => q,
      then: (resolve) => {
        log.push('download');
        resolve({ data: [], error: null });
      },
    };
    return q;
  };
  return {
    rpc: async (name) => {
      if (name === 'push_entities') log.push('upload');
      if (name === 'my_shares' || name === 'shared_with_me') return { data: [], error: null };
      return { data: null, error: null };
    },
    from: () => query(),
    channel: () => {
      const channel = {
        on: () => channel,
        subscribe: () => channel,
        send: (message) => log.push('ping:' + message.event),
      };
      return channel;
    },
    removeChannel: async () => {},
    realtime: { setAuth: async () => {} },
    auth: { stopAutoRefresh() {} },
  };
}

test('a sync round tells the others about its upload before it downloads', () =>
  withStore(async (store, root) => {
    const log = [];
    const sync = new CloudSync({
      call: async (command, args) => store[command](args),
      root,
      config: null,
      transaction: (job) => job(),
    });
    try {
      store.syncEnable({ workspace });
      const board = store.createBoard({ name: 'Plan' });
      store.patchBoard({ id: board.id, revision: 0, upserts: [note('a')], deleted: [] });
      sync.client = recordingServer(log);
      sync.workspace = workspace;
      sync.userId = 'u1';
      sync.listen(workspace);
      await new Promise((r) => setTimeout(r, 5));
      await sync.run();
      assert.equal(sync.status.error, null);
      const upload = log.indexOf('upload');
      assert.ok(upload >= 0, 'something was uploaded');
      assert.equal(log[upload + 1], 'ping:pushed', 'the ping follows the upload');
      assert.ok(log.indexOf('download', upload) > upload + 1, 'downloading comes after');
    } finally {
      sync.stop();
    }
  }));

test('a change here is uploaded within half a second', () =>
  withStore(async (store, root) => {
    const sync = new CloudSync({
      call: async (command, args) => store[command](args),
      root,
      config: null,
      transaction: (job) => job(),
    });
    let ran = 0;
    sync.run = async () => {
      ran++;
    };
    sync.workspace = workspace;
    try {
      const started = Date.now();
      sync.localChanged();
      while (!ran && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 10));
      assert.ok(ran && Date.now() - started < 600, `uploaded after ${Date.now() - started} ms`);
    } finally {
      sync.stop();
    }
  }));
