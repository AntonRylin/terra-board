import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
import { localToWorld } from '../src/canvas/transform.ts';
import { arrowPoints, arrowFromPoints } from '../src/canvas/arrows.ts';

test('existing arrow endpoints align to the opposite endpoint, even when rotated or modifiers are held before grabbing', () => {
  for (const rotation of [0, 35])
    for (const index of [0, 1])
      for (const ctrlKey of [false, true]) {
        const f = fixture();
        f.engine.camera = { x: 30, y: 50, zoom: 2 };
        const o = {
          ...arrowFromPoints({ id: 'edit-arrow', type: 'arrow', z: 1 }, [
            { x: 100, y: 100 },
            { x: 300, y: 200 },
          ]),
          rotation,
        };
        f.engine.apply({ upserts: [o], deleted: [] });
        f.engine.setSelection([o.id]);
        const original = arrowPoints(o).map((p) => localToWorld(o, p));
        const screen = (p) => ({ x: p.x * 2 + 30, y: p.y * 2 + 50 });
        const start = screen(original[index]);
        const modifiers = { ctrlKey, shiftKey: !ctrlKey };
        f.engine.down({ ...f.event(start.x, start.y, 0), ...modifiers });
        assert.equal(f.engine.gesture?.mode, 'arrowPoint');
        f.engine.move({ ...f.event(start.x - 80, start.y + 140, 0), ...modifiers });
        f.engine.up({ ...f.event(start.x - 80, start.y + 140, 0), ...modifiers });
        const updated = f.engine.objects.get(o.id),
          points = arrowPoints(updated).map((p) => localToWorld(updated, p));
        assert.ok(
          Math.abs(points[index][ctrlKey ? 'x' : 'y'] - original[1 - index][ctrlKey ? 'x' : 'y']) <
            1e-8,
        );
        assert.ok(
          Math.hypot(
            points[1 - index].x - original[1 - index].x,
            points[1 - index].y - original[1 - index].y,
          ) < 1e-8,
          'fixed endpoint stays put',
        );
        f.engine.undo();
        assert.equal(JSON.stringify(f.engine.objects.get(o.id)), JSON.stringify(o));
      }
});

test('existing arrow point modifiers apply without pointer movement and restore free movement on release', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const o = arrowFromPoints({ id: 'edit-arrow', type: 'arrow', z: 1 }, [
    { x: 100, y: 100 },
    { x: 300, y: 200 },
  ]);
  f.engine.apply({ upserts: [o], deleted: [] });
  f.engine.setSelection([o.id]);
  const end = () => {
    const a = f.engine.objects.get(o.id);
    return localToWorld(a, arrowPoints(a)[1]);
  };
  const modifier = (key, shiftKey, ctrlKey) => ({ key, shiftKey, ctrlKey });
  f.engine.down(f.event(300, 200, 0));
  f.engine.keyDown(modifier('Shift', true, false));
  assert.equal(end().y, 100);
  f.engine.keyDown(modifier('Control', true, true));
  assert.equal(end().x, 100);
  f.engine.keyUp(modifier('Control', true, false));
  assert.equal(end().y, 100);
  f.engine.keyUp(modifier('Shift', false, false));
  assert.equal(end().x, 300);
  assert.equal(end().y, 200);
  f.engine.keyDown(modifier('Shift', true, false));
  f.engine.up({ ...f.event(300, 200, 0), shiftKey: true });
  assert.equal(end().y, 100, 'key-only constraint is committed');
  f.engine.undo();
  assert.equal(end().y, 200);
});

test('inner arrow points align to their preceding neighbor and Escape restores all points', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const o = arrowFromPoints({ id: 'bend', type: 'arrow', z: 1 }, [
    { x: 100, y: 100 },
    { x: 200, y: 200 },
    { x: 400, y: 100 },
  ]);
  f.engine.apply({ upserts: [o], deleted: [] });
  f.engine.setSelection([o.id]);
  f.engine.down(f.event(200, 200, 0));
  f.engine.move({ ...f.event(260, 280, 0), ctrlKey: true });
  const updated = f.engine.objects.get(o.id),
    points = arrowPoints(updated).map((p) => localToWorld(updated, p));
  assert.equal(points[1].x, 100);
  assert.equal(points[1].y, 280);
  assert.equal(points[2].x, 400);
  f.engine.cancel();
  assert.equal(JSON.stringify(f.engine.objects.get(o.id)), JSON.stringify(o));
});

