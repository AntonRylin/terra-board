import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { resizeObject, resizeSelection } from '../src/canvas/resize.ts';
import { localToWorld } from '../src/canvas/transform.ts';

const require = createRequire(import.meta.url);
const list = {
  id: 'list',
  type: 'list',
  x: 100,
  y: 200,
  width: 320,
  height: 188,
  z: 1,
  text: 'Trip',
  items: [
    { id: 'a', text: 'Book train', checked: false },
    { id: 'b', text: 'Pack bag', checked: true },
  ],
};

test('list corners scale the whole card proportionally and pin the opposite corner', () => {
  const horizontal = resizeObject(list, 'se', 100, 0, false);
  assert.ok(Math.abs(horizontal.width / horizontal.height - 320 / 188) < 1e-9);
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const west = corner.includes('w'),
      north = corner.includes('n');
    const enlarged = resizeObject(list, corner, west ? -160 : 160, north ? -94 : 94, false);
    assert.equal(enlarged.width, 480);
    assert.equal(enlarged.height, 282);
    assert.equal(enlarged.x + (west ? enlarged.width : 0), west ? 420 : 100);
    assert.equal(enlarged.y + (north ? enlarged.height : 0), north ? 388 : 200);
    const shrunk = resizeObject(list, corner, west ? 160 : -160, north ? 94 : -94, false);
    assert.equal(shrunk.width, 240);
    assert.equal(shrunk.height, 141);
  }
});

test('group resizing permits smaller proportional lists while keeping every row visible', () => {
  const [resized] = resizeSelection(
    [list],
    { x: 100, y: 200, width: 320, height: 188 },
    'se',
    -160,
    -94,
  );
  assert.equal(resized.width, 240);
  assert.equal(resized.height, 141);
});

test('list DOM scales text, controls, spacing and edit outline with the card at every camera zoom', () => {
  const f = fixture();
  for (const zoom of [0.25, 1, 4]) {
    const object = { ...list, width: 640, height: 376, rotation: 30 };
    const section = f.render(object, zoom);
    assert.equal(section.props.style.width, 320);
    assert.equal(section.props.style.height, 188);
    assert.equal(section.props.style.transform, `scale(${zoom * 2}) rotate(30deg)`);
    const origin = localToWorld(object, { x: 0, y: 0 });
    assert.equal(section.props.style.left, origin.x * zoom + 10);
    assert.equal(section.props.style.top, origin.y * zoom + 20);
    const outline = find(section, (node) => node.type === 'svg');
    assert.equal(outline.props.viewBox, '0 0 320 188');
  }
});

test('adding and removing scaled list rows preserves scale, extra height and rotated top-left position', () => {
  const f = fixture();
  const original = { ...list, width: 640, height: 416, rotation: 30 };
  const section = f.render(original);
  const add = find(section, (node) => node.props?.['aria-label'] === 'Add list item');
  add.props.onClick();
  const added = f.updates.at(-1);
  assert.equal(added.width, 640);
  assert.equal(added.height, 504);
  assert.equal(added.items.length, 3);
  const before = localToWorld(original, { x: 0, y: 0 }),
    after = localToWorld(added, { x: 0, y: 0 });
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-8);
  find(f.render(added), (node) => node.props?.['aria-label'] === 'Remove item 3').props.onClick();
  const removed = f.updates.at(-1);
  assert.equal(removed.height, 416);
  assert.equal(removed.items.length, 2);
  assert.ok(Math.abs(removed.x - original.x) < 1e-8 && Math.abs(removed.y - original.y) < 1e-8);
});

test('scaled list checkboxes and title edits retain card size and item state', () => {
  const f = fixture(),
    object = { ...list, width: 640, height: 376 };
  let section = f.render(object);
  find(section, (node) => node.props?.role === 'checkbox').props.onClick();
  const checked = f.updates.at(-1);
  assert.equal(checked.width, 640);
  assert.equal(checked.height, 376);
  assert.equal(checked.items[0].checked, true);
  section = f.render(checked);
  find(section, (node) => node.props?.['aria-label'] === 'List name').props.onChange({
    target: { value: 'New title' },
  });
  assert.equal(f.updates.at(-1).text, 'New title');
  assert.equal(f.updates.at(-1).width, 640);
  assert.equal(f.updates.at(-1).items[0].checked, true);
});

test('list exports use the same scaled logical geometry as the editable DOM card', () => {
  const f = fixture();
  const Engine = f.load('../src/canvas/engine.ts').Engine;
  const engine = Object.create(Engine.prototype);
  engine.dark = false;
  const view = engine.makeView(
    { ...list, width: 640, height: 376 },
    null,
    true,
    1,
    { x: 0, y: 0, width: 640, height: 376 },
    false,
    null,
    true,
  );
  const card = view.children[0];
  assert.equal(card.scale.x, 2);
  assert.equal(card.scale.y, 2);
  const title = card.children.find((child) => child.text === 'Trip');
  const row = card.children.find((child) => child.text === 'Book train');
  assert.equal(title.style.fontSize * card.scale.x, 30);
  assert.equal(row.style.fontSize * card.scale.x, 32);
  assert.equal(row.position.y * card.scale.y, 124);
});

