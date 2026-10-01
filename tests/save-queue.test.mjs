import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaveQueue } from '../src/canvas/save-queue.ts';
const o = { id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 80, z: 0, text: 'First' };
test('save queue combines pending edits and uses increasing revisions', async () => {
  const calls = [],
    states = [];
  const q = new SaveQueue(
    'board',
    3,
    (s) => states.push(s),
    async (args) => {
      calls.push(args);
      return { revision: args.revision + 1 };
    },
  );
  q.enqueue({ upserts: [o], deleted: [] });
  q.enqueue({ upserts: [{ ...o, text: 'Final' }], deleted: [] }, { x: 5, y: 8, zoom: 0.7 });
  await q.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].upserts[0].text, 'Final');
  assert.equal(calls[0].camera.zoom, 0.7);
  q.enqueue({ upserts: [], deleted: ['a'] });
  await q.flush();
  assert.equal(calls[1].revision, 4);
  assert.equal(states.at(-1), 'saved');
});
test('retry preserves the failed operation id and does not mix later edits into it', async () => {
  const calls = [];
  let fail = true;
  const q = new SaveQueue(
    'board',
    0,
    () => {},
    async (args) => {
      calls.push(structuredClone(args));
      if (fail) {
        fail = false;
        throw Error('Lost acknowledgement');
      }
      return { revision: args.revision + 1 };
    },
  );
  q.enqueue({ upserts: [o], deleted: [] });
  await assert.rejects(q.flush());
  q.enqueue({ upserts: [{ ...o, text: 'Later' }], deleted: [] });
  await q.flush();
  assert.equal(calls[0].operationId, calls[1].operationId);
  assert.equal(calls[1].upserts[0].text, 'First');
  assert.equal(calls[2].upserts[0].text, 'Later');
  assert.equal(calls[2].revision, 1);
});
test('flush waits for changes queued while a disk write is running', async () => {
  let release;
  const gate = new Promise((r) => (release = r)),
    calls = [];
  const q = new SaveQueue(
    'board',
    0,
    () => {},
    async (args) => {
      calls.push(args);
      if (calls.length === 1) await gate;
      return { revision: args.revision + 1 };
    },
  );
  q.enqueue({ upserts: [o], deleted: [] });
  const pending = q.flush();
  q.enqueue({ upserts: [{ ...o, text: 'While writing' }], deleted: [] });
  release();
  await pending;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].revision, 1);
});