test('arrow modifiers constrain from its anchor and update immediately on press and release', () => {
  const f = fixture();
  f.engine.camera = { x: 40, y: 60, zoom: 2 };
  f.engine.beginQuickArrow({ x: 100, y: 120 }, { x: 240, y: 300 });
  const endpoints = () => {
    const o = f.engine.all[0];
    return arrowPoints(o).map((p) => localToWorld(o, p));
  };
  const modifier = (key, shiftKey, ctrlKey) => ({
    key,
    shiftKey,
    ctrlKey,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  for (const [x, y] of [
    [640, 460],
    [80, 100],
  ]) {
    f.engine.move(f.event(x, y, 0));
    f.engine.keyDown(modifier('Shift', true, false));
    assert.equal(endpoints()[1].y, 120);
    assert.equal(endpoints()[1].x, (x - 40) / 2);
    f.engine.keyDown(modifier('Control', true, true));
    assert.equal(endpoints()[1].x, 100, 'Ctrl wins when both keys are held');
    assert.equal(endpoints()[1].y, (y - 60) / 2);
    f.engine.keyUp(modifier('Control', true, false));
    assert.equal(endpoints()[1].y, 120, 'releasing Ctrl restores held Shift');
    f.engine.keyUp(modifier('Shift', false, false));
    assert.equal(endpoints()[1].x, (x - 40) / 2);
    assert.equal(endpoints()[1].y, (y - 60) / 2);
    assert.equal(endpoints()[0].x, 100);
    assert.equal(endpoints()[0].y, 120);
  }
  f.engine.down({ ...f.event(80, 100, 0), ctrlKey: true });
  assert.equal(endpoints()[1].x, 100, 'click commits constrained endpoint');
  assert.equal(f.edits.length, 1);
  f.engine.undo();
  assert.equal(f.engine.all.length, 0);
});

test('Shift and Ctrl constrain ordinary dragged arrows through release', () => {
  for (const axis of ['horizontal', 'vertical']) {
    const f = fixture('arrow');
    f.engine.camera = { x: 0, y: 0, zoom: 1 };
    f.engine.down(f.event(100, 120, 0));
    const constrained = {
      ...f.event(20, 30, 0),
      shiftKey: axis === 'horizontal',
      ctrlKey: axis === 'vertical',
    };
    f.engine.move(constrained);
    f.engine.up(constrained);
    const o = f.engine.all[0],
      p = arrowPoints(o).map((p) => localToWorld(o, p));
    assert.equal(p[1].x, axis === 'horizontal' ? 20 : 100);
    assert.equal(p[1].y, axis === 'horizontal' ? 120 : 30);
    assert.equal(f.edits.length, 1);
  }
});

test('radial arrow stays anchored through hover, commits on left click and undoes in one step', () => {
  const f = fixture();
  f.engine.camera = { x: 40, y: 60, zoom: 2 };
  assert.equal(typeof f.engine.beginQuickArrow, 'function');
  f.engine.beginQuickArrow({ x: 100, y: 120 }, { x: 140, y: 160 });
  assert.equal(
    f.engine.selected.length,
    0,
    'unfinished arrow must not expose saved-object controls',
  );
  f.engine.move(f.event(640, 460, 0));
  f.engine.up(f.event(640, 460, 0));
  assert.equal(f.edits.length, 0, 'hover and unrelated release do not persist a draft');
  const draft = f.engine.all[0];
  const points = arrowPoints(draft).map((p) => localToWorld(draft, p));
  assert.equal(points[0].x, 100);
  assert.equal(points[0].y, 120);
  assert.equal(points[1].x, 300);
  assert.equal(points[1].y, 200);
  f.engine.down(f.event(680, 500, 0));
  f.engine.up(f.event(680, 500, 0));
  assert.equal(f.edits.length, 1);
  assert.equal(f.engine.tool, 'select');
  f.engine.undo();
  assert.equal(f.engine.all.length, 0);
  f.engine.redo();
  assert.equal(f.engine.all.length, 1);
});

test('radial arrow cancellation and tool changes discard the unsaved preview', () => {
  for (const cancel of [
    (f) => f.engine.cancel(),
    (f) => f.engine.blur(),
    (f) => f.engine.setTool('note'),
    (f) => f.engine.down(f.event(300, 200, 2)),
  ]) {
    const f = fixture();
    assert.equal(typeof f.engine.beginQuickArrow, 'function');
    f.engine.beginQuickArrow({ x: 100, y: 120 }, { x: 140, y: 160 });
    cancel(f);
    assert.equal(f.engine.all.length, 0);
    assert.equal(f.edits.length, 0);
    assert.equal(f.engine.history.canUndo, false);
  }
});

test('undo while placing a radial arrow cancels only its unsaved preview', () => {
  const f = fixture();
  f.engine.apply({
    upserts: [{ id: 'keep', type: 'rect', x: 10, y: 20, width: 50, height: 50, z: 1 }],
    deleted: [],
  });
  f.engine.beginQuickArrow({ x: 100, y: 120 }, { x: 140, y: 160 });
  f.engine.keyDown({
    key: 'z',
    code: 'KeyZ',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  assert.equal(f.engine.all.length, 1);
  assert.equal(f.engine.all[0].id, 'keep');
  assert.equal(f.edits.length, 1);
});

test('an accepted external lock immediately protects the open board', () => {
  const f = fixture();
  const item = { id: 'external-lock', type: 'note', x: 50, y: 50, width: 200, height: 160, z: 1 };
  f.engine.apply({ upserts: [item], deleted: [] });
  f.engine.setSelection([item.id]);
  f.engine.acceptExternalEdit({ upserts: [{ ...item, locked: true }], deleted: [] });
  assert.equal(f.engine.objects.get(item.id).locked, true);
  f.engine.apply({ upserts: [{ ...item, x: 999 }], deleted: [] });
  f.engine.undo();
  assert.equal(f.engine.objects.get(item.id).x, 50);
  assert.equal(f.engine.objects.get(item.id).locked, true);
});

test('locked selection rejects transform gestures, editing, deletion and undo until explicitly unlocked', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const item = {
    id: 'protected',
    type: 'note',
    x: 100,
    y: 100,
    width: 200,
    height: 160,
    z: 1,
    text: 'Keep',
  };
  f.engine.apply({ upserts: [item], deleted: [] });
  f.engine.setSelection([item.id]);
  f.engine.setSelectionLocked(true);
  const locked = JSON.stringify(f.engine.objects.get(item.id));
  for (const [x, y] of [
    [180, 180],
    [300, 260],
    [100, 100],
    [90, 280],
  ]) {
    f.engine.down(f.event(x, y, 0));
    f.engine.move(f.event(x + 90, y + 70, 0));
    f.engine.up(f.event(x + 90, y + 70, 0));
    assert.equal(JSON.stringify(f.engine.objects.get(item.id)), locked);
  }
  f.engine.callbacks.create = () => assert.fail('locked double-click must not create an item');
  f.engine.doubleClick(f.event(180, 180, 0));
  assert.deepEqual(f.activations, []);
  f.engine.setSelection([item.id]);
  f.engine.apply({ upserts: [{ ...item, text: 'Changed', locked: false }], deleted: [] });
  f.engine.deleteSelected();
  f.engine.undo();
  assert.equal(JSON.stringify(f.engine.objects.get(item.id)), locked);
  f.engine.setSelectionLocked(false);
  f.engine.down(f.event(180, 180, 0));
  f.engine.move(f.event(230, 220, 0));
  f.engine.up(f.event(230, 220, 0));
  assert.equal(f.engine.objects.get(item.id).x, 150);
  f.engine.undo();
  assert.equal(f.engine.objects.get(item.id).x, 100);
  assert.equal(f.engine.objects.get(item.id).locked, false);
});

test('a locked child prevents moving its enclosing frame or a mixed selection', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const frame = { id: 'container', type: 'frame', x: 50, y: 50, width: 500, height: 400, z: 0 };
  const child = {
    id: 'protected',
    type: 'note',
    x: 150,
    y: 150,
    width: 150,
    height: 120,
    z: 1,
    locked: true,
  };
  const other = { ...child, id: 'other', x: 650, locked: false };
  f.engine.apply({ upserts: [frame, child, other], deleted: [] });
  for (const ids of [[frame.id], [child.id, other.id]]) {
    f.engine.setSelection(ids);
    assert.equal(f.engine.selectionLocked, true);
    const x = ids.length === 1 ? 52 : 700,
      y = ids.length === 1 ? 52 : 200;
    f.engine.down(f.event(x, y, 0));
    f.engine.move(f.event(x + 60, y + 70, 0));
    f.engine.up(f.event(x + 60, y + 70, 0));
    assert.equal(f.engine.objects.get(child.id).x, child.x);
    assert.equal(f.engine.objects.get(frame.id).x, frame.x);
    assert.equal(f.engine.objects.get(other.id).x, other.x);
  }
});

test('search focuses and selects an offscreen rotated item without changing its content', () => {
  const f = fixture('frame');
  const target = {
    id: 'found',
    type: 'note',
    x: 12000,
    y: -7000,
    width: 260,
    height: 180,
    rotation: 40,
    z: 1,
    text: 'Found text',
  };
  f.engine.apply({ upserts: [target], deleted: [] });
  const edits = f.edits.length;
  assert.equal(f.engine.focusObject(target.id), true);
  const c = f.engine.camera;
  assert.ok(Math.abs((target.x + target.width / 2) * c.zoom + c.x - 500) < 1);
  assert.ok(Math.abs((target.y + target.height / 2) * c.zoom + c.y - 350) < 1);
  assert.deepEqual([...f.engine.selection], [target.id]);
  assert.equal(f.engine.tool, 'select');
  assert.equal(f.edits.length, edits, 'navigation creates no object edit');
  assert.equal(f.engine.focusObject('removed'), false);
  assert.deepEqual({ ...f.engine.camera }, { ...c }, 'missing results leave the camera alone');
});

test('all canvas object types snap during moves, clear guides on release, and undo once', () => {
  for (const type of [
    'image',
    'text',
    'note',
    'rect',
    'ellipse',
    'frame',
    'link',
    'video',
    'arrow',
  ]) {
    const f = fixture();
    f.engine.camera = { x: 0, y: 0, zoom: 1 };
    const moving = { id: 'moving', type, x: 20, y: 20, width: 100, height: 80, z: 1 };
    const target = { ...moving, id: 'target', type: 'rect', x: 300, y: 300 };
    f.engine.apply({ upserts: [moving, target], deleted: [] });
    const startY = type === 'frame' ? 23 : 60;
    f.engine.down(f.event(70, startY, 0));
    f.engine.move(f.event(248, startY + 278, 0));
    assert.equal(f.engine.objects.get('moving').x, 200, type);
    assert.equal(f.engine.objects.get('moving').y, 300, type);
    assert.ok(f.engine.snapGuides.length > 0, type);
    f.engine.up(f.event(248, startY + 278, 0));
    assert.equal(f.engine.snapGuides.length, 0, type);
    f.engine.undo();
    assert.equal(f.engine.objects.get('moving').x, 20, type);
    assert.equal(f.engine.objects.get('moving').y, 20, type);
  }
});
test('snap bypass and cancel restore free motion and clear guides', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const moving = { id: 'moving', type: 'rect', x: 20, y: 20, width: 100, height: 80, z: 1 };
  f.engine.apply({ upserts: [moving, { ...moving, id: 'target', x: 300, y: 300 }], deleted: [] });
  f.engine.down(f.event(70, 60, 0));
  f.engine.move(f.event(248, 338, 0));
  f.engine.move({ ...f.event(248, 338, 0), altKey: true });
  assert.equal(f.engine.objects.get('moving').x, 198);
  assert.equal(f.engine.objects.get('moving').y, 298);
  assert.equal(f.engine.snapGuides.length, 0);
  f.engine.move(f.event(248, 338, 0));
  assert.ok(f.engine.snapGuides.length);
  f.engine.cancel();
  assert.equal(f.engine.objects.get('moving').x, 20);
  assert.equal(f.engine.snapGuides.length, 0);
});

test('resizing shows alignment guides, supports Alt and cancel, and undoes in one step', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const original = { id: 'resized', type: 'rect', x: 20, y: 20, width: 100, height: 80, z: 1 };
  f.engine.apply({
    upserts: [original, { ...original, id: 'target', x: 300, y: 300 }],
    deleted: [],
  });
  f.engine.setSelection(['resized']);
  f.engine.down(f.event(120, 60, 0));
  assert.equal(f.engine.gesture.mode, 'resize');
  f.engine.move(f.event(298, 60, 0));
  assert.equal(f.engine.objects.get('resized').width, 280);
  assert.ok(f.engine.snapGuides.some((g) => g.axis === 'x' && g.at === 300));
  f.engine.move({ ...f.event(298, 60, 0), altKey: true });
  assert.equal(f.engine.objects.get('resized').width, 278);
  assert.equal(f.engine.snapGuides.length, 0);
  f.engine.move(f.event(298, 60, 0));
  f.engine.up(f.event(298, 60, 0));
  assert.equal(f.engine.snapGuides.length, 0);
  f.engine.undo();
  assert.equal(f.engine.objects.get('resized').width, 100);
  f.engine.redo();
  assert.equal(f.engine.objects.get('resized').width, 280);
  f.engine.down(f.event(300, 60, 0));
  f.engine.move(f.event(347, 60, 0));
  assert.ok(f.engine.snapGuides.length);
  f.engine.cancel();
  assert.equal(f.engine.objects.get('resized').width, 280);
  assert.equal(f.engine.snapGuides.length, 0);
});
test('moving frames snap as a whole and never snap against their carried children', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const frame = { id: 'frame', type: 'frame', x: 20, y: 20, width: 200, height: 160, z: 0 };
  const child = { id: 'child', type: 'note', x: 22, y: 50, width: 80, height: 60, z: 1 };
  f.engine.apply({
    upserts: [frame, child, { ...frame, id: 'target', x: 400, y: 300 }],
    deleted: [],
  });
  f.engine.down(f.event(150, 23, 0));
  f.engine.move(f.event(153, 23, 0));
  assert.equal(f.engine.objects.get('frame').x, 23, 'moving child is not a target');
  f.engine.move(f.event(328, 301, 0));
  assert.equal(f.engine.objects.get('frame').x, 200);
  assert.equal(f.engine.objects.get('child').x, 202);
  assert.equal(f.engine.objects.get('child').y, 330);
});

