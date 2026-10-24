import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveSender,
  LiveReceiver,
  Glides,
  between,
  FRAME_MS,
  LAND_MS,
  LIVE_HOLD_MS,
  MOVING_HOLD_MS,
} from '../src/canvas/live-edits.ts';

const note = (id, extra = {}) => ({
  id,
  type: 'note',
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  z: 1,
  text: id,
  ...extra,
});
const image = (id, assetId, extra = {}) => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  z: 2,
  assetId,
  ...extra,
});

// A clock, timers and screen frames the test moves by hand.
function clock() {
  let now = 0;
  const jobs = new Map();
  let frames = [];
  let next = 1;
  return {
    now: () => now,
    setTimeout: (job, ms) => {
      const id = next++;
      jobs.set(id, { job, at: now + ms });
      return id;
    },
    clearTimeout: (id) => jobs.delete(id),
    frame: (job) => {
      const id = next++;
      frames.push({ id, job });
      return id;
    },
    cancelFrame: (id) => {
      frames = frames.filter((f) => f.id !== id);
    },
    // Moves time on, drawing a screen frame every 16 ms.
    advance(ms) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 16);
        for (const [id, j] of [...jobs].sort((a, b) => a[1].at - b[1].at))
          if (j.at <= now) {
            jobs.delete(id);
            j.job();
          }
        const due = frames;
        frames = [];
        for (const f of due) f.job();
      }
    },
  };
}

// The board as LiveReceiver sees it, with what it was asked to do.
function board(objects) {
  const map = new Map(objects.map((o) => [o.id, o]));
  const busy = new Set();
  const log = [];
  // Where each accepted object was just before the edit (what undo returns to).
  const before = [];
  return {
    map,
    busy,
    log,
    before,
    target: {
      get: (id) => map.get(id),
      show: (list) => {
        log.push(['show', list.map((o) => o.id)]);
        for (const o of list) if (map.has(o.id)) map.set(o.id, o);
      },
      accept: (edit) => {
        log.push(['accept', edit.upserts.map((o) => o.id), edit.deleted]);
        for (const o of edit.upserts) before.push([o.id, map.get(o.id)?.x]);
        for (const o of edit.upserts) map.set(o.id, o);
        for (const id of edit.deleted) map.delete(id);
      },
      busy: (id) => busy.has(id),
    },
  };
}

test('an edit is sent at once; a drag at most every 50 ms, ending with done', () => {
  const t = clock();
  const sent = [];
  const sender = new LiveSender((m) => sent.push(m), t);
  sender.edit({ upserts: [note('a')], deleted: ['b'] });
  assert.deepEqual(sent, [{ kind: 'edit', upserts: [note('a')], deleted: ['b'] }]);

  sent.length = 0;
  sender.moving([note('a', { x: 1 })]);
  sender.moving([note('a', { x: 2 })]);
  sender.moving([note('a', { x: 3 })]);
  assert.equal(sent.length, 1, 'the first frame goes straight away');
  t.advance(FRAME_MS);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].objects[0].x, 3, 'frames in between give way to the newest');
  sender.edit({ upserts: [note('a', { x: 4 })], deleted: [] });
  sender.moving(null);
  assert.deepEqual(
    sent.slice(2).map((m) => m.kind + (m.done ? ':done' : '')),
    ['edit', 'moving:done'],
    'where the objects landed comes before the end of the drag',
  );
});

test('a frame waiting when the edit is sent is dropped', () => {
  const t = clock();
  const sent = [];
  const sender = new LiveSender((m) => sent.push(m), t);
  sender.moving([note('a', { x: 1 })]);
  sender.moving([note('a', { x: 2 })]);
  sender.edit({ upserts: [note('a', { x: 2 })], deleted: [] });
  t.advance(FRAME_MS * 2);
  assert.deepEqual(
    sent.map((m) => m.kind),
    ['moving', 'edit'],
  );
});

test('a gesture that sent no frame ends without a message, and big edits wait for sync', () => {
  const sent = [];
  const sender = new LiveSender((m) => sent.push(m), clock());
  sender.moving(null);
  sender.edit({ upserts: [], deleted: [] });
  const many = Array.from({ length: 300 }, (_, i) => note('n' + i));
  sender.edit({ upserts: many, deleted: [] });
  sender.edit({ upserts: [note('big', { text: 'x'.repeat(200_000) })], deleted: [] });
  sender.moving(many);
  assert.deepEqual(sent, []);
});

