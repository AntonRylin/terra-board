import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  highlightFromPoints,
  highlightPoints,
  hitsHighlight,
  simplifyStroke,
  readHighlightStyle,
  defaultHighlightStyle,
  highlightSizeRange,
} from '../src/canvas/highlight.ts';
import { clipboardObjects } from '../src/canvas/content.ts';
import { resizeSelection } from '../src/canvas/resize.ts';

const base = {
  id: 'h',
  type: 'highlight',
  z: 1,
  color: '#ffe14d',
  highlight: { points: [], size: 20 },
};

test('a stroke keeps its world points and is hit across its whole width', () => {
  const world = [
    { x: 100, y: 50 },
    { x: 300, y: 50 },
    { x: 300, y: 250 },
  ];
  const o = highlightFromPoints(base, world);
  assert.deepEqual([o.x, o.y, o.width, o.height], [100, 50, 200, 200]);
  assert.deepEqual(
    highlightPoints(o).map((p) => ({ x: p.x + o.x, y: p.y + o.y })),
    world,
  );
  assert.ok(hitsHighlight(o, { x: 100, y: 9 }, 0), 'inside the upper edge of the ink');
  assert.ok(!hitsHighlight(o, { x: 100, y: 12 }, 0), 'outside the ink');
  assert.ok(!hitsHighlight(o, { x: 100, y: 100 }, 0), 'the empty corner of the bounds is not ink');
});

test('a press without movement is a storable dot', () => {
  const o = highlightFromPoints(base, [{ x: 5, y: 5 }]);
  assert.equal(o.highlight.points.length, 2);
  assert.deepEqual([o.width, o.height], [1, 1]);
  assert.ok(hitsHighlight(o, { x: 8, y: 0 }, 0));
  assert.equal(clipboardObjects([{ ...o, x: 5, y: 5 }])[0].highlight.points.length, 2);
});

test('simplifying drops redundant samples, keeps corners and respects the point limit', () => {
  const line = Array.from({ length: 500 }, (_, i) => ({ x: i, y: 0 }));
  assert.deepEqual(simplifyStroke(line, 0.5), [line[0], line.at(-1)]);
  const corner = [...line, ...Array.from({ length: 500 }, (_, i) => ({ x: 499, y: i + 1 }))];
  assert.deepEqual(simplifyStroke(corner, 0.5), [corner[0], corner[499], corner.at(-1)]);
  const scribble = Array.from({ length: 20000 }, (_, i) => ({ x: i, y: i % 2 ? 40 : 0 }));
  const reduced = simplifyStroke(scribble, 0.5, 2000);
  assert.ok(reduced.length <= 2000 && reduced.length >= 2);
  assert.deepEqual([reduced[0], reduced.at(-1)], [scribble[0], scribble.at(-1)]);
});

test('scaling a selection scales the marker width with the stroke', () => {
  const o = highlightFromPoints(base, [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
  ]);
  const [scaled] = resizeSelection([o], { x: 0, y: 0, width: 100, height: 100 }, 'se', 100, 100);
  assert.equal(scaled.width, 200);
  assert.equal(scaled.highlight.size, 40);
  assert.deepEqual(scaled.highlight.points, o.highlight.points);
});

test('clipboard rejects malformed strokes and saved preferences are repaired', () => {
  const o = {
    ...highlightFromPoints(base, [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]),
  };
  assert.equal(clipboardObjects([o])[0].highlight.size, 20);
  assert.throws(() =>
    clipboardObjects([{ ...o, highlight: { points: [{ x: 0, y: 0 }], size: 20 } }]),
  );
  assert.throws(() =>
    clipboardObjects([
      {
        ...o,
        highlight: {
          points: [
            { x: 0, y: 0 },
            { x: 2, y: 0 },
          ],
          size: 20,
        },
      },
    ]),
  );
  assert.throws(() => clipboardObjects([{ ...o, highlight: { ...o.highlight, size: 0 } }]));
  assert.deepEqual(readHighlightStyle(null), defaultHighlightStyle);
  assert.deepEqual(readHighlightStyle({ color: 'red', size: 1e9 }), {
    color: defaultHighlightStyle.color,
    size: highlightSizeRange.max,
  });
  assert.deepEqual(readHighlightStyle({ color: '#12ab9f', size: 31.4 }), {
    color: '#12ab9f',
    size: 31,
  });
});