test('YouTube play badge activates on one click while dragging still moves its card', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const o = {
    id: 'youtube',
    type: 'link',
    url: 'https://youtu.be/abcdefghijk',
    x: 100,
    y: 100,
    width: 440,
    height: 360,
    z: 1,
  };
  f.engine.apply({ upserts: [o], deleted: [] });
  f.engine.down(f.event(320, 226, 0));
  f.engine.up(f.event(320, 226, 0));
  assert.deepEqual(f.activations, ['youtube']);
  f.engine.down(f.event(320, 226, 0));
  f.engine.move(f.event(370, 256, 0));
  f.engine.up(f.event(370, 256, 0));
  assert.equal(f.engine.objects.get(o.id).x, 150);
  assert.deepEqual(f.activations, ['youtube']);
});

test('late link metadata preserves moves, undo, redo and never resurrects deleted cards', () => {
  const f = fixture();
  const o = {
    id: 'link',
    type: 'link',
    url: 'https://example.com',
    text: 'example.com',
    x: 10,
    y: 10,
    width: 440,
    height: 360,
    z: 1,
  };
  const meta = {
    url: o.url,
    text: 'Example title',
    linkDescription: 'Summary',
    assetId: 'a'.repeat(64),
  };
  f.engine.apply({ upserts: [o], deleted: [] });
  f.engine.apply({ upserts: [{ ...o, x: 200 }], deleted: [] });
  f.engine.hydrateLink(o.id, meta);
  assert.equal(f.engine.objects.get(o.id).x, 200);
  f.engine.undo();
  assert.equal(f.engine.objects.get(o.id).x, 10);
  assert.equal(f.engine.objects.get(o.id).text, meta.text);
  f.engine.undo();
  f.engine.hydrateLink(o.id, meta);
  assert.equal(f.engine.objects.has(o.id), false);
  f.engine.redo();
  assert.equal(f.engine.objects.get(o.id).assetId, meta.assetId);
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  f.engine.down(f.event(50, 50, 0));
  f.engine.move(f.event(90, 90, 0));
  f.engine.hydrateLink(o.id, meta);
  assert.equal(f.engine.objects.get(o.id).x, 50, 'live drag remains visible');
  assert.equal(f.edits.at(-1).upserts[0].x, 10, 'metadata saves committed geometry');
  f.engine.cancel();
  assert.equal(f.engine.objects.get(o.id).x, 10);
});

test('frame drag carries contained objects once, snapshots membership, and supports undo and cancel', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const frame = { id: 'parent', type: 'frame', x: 100, y: 100, width: 400, height: 300, z: -1 };
  const child = { id: 'child', type: 'note', x: 150, y: 150, width: 60, height: 60, z: 1 };
  const nested = { ...frame, id: 'nested', x: 300, y: 200, width: 100, height: 100 };
  const outside = { ...child, id: 'outside', x: 510 };
  const partial = { ...child, id: 'partial', x: 480 };
  f.engine.apply({ upserts: [frame, child, nested, outside, partial], deleted: [] });
  f.engine.setSelection(['parent', 'child']);
  f.engine.down(f.event(250, 105, 0));
  f.engine.move(f.event(650, 125, 0));
  f.engine.up(f.event(650, 125, 0));
  for (const o of [frame, child, nested]) {
    assert.equal(f.engine.objects.get(o.id).x, o.x + 400);
    assert.equal(f.engine.objects.get(o.id).y, o.y + 20);
  }
  assert.equal(f.engine.objects.get('outside').x, outside.x);
  assert.equal(f.engine.objects.get('partial').x, partial.x);
  f.engine.undo();
  assert.equal(f.engine.objects.get('child').x, child.x);
  assert.equal(f.engine.objects.get('parent').x, frame.x);
  f.engine.redo();
  assert.equal(f.engine.objects.get('child').x, child.x + 400);
  f.engine.down(f.event(650, 125, 0));
  f.engine.move(f.event(700, 175, 0));
  f.engine.cancel();
  assert.equal(f.engine.objects.get('child').x, child.x + 400);
});

test('frame membership follows current placement, including rotated frame geometry', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const frame = {
    id: 'parent',
    type: 'frame',
    x: 100,
    y: 100,
    width: 400,
    height: 200,
    rotation: 90,
    z: -1,
  };
  const child = { id: 'child', type: 'note', x: 250, y: 150, width: 40, height: 40, z: 1 };
  const outside = { ...child, id: 'outside', x: 110, y: 110 };
  f.engine.apply({ upserts: [frame, child, outside], deleted: [] });
  f.engine.setSelection(['parent']);
  const start = localToWorld(frame, { x: 100, y: 5 });
  const drag = () => {
    f.engine.down(f.event(start.x, start.y, 0));
    f.engine.move(f.event(start.x + 50, start.y, 0));
    f.engine.up(f.event(start.x + 50, start.y, 0));
  };
  drag();
  assert.equal(f.engine.objects.get('child').x, 300);
  assert.equal(f.engine.objects.get('outside').x, 110);
  f.engine.undo();
  f.engine.apply({ upserts: [{ ...child, x: 700 }], deleted: [] });
  drag();
  assert.equal(f.engine.objects.get('child').x, 700, 'objects moved out are released');
});

