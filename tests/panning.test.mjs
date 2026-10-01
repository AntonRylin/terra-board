import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
import { localToWorld } from '../src/canvas/transform.ts';

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
    activations = [];
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
  const context = {
    exports,
    require: localRequire,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    window: { addEventListener() {}, removeEventListener() {} },
    devicePixelRatio: 1,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    performance,
    crypto,
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
      },
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
  return { engine, host, menus, saves, event, activations, edits };
}

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
    const zoomedIn = { ...f.engine.camera };
    assert.ok(zoomedIn.zoom > 2, 'wheel up must zoom in');
    f.engine.wheel(wheel(100));
    assert.ok(f.engine.camera.zoom < zoomedIn.zoom, 'wheel down must zoom out');
    for (const camera of [zoomedIn, f.engine.camera]) {
      assert.ok(Math.abs(140 * camera.zoom + camera.x - 300) < 1e-9);
      assert.ok(Math.abs(85 * camera.zoom + camera.y - 200) < 1e-9);
    }
    assert.equal(prevented, 2);
    assert.equal(f.saves.length, 2);
    assert.deepEqual(f.saves[1], { ...f.engine.camera });
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
