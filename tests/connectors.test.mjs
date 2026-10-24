import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionPoint,
  connectorDot,
  dropSide,
  facingSide,
  sidePoint,
} from '../src/canvas/connectors.ts';

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

test('an arrow dropped near an edge lands on that side, in the middle on the facing side', () => {
  // The arrow comes from below right, so the bottom faces it…
  const from = { x: 700, y: 400 };
  assert.equal(dropSide(box, { x: 200, y: 100 }, from), 's');
  // …but a drop on the right part, or on the top, goes there.
  assert.equal(dropSide(box, { x: 290, y: 95 }, from), 'e');
  assert.equal(dropSide(box, { x: 285, y: 65 }, from), 'e');
  assert.equal(dropSide(box, { x: 200, y: 55 }, from), 'n');
  assert.equal(dropSide(box, { x: 110, y: 100 }, from), 'w');
});

test('arrow ends land level with the drop, snapping to the side middle nearby', () => {
  const tall = { id: 't', type: 'paper', x: 300, y: 0, width: 120, height: 1200, z: 1 };
  assert.deepEqual(connectionPoint(tall, 'w', { x: 330, y: 250 }, 48), { x: 300, y: 250 });
  assert.deepEqual(connectionPoint(tall, 'w', { x: 330, y: 570 }, 48), { x: 300, y: 600 });
  assert.deepEqual(connectionPoint(tall, 'n', { x: 900, y: 10 }, 48), { x: 420, y: 0 });
});

test('an arrow that would cut through its objects arcs around them instead', async () => {
  const { arrowEnd, followArrow, hasAutoBends, routedPoints } =
    await import('../src/canvas/connectors.ts');
  const { arrowFromPoints, arrowPath, arrowPoints } = await import('../src/canvas/arrows.ts');
  const { localToWorld } = await import('../src/canvas/transform.ts');
  // A wide card above, a box below it: both arrow ends on their right sides.
  const top = { id: 'top', type: 'rect', x: 314, y: 128, width: 521, height: 347, z: 1 },
    bottom = { id: 'bottom', type: 'rect', x: 517, y: 628, width: 261, height: 216, z: 1 };
  const objects = new Map([
    ['top', top],
    ['bottom', bottom],
  ]);
  const find = (id) => objects.get(id);
  const a = { x: 835, y: 300 },
    b = { x: 778, y: 735 };
  let arrow = arrowFromPoints({ id: 'r', type: 'arrow', x: 0, y: 0, width: 1, height: 1, z: 2 }, [
    a,
    b,
  ]);
  arrow.arrow = { ...arrow.arrow, from: arrowEnd(top, a), to: arrowEnd(bottom, b) };
  const points = routedPoints(arrow, a, b, find);
  assert.equal(points.length, 3);
  // The bend bulges out to the right, past both ends.
  assert.ok(points[1].x > 835, JSON.stringify(points));
  arrow = arrowFromPoints(arrow, points);
  const inside = (o, p) =>
    p.x > o.x + 1 && p.y > o.y + 1 && p.x < o.x + o.width - 1 && p.y < o.y + o.height - 1;
  for (const p of arrowPath(arrow).map((q) => localToWorld(arrow, q)))
    assert.ok(!inside(top, p) && !inside(bottom, p), JSON.stringify(p));
  assert.ok(hasAutoBends(arrow, find));

  // Moved, the arc is made afresh; once a straight line is clear, it straightens.
  objects.set('bottom', { ...bottom, x: 517, y: 1028 });
  const moved = followArrow(arrow, find);
  assert.equal(arrowPoints(moved).length, 3);
  assert.ok(hasAutoBends(moved, find));
  const west = { x: 517, y: 735 };
  let toWest = arrowFromPoints(arrow, [a, west]);
  toWest.arrow = { ...toWest.arrow, to: arrowEnd(bottom, west) };
  objects.set('bottom', bottom);
  toWest = arrowFromPoints(toWest, routedPoints(toWest, a, west, find));
  assert.equal(arrowPoints(toWest).length, 3);
  objects.set('bottom', { ...bottom, x: 1100 });
  assert.equal(arrowPoints(followArrow(toWest, find)).length, 2);

  // A bend the user placed is kept as it is.
  const bent = arrowFromPoints(arrow, [a, { x: 1200, y: 900 }, b]);
  assert.ok(!hasAutoBends(bent, find));
  assert.equal(arrowPoints(followArrow(bent, find)).length, 3);

  // Arrows between objects that face each other stay straight.
  const left = { ...top, id: 'left', x: 0, y: 0, width: 100, height: 100 },
    right = { ...top, id: 'right', x: 300, y: 0, width: 100, height: 100 };
  objects.set('left', left);
  objects.set('right', right);
  const across = arrowFromPoints(arrow, [
    { x: 100, y: 50 },
    { x: 300, y: 50 },
  ]);
  across.arrow = {
    ...across.arrow,
    from: arrowEnd(left, { x: 100, y: 50 }),
    to: arrowEnd(right, { x: 300, y: 50 }),
  };
  assert.equal(routedPoints(across, { x: 100, y: 50 }, { x: 300, y: 50 }, find).length, 2);
});

