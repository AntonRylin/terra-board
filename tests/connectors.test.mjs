import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionPoint, connectorDot, facingSide, sidePoint } from '../src/canvas/connectors.ts';

const box = { id: 'b', type: 'rect', x: 100, y: 50, width: 200, height: 100, z: 1 };

test('connector dots float outside the middle of each side at a fixed screen gap', () => {
  assert.deepEqual(connectorDot(box, 'n', 1), { x: 200, y: 28 });
  assert.deepEqual(connectorDot(box, 'e', 2), { x: 311, y: 100 });
  assert.deepEqual(connectorDot(box, 's', 1), { x: 200, y: 172 });
  assert.deepEqual(connectorDot(box, 'w', 1), { x: 78, y: 100 });
  // A name drawn above the object pushes the top dot past it.
  assert.deepEqual(connectorDot(box, 'n', 1, -30), { x: 200, y: -2 });
});

test('connections land on the side facing where the arrow comes from', () => {
  assert.equal(facingSide(box, { x: 200, y: -400 }), 'n');
  assert.equal(facingSide(box, { x: 900, y: 120 }), 'e');
  assert.equal(facingSide(box, { x: 180, y: 600 }), 's');
  assert.equal(facingSide(box, { x: -300, y: 90 }), 'w');
  // A tall card is approached from the left even when its top is nearer.
  const tall = { ...box, x: 300, y: 0, width: 120, height: 1200 };
  assert.equal(facingSide(tall, { x: 100, y: 250 }), 'w');
  const turned = { ...box, rotation: 90 };
  const top = sidePoint(turned, 'n');
  assert.ok(Math.abs(top.x - 250) < 1e-9 && Math.abs(top.y - 100) < 1e-9);
});

test('arrow ends land level with the drop, snapping to the side middle nearby', () => {
  const tall = { id: 't', type: 'paper', x: 300, y: 0, width: 120, height: 1200, z: 1 };
  assert.deepEqual(connectionPoint(tall, 'w', { x: 330, y: 250 }, 48), { x: 300, y: 250 });
  assert.deepEqual(connectionPoint(tall, 'w', { x: 330, y: 570 }, 48), { x: 300, y: 600 });
  assert.deepEqual(connectionPoint(tall, 'n', { x: 900, y: 10 }, 48), { x: 420, y: 0 });
});
