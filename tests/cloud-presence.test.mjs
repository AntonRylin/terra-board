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
          this.status = callback;
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

function sync({ boards = [{ id: 'b1', folderId: null }], sharing, commands = {} } = {}) {
  const s = new CloudSync({
    call: async (command, args) => {
      if (command in commands) return commands[command](args);
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
  s.userId = 'account-me';
  // Presence is per computer: all computers of an account are one user.
  s.deviceId = 'user-me';
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

// --- Live edits ('edits:<board id>') ------------------------------------------

const others = (channel) => {
  channel.presenceState = () => ({ 'user-me': [{}], 'user-sam': [{}] });
};
const editsOf = (s, board = 'b1') => s.client.channels.find((c) => c.topic === 'edits:' + board);
const hear = (channel, payload) =>
  channel.handlers
    .find((h) => h.type === 'broadcast' && h.filter.event === 'edit')
    .callback({ payload });

test('a board is joined with a private edits channel, left with it', async () => {
  const s = sync();
  await s.joinBoard('b1');
  await tick();
  const edits = editsOf(s);
  assert.equal(edits.options.config.private, true);
  assert.equal(edits.options.config.broadcast.self, false);
  assert.equal(s.board.edits.subscribed, true);
  await s.leaveBoard();
  await tick();
  await tick();
  assert.equal(editsOf(s), undefined);
});

test('edits are sent only by editors, only for the open board, only with someone there', async () => {
  const s = sync();
  await s.joinBoard('b1');
  await tick();
  const sent = [];
  editsOf(s).send = (m) => sent.push(m);
  const edit = { boardId: 'b1', kind: 'edit', upserts: [{ id: 'n1' }], deleted: ['n2'] };
  s.sendEdit(edit);
  assert.equal(sent.length, 0, 'nobody else is here');
  others(s.board.channel);
  s.sendEdit(edit);
  s.sendEdit({ ...edit, boardId: 'b2' });
  s.sendEdit({ boardId: 'b1', kind: 'moving', objects: [{ id: 'n1' }] });
  s.sendEdit({ boardId: 'b1', kind: 'edit', upserts: [{ text: 'x'.repeat(300000) }], deleted: [] });
  assert.deepEqual(
    sent.map((m) => m.payload),
    [
      { key: 'user-me', kind: 'edit', upserts: [{ id: 'n1' }], deleted: ['n2'] },
      { key: 'user-me', kind: 'moving', objects: [{ id: 'n1' }], done: false },
    ],
  );
  assert.ok(sent.every((m) => m.type === 'broadcast' && m.event === 'edit'));

  const viewer = sync({ sharing: { boards: { b1: { shared: 'view' } }, folders: {} } });
  await viewer.joinBoard('b1');
  await tick();
  others(viewer.board.channel);
  const viewerSent = [];
  editsOf(viewer).send = (m) => viewerSent.push(m);
  viewer.sendEdit(edit);
  assert.equal(viewerSent.length, 0);
});

test('a server without live edits refuses the channel once; a dropped connection keeps it', async () => {
  const s = sync();
  await s.joinBoard('b1');
  await tick();
  const edits = editsOf(s);
  edits.status('CHANNEL_ERROR', Error('socket closed: 1006'));
  assert.ok(s.board.edits, 'it rejoins by itself');
  edits.status('SUBSCRIBED');
  edits.status(
    'CHANNEL_ERROR',
    Error('Unauthorized: You do not have permissions to read from this Channel topic: edits:b1'),
  );
  assert.equal(s.board.edits, null);
  await tick();
  assert.equal(editsOf(s), undefined);
  others(s.board.channel);
  s.sendEdit({ boardId: 'b1', kind: 'edit', upserts: [], deleted: ['n1'] });
});

test('edits that arrive are checked by the store, in order, skipping overtaken drag frames', async () => {
  const checked = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const s = sync({
    commands: {
      async syncLiveObjects({ objects, deleted }) {
        checked.push(objects.map((o) => o.x ?? o.id));
        await gate;
        return { objects: objects.filter((o) => o.valid !== false), deleted };
      },
    },
  });
  const events = [];
  s.onPresence = (e) => e.type !== 'people' && events.push(e);
  await s.joinBoard('b1');
  await tick();
  const edits = editsOf(s);
  hear(edits, { key: 'sam', kind: 'moving', objects: [{ id: 'a', x: 1 }] });
  hear(edits, { key: 'sam', kind: 'moving', objects: [{ id: 'a', x: 2 }] });
  hear(edits, { key: 'sam', kind: 'moving', objects: [{ id: 'a', x: 3 }] });
  hear(edits, {
    key: 'sam',
    kind: 'edit',
    upserts: [
      { id: 'a', x: 4 },
      { id: 'bad', valid: false },
    ],
    deleted: ['c'],
  });
  hear(edits, { key: 'sam', kind: 'moving', objects: [], done: true });
  hear(edits, { key: 'sam', kind: 'nonsense' });
  hear(edits, null);
  release();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(checked, [[3], [4, 'bad']], 'frames 1 and 2 were overtaken before their turn');
  assert.deepEqual(
    events.map((e) => [
      e.type,
      e.key,
      e.objects?.map((o) => o.x) ?? e.upserts.map((o) => o.x),
      e.done ?? e.deleted,
    ]),
    [
      ['moving', 'sam', [3], false],
      ['edit', 'sam', [4], ['c']],
      ['moving', 'sam', [], true],
    ],
  );
  assert.ok(events.every((e) => e.boardId === 'b1'));
});

test('a new role on the open board joins the edits channel again', async () => {
  const sharing = { boards: { b1: { shared: 'edit', owner: 'Sam' } }, folders: {} };
  const s = sync({ sharing });
  await s.joinBoard('b1');
  await tick();
  const first = editsOf(s);
  sharing.boards.b1.shared = 'view';
  await s.joinBoard('b1');
  await tick();
  await tick();
  assert.equal(s.board.role, 'view');
  assert.notEqual(s.board.edits.channel, first);
  assert.equal(s.client.channels.filter((c) => c.topic === 'edits:b1').length, 1);
});