// Exercise the actual Engine event handlers without creating a GPU context.
function fixture(tool = 'select') {
  const canvas = { setAttribute() {} },
    edits = [],
    menus = [],
    saves = [],
    activations = [],
    // What a drag sends to the other people on a cloud board, with the edits, in order.
    live = [],
    // Touch long-press timers: kept, and run only when a test says so.
    timers = [];
  class Application {
    canvas = canvas;
    stage = { addChild() {} };
    init() {
      return Promise.resolve();
    }
    destroy() {}
  }
  class Empty {}
  const exports = {};
  const code = ts.transpileModule(
    readFileSync(new URL('../src/canvas/engine.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const localRequire = (id) => {
    if (id === 'pixi.js/unsafe-eval') return {};
    if (id === 'pixi.js') return { Application, Container: Empty, Graphics: Empty };
    if (id === './text-rendering') return {};
    if (id === './night-lighting')
      return {
        NightLighting: class {
          canvas = { after() {} };
          draw() {}
          destroy() {}
        },
      };
    if (id === './text-layout')
      return {
        // Pointer tests use a deterministic font measurement; packaged checks
        // exercise the real browser's wrapping and rendered label placement.
        textLayout(o, text = o.text || '') {
          const fontSize = o.fontSize || 14;
          return {
            appearance: { padding: 0, wrapWidth: o.width, lineHeight: fontSize * 1.45 },
            metrics: {
              lines: text.split('\n'),
              maxLineWidth: Math.min(o.width, text.length * fontSize * 0.6),
            },
          };
        },
      };
    if (id === './frame-label') {
      const frameExports = {};
      vm.runInNewContext(
        ts.transpileModule(
          readFileSync(new URL('../src/canvas/frame-label.ts', import.meta.url), 'utf8'),
          { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
        ).outputText,
        { exports: frameExports, require: localRequire },
      );
      return frameExports;
    }
    if (id === './textures')
      return {
        TextureCache: class {
          destroy() {}
        },
      };
    return require(
      fileURLToPath(
        new URL('../src/canvas/' + id + (id.endsWith('.ts') ? '' : '.ts'), import.meta.url),
      ),
    );
  };
  // Resolve local imports through fileURLToPath, including non-ASCII checkout paths.
  let now = 0,
    frameId = 0;
  const frames = new Map();
  const motion = { matches: false };
  const tick = (ms = 16) => {
    now += ms;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  };
  const context = {
    exports,
    require: localRequire,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => motion,
      setTimeout: (callback) => timers.push(callback),
      clearTimeout: (id) => {
        timers[id - 1] = null;
      },
    },
    document: { documentElement: { dataset: { theme: 'light' } } },
    devicePixelRatio: 1,
    requestAnimationFrame: (cb) => {
      frames.set(++frameId, cb);
      return frameId;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    performance: { now: () => now },
    crypto,
    MouseEvent: class {
      constructor(type, init) {
        Object.assign(this, { type }, init);
      }
    },
  };
  vm.runInNewContext(code, context);
  const host = {
    style: {},
    clientWidth: 1000,
    clientHeight: 700,
    prepend() {},
    focus() {},
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const engine = new exports.Engine(
    host,
    [],
    { x: 20, y: 30, zoom: 2 },
    {
      edit(edit) {
        edits.push(edit);
        live.push({ edit: edit.upserts.map((o) => o.id) });
      },
      live: (objects) => live.push(objects && objects.map((o) => ({ id: o.id, x: o.x }))),
      camera: (c) => saves.push({ ...c }),
      selection() {},
      activate(o) {
        activations.push(o.id);
      },
      create() {
        throw Error('Panning must not create an object');
      },
      context: (p) => menus.push({ ...p }),
      ready() {},
      error: (e) => {
        throw Error(e);
      },
    },
  );
  engine.setTool(tool);
  const event = (x, y, button = 2) => ({
    target: canvas,
    clientX: x,
    clientY: y,
    button,
    pointerId: 1,
    preventDefault() {},
  });
  // The finger has been held still long enough.
  const hold = () => timers.findLast(Boolean)?.();
  return { engine, host, menus, saves, event, activations, edits, tick, motion, hold, live };
}

test('linked frames select on single click, open on double click, and move without altering their source', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const original = { id: 'source', type: 'frame', x: 0, y: 400, width: 300, height: 200, z: 0 };
  const linked = {
    ...original,
    id: 'linked',
    x: 100,
    y: 100,
    z: 2,
    frameLink: { boardId: 'board', frameId: 'source' },
  };
  f.engine.apply({ upserts: [original, linked], deleted: [] });
  f.engine.down(f.event(180, 180, 0));
  f.engine.up(f.event(180, 180, 0));
  assert.deepEqual([...f.engine.selection], ['linked']);
  assert.deepEqual(f.activations, []);
  f.engine.down(f.event(180, 180, 0));
  f.engine.up(f.event(180, 180, 0));
  assert.deepEqual(f.activations, [], 'a selected link still requires double-click');
  f.engine.doubleClick(f.event(180, 180, 0));
  assert.deepEqual(f.activations, ['linked']);
  f.engine.down(f.event(180, 180, 0));
  f.engine.move({ ...f.event(220, 220, 0), altKey: true });
  f.engine.up(f.event(220, 220, 0));
  assert.equal(f.engine.objects.get('linked').x, 140);
  assert.equal(f.engine.objects.get('source').x, 0);
  assert.deepEqual(f.engine.objects.get('linked').frameLink, linked.frameLink);
  f.engine.undo();
  assert.equal(f.engine.objects.get('linked').x, 100);
});

test('double click retargeted to the pointer-capturing surface opens the object editor', () => {
  const f = fixture();
  f.engine.apply({
    upserts: [
      {
        id: 'editable-note',
        type: 'note',
        x: 10,
        y: 10,
        width: 200,
        height: 100,
        z: 1,
        text: 'Edit me',
      },
    ],
    deleted: [],
  });
  f.engine.doubleClick({ ...f.event(80, 100, 0), target: f.host });
  assert.deepEqual(f.activations, ['editable-note']);
  f.engine.doubleClick({ ...f.event(80, 100, 0), target: {} });
  assert.equal(f.activations.length, 1, 'double click on an overlay activated the board');
});

test('one click on an outside frame name edits; dragging the name moves the frame', () => {
  const f = fixture();
  f.engine.apply({
    upserts: [
      {
        id: 'frame',
        type: 'frame',
        x: 100,
        y: 100,
        width: 300,
        height: 200,
        text: 'Frame 1',
        fontSize: 14,
        z: -1,
      },
    ],
    deleted: [],
  });
  const point = f.event(260, 188, 0); // local (20,-21), outside the frame body
  f.engine.down(point);
  f.engine.up(point);
  assert.deepEqual(f.activations, ['frame']);
  f.activations.length = 0;
  f.engine.down(point);
  f.engine.move(f.event(300, 208, 0));
  f.engine.up(f.event(300, 208, 0));
  assert.deepEqual(f.activations, []);
  assert.equal(f.engine.objects.get('frame').x, 120);
});

test('outside frame names remain indexed and clickable after rotation and zoom', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const f = fixture();
    const frame = {
      id: 'frame',
      type: 'frame',
      x: 100,
      y: 100,
      width: 300,
      height: 200,
      text: 'Frame 1',
      fontSize: 14,
      z: -1,
      rotation,
    };
    f.engine.apply({ upserts: [frame], deleted: [] });
    const p = localToWorld(frame, { x: 20, y: -21 });
    assert.ok(
      f.engine.index.search({ ...p, width: 1, height: 1 }).some((o) => o.id === frame.id),
      'title-only viewport includes frame',
    );
    for (const zoom of [0.5, 1, 8]) {
      f.engine.setSelection([]);
      f.engine.camera.zoom = zoom;
      f.activations.length = 0;
      const point = f.event(p.x * zoom + 20, p.y * zoom + 30, 0);
      f.engine.down(point);
      f.engine.up(point);
      assert.deepEqual(f.activations, ['frame'], `rotation ${rotation}, zoom ${zoom}`);
    }
  }
});

for (const type of ['text', 'note', 'rect', 'ellipse', 'frame', 'link', 'video'])
  test(`a second separate click on selected ${type} edits, but first click only selects`, () => {
    const f = fixture();
    f.engine.apply({
      upserts: [{ id: 'text', type, x: 20, y: 20, width: 160, height: 50, text: 'Text', z: 1 }],
      deleted: [],
    });
    const click = () => {
      f.engine.down(f.event(120, 100, 0));
      f.engine.up(f.event(120, 100, 0));
    };
    click();
    assert.deepEqual(f.activations, []);
    assert.deepEqual([...f.engine.selection], ['text']);
    click();
    assert.deepEqual(f.activations, ['text']);
  });

test('selected text drag, returning drag, modifiers and multi-selection do not start editing', () => {
  for (const type of ['text', 'note', 'rect', 'ellipse', 'frame', 'link', 'video'])
    for (const mode of ['drag', 'return', 'shift', 'ctrl', 'multi']) {
      const f = fixture();
      f.engine.apply({
        upserts: [
          { id: 'text', type, x: 20, y: 20, width: 160, height: 50, text: 'Text', z: 1 },
          { id: 'other', type: 'text', x: 250, y: 20, width: 160, height: 50, text: 'Other', z: 2 },
        ],
        deleted: [],
      });
      f.engine.setSelection(mode === 'multi' ? ['text', 'other'] : ['text']);
      const down = {
        ...f.event(120, 100, 0),
        shiftKey: mode === 'shift',
        ctrlKey: mode === 'ctrl',
      };
      f.engine.down(down);
      if (mode === 'drag' || mode === 'return') f.engine.move(f.event(150, 120, 0));
      if (mode === 'return') f.engine.move(down);
      f.engine.up(mode === 'drag' ? f.event(150, 120, 0) : down);
      assert.deepEqual(f.activations, [], mode);
    }
});

test('right-drag pans by screen pixels, saves camera and suppresses the release menu', () => {
  const f = fixture('note');
  f.engine.down(f.event(100, 100));
  assert.equal(f.host.style.cursor, 'grabbing');
  f.engine.move(f.event(250, 160));
  assert.equal(f.engine.camera.x, 170);
  assert.equal(f.engine.camera.y, 90);
  f.engine.up(f.event(250, 160));
  f.engine.context(f.event(250, 160));
  assert.equal(f.menus.length, 0);
  assert.equal(f.saves.length, 1);
  assert.equal(f.host.style.cursor, 'crosshair');
});
test('right-click keeps the menu, including platforms emitting contextmenu before pointerup', () => {
  const f = fixture();
  f.engine.down(f.event(100, 100));
  f.engine.context(f.event(100, 100));
  assert.equal(f.menus.length, 0);
  f.engine.move(f.event(101, 100));
  f.engine.up(f.event(101, 100));
  f.engine.context(f.event(101, 100));
  assert.equal(f.menus.length, 1);
  assert.equal(f.engine.camera.x, 20);
  assert.equal(f.saves.length, 0);
});
test('dragging away and returning still suppresses a menu; a later right-click works', () => {
  const f = fixture();
  f.engine.down(f.event(100, 100));
  f.engine.move(f.event(200, 100));
  f.engine.move(f.event(100, 100));
  f.engine.up(f.event(100, 100));
  f.engine.context(f.event(100, 100));
  assert.equal(f.menus.length, 0);
  f.engine.down(f.event(120, 120));
  f.engine.up(f.event(120, 120));
  f.engine.context(f.event(120, 120));
  assert.equal(f.menus.length, 1);
});
test('cancelled right-drag restores camera and cursor without saving', () => {
  const f = fixture();
  f.engine.down(f.event(100, 100));
  f.engine.move(f.event(200, 200));
  f.engine.cancel();
  f.engine.context(f.event(200, 200));
  assert.equal(f.engine.camera.x, 20);
  assert.equal(f.engine.camera.y, 30);
  assert.equal(f.saves.length, 0);
  assert.equal(f.menus.length, 0);
  assert.equal(f.host.style.cursor, 'default');
});

test('right-drag over content keeps object positions and selection unchanged', () => {
  const f = fixture();
  const item = {
    id: 'note',
    type: 'note',
    x: 0,
    y: 0,
    width: 300,
    height: 300,
    z: 1,
    text: 'Keep me',
  };
  f.engine.apply({ upserts: [item], deleted: [] });
  f.engine.setSelection(['note']);
  f.engine.down(f.event(100, 100));
  f.engine.move(f.event(300, 200));
  f.engine.up(f.event(300, 200));
  assert.equal(f.engine.objects.get('note').x, 0);
  assert.equal(f.engine.objects.get('note').y, 0);
  assert.deepEqual([...f.engine.selection], ['note']);
});

test('middle-button and hand-tool panning continue to work', () => {
  for (const [tool, button] of [
    ['select', 1],
    ['hand', 0],
  ]) {
    const f = fixture(tool);
    f.engine.down(f.event(100, 100, button));
    f.engine.move(f.event(140, 150, button));
    f.engine.up(f.event(140, 150, button));
    assert.equal(f.engine.camera.x, 60);
    assert.equal(f.engine.camera.y, 80);
    assert.equal(f.saves.length, 1);
    assert.equal(f.menus.length, 0);
  }
});

test('wheel zooms in and out around the cursor without requiring a modifier', () => {
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
    const f = fixture();
    f.host.getBoundingClientRect = () => ({ left: 80, top: 50 });
    let prevented = 0;
    const wheel = (deltaY) => ({
      ...f.event(380, 250),
      deltaX: 0,
      deltaY,
      ...modifiers,
      preventDefault() {
        prevented++;
      },
    });
    // Local cursor (300, 200) is over world point (140, 85) at the initial camera.
    f.engine.wheel(wheel(-100));
    assert.equal(f.engine.camera.zoom, 2, 'wheel does not jump before animation');
    f.tick();
    const firstFrame = f.engine.camera.zoom;
    for (let i = 0; i < 40; i++) f.tick();
    const zoomedIn = { ...f.engine.camera };
    assert.ok(firstFrame > 2 && firstFrame < zoomedIn.zoom, 'zoom eases over multiple frames');
    assert.ok(Math.abs(zoomedIn.zoom / 2 - Math.exp(0.1)) < 1e-9, 'one notch is about ten percent');
    assert.ok(zoomedIn.zoom > 2, 'wheel up must zoom in');
    f.engine.wheel(wheel(100));
    for (let i = 0; i < 40; i++) f.tick();
    assert.ok(f.engine.camera.zoom < zoomedIn.zoom, 'wheel down must zoom out');
    for (const camera of [zoomedIn, f.engine.camera]) {
      assert.ok(Math.abs(140 * camera.zoom + camera.x - 300) < 1e-9);
      assert.ok(Math.abs(85 * camera.zoom + camera.y - 200) < 1e-9);
    }
    assert.equal(prevented, 2);
    assert.ok(f.saves.length > 2);
    assert.deepEqual(f.saves.at(-1), { ...f.engine.camera });
  }
});

