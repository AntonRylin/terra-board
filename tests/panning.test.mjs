import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);

// Exercise the actual Engine event handlers without creating a GPU context.
function fixture(tool = 'select') {
  const canvas = { setAttribute() {} },
    menus = [],
    saves = [];
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
      edit() {},
      camera: (c) => saves.push({ ...c }),
      selection() {},
      activate() {},
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
  return { engine, host, menus, saves, event };
}

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