test('legacy wide short lists retain their geometry and show every row in the DOM and export', () => {
  const f = fixture();
  const legacy = { ...list, width: 640, height: 188 };
  const original = structuredClone(legacy);
  const section = f.render(legacy);
  assert.equal(section.props['data-list-scale'], 1);
  assert.equal(section.props.style.width, 640);
  assert.equal(section.props.style.height, 188);
  assert.equal(section.props.style.transform, 'scale(1) rotate(0deg)');
  assert.equal(
    find(section, (node) => node.props?.['aria-label'] === 'List item 2').props.value,
    'Pack bag',
  );
  const Engine = f.load('../src/canvas/engine.ts').Engine;
  const engine = Object.create(Engine.prototype);
  engine.dark = false;
  const view = engine.makeView(
    legacy,
    null,
    true,
    1,
    { x: 0, y: 0, width: 640, height: 188 },
    false,
    null,
    true,
  );
  const card = view.children[0];
  assert.equal(card.scale.x, 1);
  const rows = card.children.filter(
    (child) => child.text === 'Book train' || child.text === 'Pack bag',
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => (row.position.y + 32) * card.scale.y <= 188));
  assert.deepEqual(legacy, original, 'rendering must not migrate saved geometry or content');
});

test('legacy list corner resizing scales text and geometry together without normalizing its aspect', () => {
  const f = fixture();
  const legacy = { ...list, width: 640, height: 188 };
  const enlarged = resizeObject(legacy, 'se', 320, 94, false);
  assert.equal(enlarged.width, 960);
  assert.equal(enlarged.height, 282);
  assert.equal(enlarged.x, 100);
  assert.equal(enlarged.y, 200);
  const section = f.render(enlarged);
  assert.equal(section.props['data-list-scale'], 1.5);
  assert.equal(section.props.style.width, 640);
  assert.equal(section.props.style.height, 188);
  assert.equal(section.props.style.transform, 'scale(1.5) rotate(0deg)');
  const restored = resizeObject(enlarged, 'se', -320, -94, false);
  assert.ok(Math.abs(restored.width - 640) < 1e-9);
  assert.ok(Math.abs(restored.height - 188) < 1e-9);
});

test('legacy list row addition and removal preserve its effective text scale', () => {
  const f = fixture();
  const legacy = { ...list, width: 640, height: 188 };
  find(f.render(legacy), (node) => node.props?.['aria-label'] === 'Add list item').props.onClick();
  const added = f.updates.at(-1);
  assert.equal(added.width, 640);
  assert.equal(added.height, 232);
  assert.equal(f.render(added).props['data-list-scale'], 1);
  find(f.render(added), (node) => node.props?.['aria-label'] === 'Remove item 3').props.onClick();
  const removed = f.updates.at(-1);
  assert.equal(removed.height, 188);
  assert.equal(f.render(removed).props['data-list-scale'], 1);
});

function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

// Execute the real component/event handlers; browser effects and GPU rendering
// are covered by the packaged interaction check instead of Node DOM shims.
function fixture() {
  const modules = new Map(),
    updates = [];
  const position = () => ({
    x: 0,
    y: 0,
    set(x, y = x) {
      this.x = x;
      this.y = y;
    },
  });
  class Container {
    children = [];
    position = position();
    scale = position();
    pivot = position();
    addChild(...children) {
      this.children.push(...children);
      return children[0];
    }
  }
  class Graphics extends Container {}
  for (const method of ['roundRect', 'rect', 'fill', 'stroke', 'circle', 'moveTo', 'lineTo'])
    Graphics.prototype[method] = function () {
      return this;
    };
  class Text extends Container {
    constructor(options) {
      super();
      Object.assign(this, options);
      this.width = this.text.length * this.style.fontSize * 0.5;
    }
  }
  const pixi = { Container, Graphics, Text };
  const jsx = (type, props) => (typeof type === 'function' ? type(props) : { type, props });
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
  function load(path) {
    const filename = resolve(sourceRoot, path);
    if (modules.has(filename)) return modules.get(filename);
    const exports = {};
    modules.set(filename, exports);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    vm.runInNewContext(code, {
      exports,
      crypto,
      window: {},
      document: {
        createElement: () => ({
          getContext: () => ({ measureText: (value) => ({ width: value.length * 6 }) }),
        }),
      },
      require(id) {
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === 'react')
          return {
            useEffect() {},
            useLayoutEffect() {},
            useRef: (current) => ({ current }),
            useMemo: (fn) => fn(),
          };
        if (id === 'lucide-react') return { Check: 'Check', Plus: 'Plus', X: 'X' };
        if (id.endsWith('.css') || id === 'pixi.js/unsafe-eval') return {};
        if (id === 'pixi.js') return pixi;
        if (id.startsWith('.'))
          return load(
            resolve(
              dirname(filename),
              id + (/\.tsx?$/.test(id) ? '' : id === './ListEditOutline' ? '.tsx' : '.ts'),
            ),
          );
        return require(id);
      },
    });
    return exports;
  }
  function render(object, zoom = 1) {
    const tree = load('../src/components/CanvasLists.tsx').default({
      view: { objects: [object], camera: { x: 10, y: 20, zoom } },
      update: (o) => updates.push(o),
      select() {},
      selected: [object.id],
      host: null,
      interactive: true,
      beginPointer() {},
      editingId: object.id,
      onEdit() {},
    });
    return find(tree, (node) => node.type === 'section');
  }
  return { load, render, updates };
}