test('wheel over an editor or other overlay leaves the camera and scrolling alone', () => {
  const f = fixture();
  f.engine.wheel({
    ...f.event(300, 200),
    target: {},
    deltaX: 0,
    deltaY: -100,
    preventDefault() {
      assert.fail('Overlay scrolling must remain available');
    },
  });
  assert.deepEqual({ ...f.engine.camera }, { x: 20, y: 30, zoom: 2 });
  assert.equal(f.saves.length, 0);
});

function selectionFixture() {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  f.engine.apply({
    upserts: [
      { id: 'a', type: 'note', x: 10, y: 10, width: 60, height: 60, z: 1 },
      { id: 'b', type: 'note', x: 150, y: 10, width: 60, height: 60, z: 2 },
      { id: 'c', type: 'note', x: 300, y: 10, width: 60, height: 60, z: 3 },
    ],
    deleted: [],
  });
  return f;
}
test('marquee selection moves together from its empty interior and stays selected', () => {
  const f = selectionFixture();
  f.engine.down(f.event(0, 0, 0));
  f.engine.move(f.event(230, 90, 0));
  f.engine.up(f.event(230, 90, 0));
  assert.deepEqual([...f.engine.selection].sort(), ['a', 'b']);
  f.engine.down(f.event(100, 40, 0));
  f.engine.move(f.event(140, 70, 0));
  f.engine.up(f.event(140, 70, 0));
  assert.deepEqual([...f.engine.selection].sort(), ['a', 'b']);
  assert.equal(f.engine.objects.get('a').x, 50);
  assert.equal(f.engine.objects.get('b').x, 190);
  assert.equal(f.engine.objects.get('a').y, 40);
  assert.equal(f.engine.objects.get('c').x, 300);
  f.engine.undo();
  assert.equal(f.engine.objects.get('a').x, 10);
  assert.equal(f.engine.objects.get('b').x, 150);
});
test('Shift, Ctrl and Meta click add and remove objects without collapsing the selection', () => {
  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey']) {
    const f = selectionFixture();
    f.engine.setSelection(['a']);
    const click = (x) => {
      const e = { ...f.event(x, 30, 0), [modifier]: true };
      f.engine.down(e);
      f.engine.up(e);
    };
    click(170);
    assert.deepEqual([...f.engine.selection].sort(), ['a', 'b']);
    click(30);
    assert.deepEqual([...f.engine.selection], ['b']);
    click(320);
    assert.deepEqual([...f.engine.selection].sort(), ['b', 'c']);
  }
});
test('modifier marquee adds or toggles objects while retaining items outside its rectangle', () => {
  for (const modifier of ['shiftKey', 'ctrlKey']) {
    const f = selectionFixture();
    f.engine.setSelection(['a', 'c']);
    const event = (x, y) => ({ ...f.event(x, y, 0), [modifier]: true });
    f.engine.down(event(0, 0));
    f.engine.move(event(230, 90));
    f.engine.up(event(230, 90));
    assert.deepEqual(
      [...f.engine.selection].sort(),
      modifier === 'ctrlKey' ? ['b', 'c'] : ['a', 'b', 'c'],
    );
  }
});
test('selected content drags, duplicates and deletes as one complete selection', () => {
  const f = selectionFixture();
  f.engine.setSelection(['a', 'b']);
  f.engine.down(f.event(30, 30, 0));
  f.engine.move(f.event(50, 50, 0));
  f.engine.up(f.event(50, 50, 0));
  assert.deepEqual([...f.engine.selection].sort(), ['a', 'b']);
  f.engine.duplicate();
  assert.equal(f.engine.selected.length, 2);
  const copies = f.engine.selected.map((o) => o.id);
  assert.ok(copies.every((id) => !['a', 'b', 'c'].includes(id)));
  f.engine.deleteSelected();
  assert.equal(f.engine.objects.size, 3);
  assert.ok(copies.every((id) => !f.engine.objects.has(id)));
});
test('duplicating a frame copies its contents as a separate frame', () => {
  const f = fixture();
  f.engine.apply({
    upserts: [
      { id: 'frame', type: 'frame', x: 0, y: 0, width: 400, height: 300, z: 1, text: 'Plan' },
      { id: 'inside', type: 'note', x: 40, y: 40, width: 100, height: 80, z: 2, text: 'A' },
      { id: 'outside', type: 'rect', x: 600, y: 0, width: 50, height: 50, z: 3 },
    ],
    deleted: [],
  });
  f.engine.setSelection(['frame']);
  f.engine.duplicate();
  assert.equal(f.engine.objects.size, 5);
  const [frame] = f.engine.selected;
  assert.ok(frame.id !== 'frame' && frame.type === 'frame');
  assert.deepEqual([frame.x, frame.y, frame.text], [28, 28, 'Plan']);
  const note = f.engine.all.find((o) => o.type === 'note' && o.id !== 'inside');
  assert.deepEqual([note.x, note.y, note.text], [68, 68, 'A']);
  assert.ok(note.z > frame.z);
  f.engine.apply({ upserts: [{ ...note, text: 'B' }], deleted: [] });
  assert.equal(f.engine.objects.get('inside').text, 'A');
});

