import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { resizeObject, resizeSelection } from '../src/canvas/resize.ts';
import { localToWorld } from '../src/canvas/transform.ts';
import { listLayout, wrapListText } from '../src/canvas/list-layout.ts';

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

test('list edges extend only their axis and preserve text size through repeated resizes', () => {
  for (const [edge, dx, dy, width, height, x, y] of [
    ['e', 160, 0, 480, 188, 100, 200],
    ['w', -160, 0, 480, 188, -60, 200],
    ['s', 0, 94, 320, 282, 100, 200],
    ['n', 0, -94, 320, 282, 100, 106],
  ]) {
    const resized = resizeObject(list, edge, dx, dy, false);
    assert.deepEqual([resized.width, resized.height, resized.x, resized.y], [width, height, x, y]);
    assert.equal(listLayout(resized).scale, 1);
    const twice = resizeObject(resized, 's', 0, 94, false);
    assert.equal(listLayout(twice).scale, 1);
  }
});

test('list wrapping retains long words, explicit newlines and their endings', () => {
  assert.deepEqual(
    wrapListText('one two\nabcdefgh', 4, (value) => value.length),
    ['one ', 'two', 'abcd', 'efgh'],
  );
});

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
  find(section, (node) => node.props?.label === 'List name').props.onChange('New title');
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
  const title = drawn(card, 'Trip');
  const row = drawn(card, 'Book train');
  assert.equal(title.size * card.scale.x, 30);
  assert.equal(row.size * card.scale.x, 32);
  // The row's 24px line box is centred on its 72px checkbox.
  assert.equal(row.sprite.position.y * card.scale.y, 120);
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
    find(section, (node) => node.props?.label === 'List item 2').props.value,
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
  const rows = [drawn(card, 'Book train'), drawn(card, 'Pack bag')];
  assert.ok(rows.every(Boolean));
  assert.ok(rows.every((row) => (row.sprite.position.y + 32) * card.scale.y <= 188));
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

// Labels are canvas sprites; the canvas stub records what was drawn in which font.
function drawn(card, text) {
  for (const sprite of card.children) {
    const call = sprite.texture?.source.resource.ctx.calls.find((c) => c.text === text);
    if (call) return { sprite, size: Number(/([\d.]+)px/.exec(call.font)[1]) };
  }
}

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
  class Sprite extends Container {
    constructor(texture) {
      super();
      this.texture = texture;
    }
    once() {}
  }
  class Texture {
    constructor({ source }) {
      this.source = source;
    }
  }
  class CanvasSource {
    constructor(options) {
      Object.assign(this, options);
    }
  }
  const pixi = { Container, Graphics, Sprite, Texture, CanvasSource };
  // Rich fields stay unexpanded so tests can drive their onChange like the DOM would.
  const jsx = (type, props) =>
    typeof type === 'function' && type.name !== 'RichTextField' ? type(props) : { type, props };
  const canvas = () => {
    const ctx = {
      calls: [],
      font: '',
      measureText: (value) => ({ width: value.length * 6 }),
      fillText(text, x, y) {
        this.calls.push({ text, font: this.font, x, y });
      },
    };
    for (const method of [
      'scale',
      'fillRect',
      'save',
      'restore',
      'beginPath',
      'roundRect',
      'fill',
      'arc',
    ])
      ctx[method] = () => {};
    return { getContext: () => ctx, ctx };
  };
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
      document: { createElement: canvas },
      require(id) {
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (id === 'react')
          return {
            useEffect() {},
            useLayoutEffect() {},
            useRef: (current) => ({ current }),
            useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
            useMemo: (fn) => fn(),
          };
        if (id === 'lucide-react') return { Check: 'Check', Plus: 'Plus', X: 'X' };
        if (id.endsWith('.css') || id === 'pixi.js/unsafe-eval') return {};
        if (id === 'pixi.js') return pixi;
        if (id.startsWith('.'))
          return load(
            [id, id + '.ts', id + '.tsx']
              .map((candidate) => resolve(dirname(filename), candidate))
              .find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate)),
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