test('an edit from elsewhere is shown, and an object bringing a new picture waits for sync', () => {
  const t = clock();
  const b = board([note('a'), image('i', 'f1')]);
  const live = new LiveReceiver(b.target, t);
  live.receive('pc', {
    kind: 'edit',
    upserts: [note('a', { x: 50 }), image('i', 'f1', { x: 9 }), image('new', 'f2'), note('n')],
    deleted: [],
  });
  assert.deepEqual(b.log[0], ['accept', ['a', 'i', 'n'], []]);
  assert.equal(b.map.has('new'), false);
  t.advance(LAND_MS + 16);
  assert.equal(b.map.get('a').x, 50);

  b.log.length = 0;
  live.receive('pc', { kind: 'edit', upserts: [image('i', 'f3')], deleted: ['gone', 'n'] });
  assert.deepEqual(b.log, [['accept', [], ['n']]], 'a changed picture and unknown ids wait');
});

test('what is being changed here is left alone', () => {
  const t = clock();
  const b = board([note('a'), note('b')]);
  b.busy.add('a');
  const live = new LiveReceiver(b.target, t);
  live.receive('pc', {
    kind: 'edit',
    upserts: [note('a', { x: 5 }), note('b', { x: 5 })],
    deleted: [],
  });
  live.receive('pc', { kind: 'moving', objects: [note('a', { x: 9 })] });
  t.advance(200);
  assert.deepEqual(b.log[0], ['accept', ['b'], []]);
  assert.equal(b.map.get('a').x, 0);
  assert.equal(b.map.get('b').x, 5);
});

test('a drag from elsewhere glides frame by frame and lands where the edit says', () => {
  const t = clock();
  const b = board([note('a')]);
  const live = new LiveReceiver(b.target, t);
  live.receive('pc', { kind: 'moving', objects: [note('a', { x: 10 })] });
  t.advance(16);
  const early = b.map.get('a').x;
  assert.ok(early > 0 && early < 10, `part of the way after one frame (${early})`);
  t.advance(200);
  assert.equal(b.map.get('a').x, 10);
  live.receive('pc', { kind: 'moving', objects: [note('a', { x: 20 })] });
  t.advance(200);
  assert.equal(b.map.get('a').x, 20);

  live.receive('pc', { kind: 'edit', upserts: [note('a', { x: 25 })], deleted: [] });
  assert.deepEqual(b.before, [['a', 0]], 'undo here goes back to before the drag');
  assert.deepEqual(b.log.slice(-3), [
    ['show', ['a']],
    ['accept', ['a'], []],
    ['show', ['a']],
  ]);
  assert.equal(b.map.get('a').x, 20, 'it glides on from where it was on screen');
  t.advance(LAND_MS + 16);
  assert.equal(b.map.get('a').x, 25);
  live.receive('pc', { kind: 'moving', objects: [], done: true });
  assert.equal(b.map.get('a').x, 25, 'the end of the drag does not undo where it landed');
});

test('drag frames 50 ms apart become steady motion, without jumps', () => {
  const t = clock();
  const b = board([note('a')]);
  const live = new LiveReceiver(b.target, t);
  const drawn = [];
  const show = b.target.show;
  b.target.show = (list) => {
    show(list);
    drawn.push(b.map.get('a').x);
  };
  for (let i = 1; i <= 20; i++) {
    live.receive('pc', { kind: 'moving', objects: [note('a', { x: i * 10 })] });
    t.advance(FRAME_MS);
  }
  t.advance(300);
  assert.equal(b.map.get('a').x, 200);
  const steps = drawn.slice(1).map((x, i) => x - drawn[i]);
  assert.ok(
    steps.every((s) => s >= 0),
    'it never goes backwards',
  );
  // A frame jumps 10; drawn every 16 ms, each step is about a third of that.
  assert.ok(Math.max(...steps.slice(3, -3)) < 6, `largest step ${Math.max(...steps)}`);
  assert.ok(drawn.length > 50, `drawn ${drawn.length} times`);
});

test('a drag that is cancelled, or whose end never comes, goes back', () => {
  const t = clock();
  const b = board([note('a'), note('b')]);
  const live = new LiveReceiver(b.target, t);
  live.receive('pc', { kind: 'moving', objects: [note('a', { x: 10 })] });
  t.advance(200);
  assert.equal(b.map.get('a').x, 10);
  live.receive('pc', { kind: 'moving', objects: [], done: true });
  assert.equal(b.map.get('a').x, 0);

  live.receive('phone', { kind: 'moving', objects: [note('b', { x: 10 })] });
  t.advance(MOVING_HOLD_MS - 300);
  assert.equal(b.map.get('b').x, 10);
  t.advance(MOVING_HOLD_MS);
  assert.equal(b.map.get('b').x, 0);
});

test('an edit made here stops a glide from elsewhere', () => {
  const t = clock();
  const b = board([note('a')]);
  const live = new LiveReceiver(b.target, t);
  live.receive('pc', { kind: 'edit', upserts: [note('a', { x: 100 })], deleted: [] });
  t.advance(32);
  live.local({ upserts: [note('a', { x: 5 })], deleted: [] });
  const shown = b.log.length;
  t.advance(LAND_MS);
  assert.equal(b.log.length, shown, 'nothing is drawn over the edit made here');
});