for (const corner of ['nw', 'ne', 'sw', 'se']) {
  test(`zoomed-out ${corner} handle wins over nearby corners`, () => {
    const f = fixture();
    f.engine.camera = { x: 0, y: 0, zoom: 0.25 };
    f.engine.apply({
      upserts: [{ id: 'tiny', type: 'rect', x: 100, y: 100, width: 20, height: 20, z: 1 }],
      deleted: [],
    });
    f.engine.setSelection(['tiny']);
    const x = corner.includes('w') ? 25 : 30,
      y = corner.includes('n') ? 25 : 30;
    f.engine.down(f.event(x, y, 0));
    assert.equal(f.engine.gesture.corner, corner);
  });
  test(`text ${corner} resize scales its font, anchors the opposite corner, and undoes in one step`, () => {
    const f = fixture();
    const o = {
      id: 'text',
      type: 'text',
      x: 100,
      y: 100,
      width: 300,
      height: 60,
      fontSize: 24,
      z: 1,
      text: 'Scale me',
    };
    f.engine.apply({ upserts: [o], deleted: [] });
    f.engine.setSelection([o.id]);
    const west = corner.includes('w'),
      north = corner.includes('n');
    const x = (o.x + (west ? 0 : o.width)) * 2 + 20;
    const y = (o.y + (north ? 0 : o.height)) * 2 + 30;
    const target = f.event(x + (west ? -300 : 300), y + (north ? -60 : 60), 0);
    f.engine.down(f.event(x, y, 0));
    f.engine.move(target);
    const resized = f.engine.objects.get(o.id);
    assert.equal(resized.width, 450);
    assert.equal(resized.height, 90);
    assert.equal(resized.fontSize, 36);
    assert.equal(resized.x, west ? -50 : 100);
    assert.equal(resized.y, north ? 70 : 100);
    f.engine.up(target);
    assert.deepEqual([...f.engine.selection], [o.id]);
    f.engine.undo();
    assert.equal(f.engine.objects.get(o.id).fontSize, 24);
    assert.equal(f.engine.objects.get(o.id).x, 100);
    f.engine.redo();
    assert.equal(f.engine.objects.get(o.id).fontSize, 36);
    f.engine.down(target);
    f.engine.move(f.event(target.clientX + 60, target.clientY + 60, 0));
    f.engine.cancel();
    assert.equal(f.engine.objects.get(o.id).width, 450);
    assert.equal(f.engine.objects.get(o.id).fontSize, 36);
  });
}

test('wheel animation reverses promptly, normalizes lines and respects reduced motion', () => {
  const f = fixture();
  const wheel = (deltaY, deltaMode = 0) => ({ ...f.event(300, 200), deltaY, deltaMode });
  f.engine.wheel(wheel(-100));
  f.tick();
  const partial = f.engine.camera.zoom;
  f.engine.wheel(wheel(100));
  f.tick();
  assert.ok(f.engine.camera.zoom < partial, 'reverse must not continue zooming in');
  f.engine.stopCameraAnimation();
  f.motion.matches = true;
  const start = f.engine.camera.zoom;
  f.engine.wheel(wheel(-3, 1));
  assert.ok(Math.abs(f.engine.camera.zoom / start - Math.exp(0.048)) < 1e-9);
  const immediate = f.engine.camera.zoom;
  f.tick();
  assert.equal(f.engine.camera.zoom, immediate);
});

test('wheel animation stops for pan, fit, flush and disposal and does not alter active drags', () => {
  for (const stop of ['pan', 'fit', 'flush', 'destroy']) {
    const f = fixture();
    f.engine.wheel({ ...f.event(300, 200), deltaY: -100 });
    f.tick();
    if (stop === 'pan') f.engine.down(f.event(300, 200, 2));
    if (stop === 'fit') f.engine.fit();
    if (stop === 'flush') f.engine.stopCameraAnimation();
    if (stop === 'destroy') f.engine.destroy();
    const c = { ...f.engine.camera };
    for (let i = 0; i < 40; i++) f.tick();
    assert.deepEqual({ ...f.engine.camera }, c, stop);
    if (stop === 'pan') {
      f.engine.wheel({ ...f.event(300, 200), deltaY: -100 });
      f.tick();
      assert.deepEqual({ ...f.engine.camera }, c, 'ignore wheel during drag');
    }
  }
});

test('wheel bursts accumulate without overshoot and clamp at zoom limits', () => {
  const f = fixture();
  const wheel = (deltaY) => ({ ...f.event(300, 200), deltaY });
  for (let i = 0; i < 5; i++) f.engine.wheel(wheel(-100));
  let previous = 2;
  for (let i = 0; i < 40; i++) {
    f.tick();
    assert.ok(f.engine.camera.zoom >= previous);
    assert.ok(f.engine.camera.zoom <= 2 * Math.exp(0.5) + 1e-9);
    previous = f.engine.camera.zoom;
  }
  assert.ok(Math.abs(f.engine.camera.zoom - 2 * Math.exp(0.5)) < 1e-9);
  for (let i = 0; i < 100; i++) f.engine.wheel(wheel(-10000));
  for (let i = 0; i < 60; i++) f.tick();
  assert.equal(f.engine.camera.zoom, 8);
  for (let i = 0; i < 100; i++) f.engine.wheel(wheel(10000));
  for (let i = 0; i < 60; i++) f.tick();
  assert.equal(f.engine.camera.zoom, 0.025);
});