test('held arrow ends follow their objects as they move, resize and turn', async () => {
  const { arrowEnd, followArrow, keepArrowEnds, copyArrowEnds } =
    await import('../src/canvas/connectors.ts');
  const { arrowFromPoints, arrowPoints } = await import('../src/canvas/arrows.ts');
  const { localToWorld } = await import('../src/canvas/transform.ts');
  const a = { ...box, id: 'a' },
    b = { ...box, id: 'b', x: 600 };
  const start = sidePoint(a, 'e'),
    end = sidePoint(b, 'w');
  const arrow = arrowFromPoints({ id: 'r', type: 'arrow', x: 0, y: 0, width: 1, height: 1, z: 2 }, [
    start,
    { x: 450, y: 60 },
    end,
  ]);
  arrow.arrow = { ...arrow.arrow, from: arrowEnd(a, start), to: arrowEnd(b, end) };
  assert.deepEqual(arrow.arrow.from, { id: 'a', x: 1, y: 0.5 });
  const world = (o) => arrowPoints(o).map((p) => localToWorld(o, p));
  const near = (p, q) => assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 1e-6, JSON.stringify([p, q]));

  // Nothing moved: the same object comes back.
  const objects = new Map([
    ['a', a],
    ['b', b],
  ]);
  assert.equal(
    followArrow(arrow, (id) => objects.get(id)),
    arrow,
  );

  // Only b moves: the end follows, the start stays, the bend shifts by half.
  objects.set('b', { ...b, x: 800, y: 250 });
  let moved = world(followArrow(arrow, (id) => objects.get(id)));
  near(moved[0], start);
  near(moved[2], { x: 800, y: 300 });
  near(moved[1], { x: 550, y: 160 });

  // Both move together: the arrow keeps its shape.
  objects.set('a', { ...a, x: a.x + 40, y: a.y + 10 });
  objects.set('b', { ...b, x: b.x + 40, y: b.y + 10 });
  moved = world(followArrow(arrow, (id) => objects.get(id)));
  near(moved[1], { x: 490, y: 70 });

  // Resized and turned, the end keeps its spot on the side.
  objects.set('b', { ...b, width: 400, height: 300, rotation: 90 });
  near(world(followArrow(arrow, (id) => objects.get(id)))[2], sidePoint(objects.get('b'), 'w'));

  // A deleted object leaves its end where it was.
  near(world(followArrow(arrow, (id) => (id === 'a' ? a : undefined)))[2], end);

  // Moving the arrow alone lets go of objects that did not move with it.
  const loose = keepArrowEnds(arrow, (id) => id === 'a');
  assert.deepEqual(loose.arrow.from, arrow.arrow.from);
  assert.equal(loose.arrow.to, undefined);

  // Copies hold the copied objects and let go of the rest.
  const copy = copyArrowEnds(arrow, new Map([['a', 'a2']]));
  assert.deepEqual(copy.arrow.from, { id: 'a2', x: 1, y: 0.5 });
  assert.equal(copy.arrow.to, undefined);
});