test('an older stored copy does not undo an edit that arrived live', () => {
  const t = clock();
  const b = board([note('a'), note('b'), note('c')]);
  const live = new LiveReceiver(b.target, t);
  live.receive('pc', {
    kind: 'edit',
    upserts: [note('a', { x: 7 }), note('new')],
    deleted: ['c'],
  });
  // Sync brings the board from before that edit.
  const stored = [note('a'), note('b'), note('c')];
  const merged = live.merge(stored);
  assert.deepEqual(merged.map((o) => [o.id, o.x]).sort(), [
    ['a', 7],
    ['b', 0],
    ['new', 0],
  ]);
  assert.equal(b.map.get('a').x, 7, 'a glide under way ends where it was going');
  // Then the stored copy catches up (keys in another order); later copies are taken as they are.
  const caughtUp = [{ ...note('a', { x: 7 }) }, note('b'), note('new')].map((o) =>
    Object.fromEntries(Object.entries(o).reverse()),
  );
  assert.equal(live.merge(caughtUp), caughtUp);
  const later = [note('a', { x: 99 }), note('b'), note('new')];
  assert.equal(live.merge(later), later);
});

test('live edits give way to the stored copy after a while, and to edits made here', () => {
  const t = clock();
  const b = board([note('a'), note('b')]);
  const live = new LiveReceiver(b.target, t);
  live.receive('pc', {
    kind: 'edit',
    upserts: [note('a', { x: 7 }), note('b', { x: 7 })],
    deleted: [],
  });
  live.local({ upserts: [note('b', { x: 1 })], deleted: [] });
  const stored = [note('a'), note('b', { x: 1 })];
  assert.deepEqual(
    live.merge(stored).map((o) => o.x),
    [7, 1],
  );
  t.advance(LIVE_HOLD_MS + 1);
  assert.equal(live.merge(stored), stored);
});

test('a stored copy arriving mid-drag puts the drag back to its start', () => {
  const t = clock();
  const b = board([note('a')]);
  const live = new LiveReceiver(b.target, t);
  live.receive('pc', { kind: 'moving', objects: [note('a', { x: 10 })] });
  t.advance(32);
  const stored = [note('a')];
  assert.equal(live.merge(stored), stored);
  assert.equal(b.map.get('a').x, 0);
  t.advance(200);
  assert.equal(b.map.get('a').x, 0, 'the glide does not carry on');
});

test('a newer stored copy (an AI edit) is taken as it is and ends what was held', () => {
  const t = clock();
  const b = board([note('a')]);
  const live = new LiveReceiver(b.target, t);
  live.receive('pc', { kind: 'edit', upserts: [note('a', { x: 7 })], deleted: [] });
  live.receive('pc', { kind: 'moving', objects: [note('a', { x: 9 })] });
  const ai = [note('a', { text: 'rewritten' })];
  assert.equal(live.settle(ai), ai);
  assert.equal(b.map.get('a').x, 7, 'the drag went back to where it started');
  const older = [note('a')];
  assert.equal(live.merge(older), older, 'nothing is held any more');
});

test('objects turn the short way round, and arrows bend point by point', () => {
  const a = note('a', { rotation: 350 });
  assert.equal(between(a, note('a', { rotation: 10 }), 0.5).rotation, 0);
  const arrow = (points) => ({
    id: 'r',
    type: 'arrow',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    z: 1,
    arrow: { points, line: 'straight', start: 'none', end: 'arrow', dash: 'solid', thickness: 2 },
  });
  const half = between(
    arrow([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]),
    arrow([
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ]),
    0.5,
  );
  assert.deepEqual(half.arrow.points, [
    { x: 0, y: 0.5 },
    { x: 1, y: 0.5 },
  ]);
});

test('cursors glide between the positions that arrive', () => {
  let now = 0;
  const cursors = new Glides(100, () => now);
  cursors.set('sam', { x: 0, y: 0 });
  assert.deepEqual(cursors.at('sam'), { x: 0, y: 0 }, 'the first position shows at once');
  now = 100;
  cursors.set('sam', { x: 100, y: 50 });
  now = 160;
  const mid = cursors.at('sam');
  assert.ok(mid.x > 20 && mid.x < 80, `part of the way (${mid.x})`);
  now = 400;
  assert.deepEqual(cursors.at('sam'), { x: 100, y: 50 });
  // A new position starts from where the cursor is drawn, not where it was sent.
  now = 450;
  cursors.set('sam', { x: 200, y: 50 });
  assert.deepEqual(cursors.at('sam'), { x: 100, y: 50 });
  assert.equal(cursors.at('kim'), null);
});