for (const corner of ['nw', 'ne', 'sw', 'se'])
  test(`multi-selection ${corner} scales proportionally with one undo and cancellation`, () => {
    const f = fixture();
    f.engine.camera = { x: 0, y: 0, zoom: 1 };
    const items = [
      {
        id: 'a',
        type: 'text',
        x: 100,
        y: 100,
        width: 100,
        height: 50,
        fontSize: 20,
        text: 'Scale',
        z: 1,
      },
      {
        id: 'b',
        type: 'note',
        x: 300,
        y: 200,
        width: 100,
        height: 100,
        // A chosen note size scales with the group.
        fontSize: 18,
        text: 'Together',
        z: 2,
      },
    ];
    f.engine.apply({ upserts: items, deleted: [] });
    f.engine.setSelection(['a', 'b']);
    const west = corner.includes('w'),
      north = corner.includes('n');
    const x = west ? 100 : 400,
      y = north ? 100 : 300;
    const dx = west ? -150 : 150,
      dy = north ? -100 : 100;
    f.engine.down(f.event(x, y, 0));
    f.engine.move(f.event(x + dx, y + dy, 0));
    f.engine.up(f.event(x + dx, y + dy, 0));
    const anchor = { x: west ? 400 : 100, y: north ? 300 : 100 };
    for (const o of items) {
      const n = f.engine.objects.get(o.id);
      assert.equal(n.width, o.width * 1.5);
      assert.equal(n.height, o.height * 1.5);
      assert.equal(n.fontSize, o.fontSize * 1.5);
      assert.equal(n.x, anchor.x + (o.x - anchor.x) * 1.5);
      assert.equal(n.y, anchor.y + (o.y - anchor.y) * 1.5);
    }
    f.engine.undo();
    for (const o of items) assert.deepEqual({ ...f.engine.objects.get(o.id) }, o);
    f.engine.down(f.event(x, y, 0));
    f.engine.move(f.event(x + dx, y + dy, 0));
    f.engine.cancel();
    for (const o of items) assert.deepEqual({ ...f.engine.objects.get(o.id) }, o);
  });

test('multi-selection scaling includes frame contents exactly once', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const items = [
    { id: 'frame', type: 'frame', x: 100, y: 100, width: 300, height: 300, fontSize: 14, z: 0 },
    { id: 'inside', type: 'note', x: 150, y: 150, width: 100, height: 100, fontSize: 21, z: 1 },
    { id: 'outside', type: 'rect', x: 500, y: 100, width: 100, height: 100, z: 2 },
  ];
  f.engine.apply({ upserts: items, deleted: [] });
  f.engine.setSelection(['frame', 'outside']);
  f.engine.down(f.event(600, 400, 0));
  f.engine.move(f.event(850, 550, 0));
  f.engine.up(f.event(850, 550, 0));
  const child = f.engine.objects.get('inside');
  assert.equal(child.width, 150);
  assert.equal(child.x, 175);
  // Auto-sized note text needs no stored size: it refits to the larger note.
  assert.equal(child.fontSize, 21);
  f.engine.undo();
  for (const o of items) assert.deepEqual({ ...f.engine.objects.get(o.id) }, o);
});

test('arrow draw, midpoint insertion, endpoint drag, undo and Escape work in screen coordinates', () => {
  const f = fixture('arrow');
  f.engine.camera = { x: 20, y: 30, zoom: 2 };
  f.engine.down(f.event(220, 230, 0));
  f.engine.move(f.event(620, 230, 0));
  f.engine.up(f.event(620, 230, 0));
  const o = f.engine.selected[0];
  assert.equal(o.type, 'arrow');
  assert.equal(o.x, 100);
  assert.equal(o.width, 200);
  assert.equal(o.height, 1);
  assert.equal(f.engine.tool, 'select');
  assert.equal(f.edits.at(-1).upserts[0].id, o.id);
  // Drag the midpoint down to create a bend, without changing the ends.
  f.engine.down(f.event(420, 230, 0));
  f.engine.move(f.event(420, 430, 0));
  f.engine.up(f.event(420, 430, 0));
  const bent = f.engine.objects.get(o.id);
  assert.equal(bent.arrow.points.length, 3);
  assert.equal(bent.height, 100);
  f.engine.undo();
  assert.equal(f.engine.objects.get(o.id).arrow.points.length, 2);
  f.engine.redo();
  assert.equal(f.engine.objects.get(o.id).arrow.points.length, 3);
  f.engine.down(f.event(620, 230, 0));
  f.engine.move(f.event(700, 250, 0));
  f.engine.cancel();
  assert.deepEqual({ ...f.engine.objects.get(o.id) }, { ...bent });
  f.engine.undo();
  f.engine.undo();
  assert.equal(f.engine.objects.has(o.id), false);
  f.engine.setTool('arrow');
  f.engine.down(f.event(100, 100, 0));
  f.engine.move(f.event(200, 200, 0));
  f.engine.cancel();
  assert.equal(f.engine.objects.size, 0);
});

test('gallery resize previews return to original size, cancel and undo together', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  f.engine.apply({
    upserts: [
      {
        id: 'gallery',
        type: 'frame',
        text: 'Gallery',
        x: 100,
        y: 100,
        width: 432,
        height: 180,
        z: 0,
        gallery: { direction: 'below', size: 400, gap: 12 },
      },
      {
        id: 'image',
        type: 'image',
        x: 0,
        y: 0,
        width: 400,
        height: 200,
        z: 1,
        galleryId: 'gallery',
        galleryIndex: 0,
      },
    ],
    deleted: [],
  });
  f.engine.setSelection(['gallery']);
  const original = structuredClone(f.engine.all);
  f.engine.down(f.event(532, 216, 0));
  f.engine.move(f.event(732, 216, 0));
  assert.equal(f.engine.objects.get('image').width, 600);
  f.engine.move(f.event(532, 216, 0));
  assert.equal(f.engine.objects.get('image').width, 400, 'returning pointer resets image preview');
  f.engine.move(f.event(632, 216, 0));
  f.engine.cancel();
  for (const o of original) assert.deepEqual({ ...f.engine.objects.get(o.id) }, o);
  f.engine.down(f.event(532, 216, 0));
  f.engine.move(f.event(632, 216, 0));
  f.engine.up(f.event(632, 216, 0));
  assert.equal(f.engine.objects.get('image').width, 500);
  f.engine.undo();
  for (const o of original) assert.deepEqual({ ...f.engine.objects.get(o.id) }, o);
});

test('matrix resize excludes fixed gaps and does not rescale again on release', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const gallery = {
    id: 'matrix',
    type: 'frame',
    text: 'Matrix',
    x: 100,
    y: 100,
    width: 432,
    height: 180,
    z: 0,
    gallery: { direction: 'below', size: 400, gap: 12 },
  };
  const images = Array.from({ length: 3 }, (_, i) => ({
    id: 'cell-' + i,
    type: 'image',
    x: 0,
    y: 0,
    width: 400,
    height: 200,
    z: 1,
    galleryId: 'matrix',
    galleryIndex: i,
    galleryRow: 0,
    galleryColumn: i,
  }));
  f.engine.apply({ upserts: [gallery, ...images], deleted: [] });
  f.engine.setSelection(['matrix']);
  const original = structuredClone(f.engine.all),
    g = f.engine.objects.get('matrix'),
    edge = g.x + g.width,
    y = g.y + g.height / 2;
  f.engine.down(f.event(edge, y, 0));
  f.engine.move(f.event(edge - 300, y, 0));
  assert.equal(f.engine.objects.get('matrix').width, g.width - 300);
  assert.equal(f.engine.objects.get('cell-0').width, 300);
  f.engine.up(f.event(edge - 300, y, 0));
  assert.equal(f.engine.objects.get('matrix').width, g.width - 300);
  assert.equal(f.engine.objects.get('cell-0').width, 300);
  f.engine.undo();
  for (const o of original) assert.deepEqual({ ...f.engine.objects.get(o.id) }, o);
});

test('finger gestures are Android-only: desktop touch still box-selects, Android pans and pinches', () => {
  const touch = (f, id, x, y) => ({ ...f.event(x, y, 0), pointerType: 'touch', pointerId: id });
  const desktop = fixture();
  desktop.engine.camera = { x: 0, y: 0, zoom: 1 };
  desktop.engine.down(touch(desktop, 1, 200, 200));
  assert.equal(desktop.engine.gesture.mode, 'box');
  desktop.engine.up(touch(desktop, 1, 200, 200));

  const phone = fixture();
  phone.engine.setTouchGestures(true);
  phone.engine.camera = { x: 0, y: 0, zoom: 1 };
  phone.engine.down(touch(phone, 1, 200, 200));
  assert.equal(phone.engine.gesture.mode, 'pan');
  phone.engine.move(touch(phone, 1, 230, 210));
  assert.deepEqual([phone.engine.camera.x, phone.engine.camera.y], [30, 10]);
  // A second finger turns it into a pinch around the midpoint.
  phone.engine.down(touch(phone, 2, 330, 210));
  assert.equal(phone.engine.gesture, null);
  phone.engine.move(touch(phone, 1, 180, 210));
  phone.engine.move(touch(phone, 2, 380, 210));
  assert.equal(phone.engine.camera.zoom, 2);
  phone.engine.up(touch(phone, 2, 380, 210));
  phone.engine.up(touch(phone, 1, 180, 210));
  phone.engine.destroy?.();
});

