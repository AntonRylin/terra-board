import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameReference, findFrameUsages } from '../src/canvas/frame-usages.ts';
const source = { boardId: 'source-board', frameId: 'process-a' };
const frame = (id, text, x = 0, y = 0, width = 800, height = 500, z = 0) => ({
  id,
  type: 'frame',
  text,
  x,
  y,
  width,
  height,
  z,
});
const link = (id, x, y, reference = source) => ({
  ...frame(id, 'Process A', x, y, 100, 60, 5),
  frameLink: reference,
});
const doc = (id, name, objects, trashed = false) => ({ board: { id, name, trashed }, objects });

test('each direct insertion is listed separately across boards, with occurrence numbers', () => {
  const results = findFrameUsages(source, [
    doc('b', 'Workflows', [
      frame('b', 'Process B'),
      link('b-1', 30, 30),
      link('b-2', 200, 30),
      link('b-3', 350, 30),
    ]),
    doc('y', 'Other workflows', [frame('y', 'Process Y'), link('y-1', 30, 30)]),
  ]);
  assert.deepEqual(
    results.map((r) => [r.boardId, r.objectId, r.processName, r.occurrence, r.total]),
    [
      ['y', 'y-1', 'Process Y', 1, 1],
      ['b', 'b-1', 'Process B', 1, 3],
      ['b', 'b-2', 'Process B', 2, 3],
      ['b', 'b-3', 'Process B', 3, 3],
    ],
  );
});

test('reference identities exclude same-named originals, ordinary copies and trashed boards', () => {
  const results = findFrameUsages(source, [
    doc('source-board', 'Source', [frame('process-a', 'Process A'), link('same-board', 1000, 0)]),
    doc('b', 'Other', [
      link('wrong-board', 0, 0, { ...source, boardId: 'different' }),
      link('wrong-frame', 200, 0, { ...source, frameId: 'different' }),
      frame('copy', 'Process A'),
    ]),
    doc('trash', 'Deleted', [link('deleted', 0, 0)], true),
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].objectId, 'same-board');
  assert.equal(results[0].processName, 'On board canvas');
  assert.equal(results[0].processId, null);
});

test('nearest containing process and ancestor path distinguish nested frames', () => {
  const results = findFrameUsages(source, [
    doc('b', 'Nested', [
      frame('outer', 'Workflow'),
      frame('inner', 'Process B', 20, 20, 400, 300, 1),
      link('inside', 40, 40),
      link('outside-inner', 500, 30),
    ]),
  ]);
  assert.deepEqual(
    results.map((r) => [r.processId, r.processPath]),
    [
      ['outer', ['Workflow']],
      ['inner', ['Workflow', 'Process B']],
    ],
  );
});

test('rotated containing frames use actual geometry; linked frames cannot own occurrences', () => {
  const parent = { ...frame('rotated', 'Rotated process', 0, 0, 400, 400), rotation: Math.PI / 4 };
  const results = findFrameUsages(source, [
    doc('b', 'Board', [
      parent,
      { ...link('large-proxy', 1000, 0), width: 500, height: 300 },
      link('in-rotation', 150, 170),
      link('in-proxy', 1100, 60),
    ]),
  ]);
  assert.equal(results.find((r) => r.objectId === 'in-rotation').processId, 'rotated');
  assert.equal(results.find((r) => r.objectId === 'in-proxy').processId, null);
});

test('find usages from a linked instance targets its original', () => {
  assert.deepEqual(frameReference('b', link('instance', 0, 0)), source);
  assert.deepEqual(frameReference('source-board', frame('process-a', 'Process A')), source);
});
