import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameTitleSize } from '../src/canvas/frame-title-size.ts';

test('frame titles stay readable while zooming out and stop growing on screen while zooming in', () => {
  const frame = { type: 'frame', width: 2000, height: 1200 };
  assert.equal(frameTitleSize(frame, 1).fontSize, 14);
  assert.equal(frameTitleSize(frame, 0.25).fontSize, 40);
  assert.equal(frameTitleSize(frame, 0.1).fontSize, 100);
  assert.equal(frameTitleSize(frame, 8).fontSize, 2.25);
});

test('small frames cap title growth and ordinary export layout keeps its original size', () => {
  const frame = { type: 'frame', width: 240, height: 120, fontSize: 18 };
  assert.equal(frameTitleSize(frame, 0.1).fontSize, 10);
  assert.equal(frameTitleSize(frame).fontSize, 18);
  assert.equal(frameTitleSize(frame).labelGap, 8);
  assert.equal(frame.fontSize, 18);
});