test('Android: holding a finger selects – a box on empty board, objects one by one', () => {
  const f = fixture();
  f.engine.setTouchGestures(true);
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const touch = (x, y) => ({ ...f.event(x, y, 0), pointerType: 'touch', pointerId: 1 });
  const note = (id, x) => ({ id, type: 'note', x, y: 100, width: 80, height: 80, z: 1 });
  f.engine.apply({ upserts: [note('a', 100), note('b', 300), note('c', 500)], deleted: [] });
  // Held on empty board, then dragged: a selection box instead of the menu.
  f.engine.down(touch(50, 50));
  f.hold();
  assert.equal(f.engine.gesture.mode, 'box');
  f.engine.move(touch(420, 250));
  f.engine.up(touch(420, 250));
  assert.deepEqual([...f.engine.selection].sort(), ['a', 'b']);
  assert.equal(f.menus.length, 0);
  // Panning keeps the selection; holding another object adds it, holding it again takes it out.
  f.engine.down(touch(700, 400));
  f.engine.move(touch(720, 420));
  f.engine.up(touch(720, 420));
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  assert.deepEqual([...f.engine.selection].sort(), ['a', 'b']);
  f.engine.down(touch(540, 140));
  f.hold();
  f.engine.up(touch(540, 140));
  assert.deepEqual([...f.engine.selection].sort(), ['a', 'b', 'c']);
  f.engine.down(touch(140, 140));
  f.hold();
  f.engine.up(touch(140, 140));
  assert.deepEqual([...f.engine.selection].sort(), ['b', 'c']);
  assert.equal(f.engine.objects.get('a').x, 100);
  // Held on empty board and lifted without dragging: the board's menu, as before.
  f.engine.down(touch(800, 600));
  f.hold();
  f.engine.up(touch(800, 600));
  assert.equal(f.menus.length, 1);
  // A tap on empty board clears the selection.
  f.tick(1000);
  f.engine.down(touch(800, 500));
  f.engine.up(touch(800, 500));
  assert.deepEqual([...f.engine.selection], []);
});

// --- Live edits: what a drag sends to the other people on a cloud board ---------------

const liveNote = { id: 'a', type: 'note', x: 100, y: 100, width: 100, height: 100, z: 1 };
// The engine runs in its own VM context: compare plain copies.
const sent = (f) => JSON.parse(JSON.stringify(f.live));
const drag = (f, from, to) => {
  f.engine.down(f.event(from.x, from.y, 0));
  for (const p of to) f.engine.move({ ...f.event(p.x, p.y, 0), altKey: true });
};

test('a drag sends what it moves on every frame, then where it landed, then its end', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  f.engine.apply({ upserts: [liveNote], deleted: [] });
  f.live.length = 0;
  drag(f, { x: 150, y: 150 }, [
    { x: 160, y: 150 },
    { x: 190, y: 150 },
  ]);
  f.engine.up({ ...f.event(190, 150, 0), altKey: true });
  assert.deepEqual(sent(f), [[{ id: 'a', x: 110 }], [{ id: 'a', x: 140 }], { edit: ['a'] }, null]);
});

test('a click sends nothing; a cancelled drag ends without an edit', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  f.engine.apply({ upserts: [liveNote], deleted: [] });
  f.live.length = 0;
  f.engine.down(f.event(150, 150, 0));
  f.engine.up(f.event(150, 150, 0));
  assert.deepEqual(sent(f), []);
  drag(f, { x: 150, y: 150 }, [{ x: 200, y: 150 }]);
  f.engine.prepareExternalEdit();
  assert.deepEqual(sent(f), [[{ id: 'a', x: 150 }], null]);
  assert.equal(f.engine.objects.get('a').x, 100);
});

test("someone else's drag is shown without an edit, but not on what is being dragged here", () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const b = { ...liveNote, id: 'b', x: 400 };
  f.engine.apply({ upserts: [liveNote, b], deleted: [] });
  const edits = f.edits.length;
  f.engine.previewRemote([
    { ...liveNote, x: 120 },
    { ...liveNote, id: 'unknown' },
  ]);
  assert.equal(f.engine.objects.get('a').x, 120);
  assert.equal(f.engine.objects.has('unknown'), false, 'only objects on this board');
  assert.equal(f.edits.length, edits, 'nothing is saved');
  drag(f, { x: 450, y: 150 }, [{ x: 470, y: 150 }]);
  assert.equal(f.engine.inGesture('b'), true);
  assert.equal(f.engine.inGesture('a'), false);
  f.engine.previewRemote([{ ...b, x: 0 }]);
  assert.equal(f.engine.objects.get('b').x, 420, 'the drag here wins');
});

test('Android: a tap inside a frame selects it, and a finger then drags it', () => {
  const f = fixture();
  f.engine.setTouchGestures(true);
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const touch = (x, y) => ({ ...f.event(x, y, 0), pointerType: 'touch', pointerId: 1 });
  f.engine.apply({
    upserts: [
      { id: 'f', type: 'frame', x: 100, y: 100, width: 400, height: 300, z: -1, text: 'Plan' },
    ],
    deleted: [],
  });
  f.engine.down(touch(300, 250));
  f.engine.up(touch(300, 250));
  assert.deepEqual([...f.engine.selection], ['f']);
  f.tick(1000);
  f.engine.down(touch(300, 250));
  f.engine.move(touch(340, 270));
  f.engine.up(touch(340, 270));
  assert.deepEqual([f.engine.objects.get('f').x, f.engine.objects.get('f').y], [140, 120]);
});

test('view mode: a tap uses the object instead of selecting it, and drags pan', () => {
  const f = fixture();
  f.engine.setTouchGestures(true);
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  const taps = [];
  f.engine.callbacks.viewTap = (o) => taps.push(o?.id ?? null);
  const touch = (x, y) => ({ ...f.event(x, y, 0), pointerType: 'touch', pointerId: 1 });
  f.engine.apply({
    upserts: [{ id: 'n', type: 'note', x: 100, y: 100, width: 80, height: 80, z: 1 }],
    deleted: [],
  });
  f.engine.setViewMode(true);
  f.engine.down(touch(140, 140));
  f.hold();
  f.engine.up(touch(140, 140));
  assert.deepEqual([...f.engine.selection], []);
  assert.deepEqual(taps, ['n']);
  f.tick(1000);
  f.engine.down(touch(140, 140));
  f.engine.move(touch(200, 170));
  f.engine.up(touch(200, 170));
  assert.equal(f.engine.objects.get('n').x, 100, 'nothing moves');
  assert.deepEqual([f.engine.camera.x, f.engine.camera.y], [60, 30]);
  assert.deepEqual(taps, ['n'], 'a drag is no tap');
  assert.equal(f.menus.length, 0);
  f.engine.setViewMode(false);
  f.tick(1000);
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  f.engine.down(touch(140, 140));
  f.engine.up(touch(140, 140));
  assert.deepEqual([...f.engine.selection], ['n']);
});

test('locked objects let presses through; holding one for two seconds selects it', () => {
  const f = fixture();
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  f.engine.apply({
    upserts: [
      { id: 'l', type: 'note', x: 100, y: 100, width: 80, height: 80, z: 1, locked: true },
      { id: 'n', type: 'note', x: 300, y: 100, width: 80, height: 80, z: 2 },
    ],
    deleted: [],
  });
  // A click on it selects nothing and starts a selection box, which leaves it out.
  f.engine.down(f.event(140, 140, 0));
  assert.equal(f.engine.gesture.mode, 'box');
  f.engine.move(f.event(420, 260, 0));
  f.engine.up(f.event(420, 260, 0));
  assert.deepEqual([...f.engine.selection], ['n']);
  // A finger on it pans.
  f.engine.setTouchGestures(true);
  const touch = (x, y) => ({ ...f.event(x, y, 0), pointerType: 'touch', pointerId: 1 });
  f.engine.down(touch(140, 140));
  assert.equal(f.engine.gesture.mode, 'pan');
  f.engine.move(touch(150, 150));
  f.engine.up(touch(150, 150));
  assert.equal(f.engine.objects.get('l').x, 100);
  // Held for two seconds, it is selected (to be unlocked).
  f.engine.camera = { x: 0, y: 0, zoom: 1 };
  f.tick(1000);
  f.engine.down(touch(140, 140));
  f.hold();
  assert.deepEqual([...f.engine.selection], ['l']);
  f.engine.up(touch(140, 140));
  assert.deepEqual([...f.engine.selection], ['l']);
});
