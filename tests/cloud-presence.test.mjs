import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CloudSync } = require('../electron/cloud-sync.cjs');

const tick = () => new Promise((r) => setTimeout(r, 5));

// Behaves like @supabase/realtime-js: one channel per topic, presence callbacks
// only before subscribing, removal finishes after the server answers.
function fakeRealtime() {
  const channels = [];
  const client = {
    channels,
    authorized: 0,
    realtime: {
      async setAuth() {
        client.authorized++;
      },
    },
    channel(topic, options = {}) {
      const existing = channels.find((c) => c.topic === topic);
      if (existing) return existing;
      const c = {
        topic,
        options,
        state: 'closed',
        tracked: null,
        handlers: [],
        on(type, filter, callback) {
          if (type === 'presence' && this.state !== 'closed')
            throw Error(`cannot add presence callbacks for ${topic} after subscribe()`);
          this.handlers.push({ type, filter, callback });
          return this;
        },
        subscribe(callback) {
          this.state = 'joining';
          setTimeout(() => {
            if (this.state !== 'joining') return;
            this.state = 'joined';
            void callback?.('SUBSCRIBED');
          }, 2);
          return this;
        },
        async track(info) {
          this.tracked = info;
        },
        async untrack() {
          this.tracked = null;
        },
        presenceState: () => ({}),
        send() {},
      };
      channels.push(c);
      return c;
    },
    async removeChannel(c) {
      c.state = 'leaving';
      await tick();
      c.state = 'closed';
      channels.splice(channels.indexOf(c), 1);
    },
  };
  return client;
}

function sync({ boards = [{ id: 'b1', folderId: null }], sharing } = {}) {
  const s = new CloudSync({
    call: async (command) => {
      if (command === 'library')
        return { boards, sharing: sharing || { boards: { b1: { shared: 'owner' } }, folders: {} } };
      if (command === 'syncProfile') return { avatarVersion: 0, songVersion: 0 };
      throw Error('unexpected ' + command);
    },
    root: '.',
    config: null,
  });
  s.client = fakeRealtime();
  s.workspace = 'ws-me';
  s.userId = 'user-me';
  s.status.name = 'Me';
  return s;
}

test('rejoining a board right after joining still announces this person', async () => {
  const s = sync();
  // What the board view does on start: join, then rejoin when sharing loads.
  const first = s.joinBoard('b1');
  const leave = s.leaveBoard();
  const second = s.joinBoard('b1');
  await Promise.all([first.catch((e) => e), leave, second]);
  await tick();
  await tick();
  const live = s.client.channels.filter((c) => c.topic === 'board:b1');
  assert.equal(live.length, 1);
  assert.equal(s.board?.channel, live[0]);
  assert.equal(live[0].tracked?.person, 'ws-me');
});

test('joining the same board again updates the announcement in place', async () => {
  const s = sync();
  await s.joinBoard('b1');
  await tick();
  const channel = s.board.channel;
  assert.equal(channel.tracked?.role, 'edit');
  await s.joinBoard('b1');
  await tick();
  assert.equal(s.board.channel, channel);
  assert.equal(channel.tracked?.person, 'ws-me');
});

test('a board joined before sync has started is joined once it starts', async () => {
  const s = sync();
  s.workspace = null;
  assert.deepEqual(await s.joinBoard('b1'), { active: false });
  s.workspace = 'ws-me';
  await s.rejoin();
  await tick();
  assert.equal(s.board?.boardId, 'b1');
  assert.equal(s.board.channel.tracked?.person, 'ws-me');
});

test('losing access to a board leaves its presence', async () => {
  const sharing = { boards: { b1: { shared: 'edit', owner: 'Sam' } }, folders: {} };
  const s = sync({ sharing });
  await s.joinBoard('b1');
  await tick();
  assert.equal(s.board?.role, 'edit');
  sharing.boards = {};
  assert.deepEqual(await s.joinBoard('b1'), { active: false });
  assert.equal(s.board, null);
  assert.equal(s.client.channels.length, 0);
});

test('board and workspace channels are private and carry the session token', async () => {
  const s = sync();
  await s.joinBoard('b1');
  s.listen('ws-me');
  await tick();
  for (const topic of ['board:b1', 'terra:ws-me']) {
    const c = s.client.channels.find((x) => x.topic === topic);
    assert.equal(c.options.config?.private, true, topic);
    assert.equal(c.state, 'joined', topic);
  }
  assert.ok(s.client.authorized >= 2);
});

test('presence says whether this person owns the board', async () => {
  const events = [];
  const owned = sync();
  owned.onPresence = (e) => events.push(e);
  await owned.joinBoard('b1');
  await tick();
  assert.equal(owned.board.owner, true);
  const received = sync({ sharing: { boards: { b1: { shared: 'view' } }, folders: {} } });
  await received.joinBoard('b1');
  await tick();
  assert.equal(received.board.owner, false);
  assert.equal(received.board.channel.tracked.role, 'view');
});

test('cursors are only sent while someone else is on the board', async () => {
  const s = sync();
  await s.joinBoard('b1');
  await tick();
  const channel = s.board.channel,
    sent = [];
  channel.send = (message) => sent.push(message);
  const here = { 'user-me': [{ person: 'ws-me' }] };
  channel.presenceState = () => here;
  s.sendCursor({ x: 1, y: 2, view: null });
  assert.equal(sent.length, 0);
  here['user-sam'] = [{ person: 'ws-sam' }];
  s.sendCursor({ x: 1, y: 2, view: null });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.key, 'user-me');
});

test('the shares covering a board include its folder share', () => {
  const s = sync();
  s.status.shared = [
    { shareId: 's-board', kind: 'board', targetId: 'b1', people: 1 },
    { shareId: 's-folder', kind: 'folder', targetId: 'f1', people: 1 },
    { shareId: 's-other', kind: 'folder', targetId: 'f2', people: 1 },
  ];
  assert.deepEqual(
    s.sharesCovering({ id: 'b1', folderId: 'f1' }).map((x) => x.shareId),
    ['s-board', 's-folder'],
  );
});
