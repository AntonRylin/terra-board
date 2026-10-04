import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const filename = new URL('../src/components/CanvasPdfComposers.tsx', import.meta.url);
function api() {
  if (!existsSync(filename)) return {};
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require(id) {
      if (id.endsWith('.css')) return {};
      if (id === '../canvas/pdf-composer-files') return { ComposerPreviewPool: class {} };
      if (
        id === '../canvas/pdf-composer' ||
        id === '../canvas/pdf-render' ||
        id === './ListEditOutline'
      )
        return {};
      if (id === '../canvas/transform')
        return { localToWorld: (o, p) => ({ x: o.x + p.x, y: o.y + p.y }) };
      return require(id);
    },
  });
  return module.exports;
}

test('page and column drops translate before/after positions to final indices without shifting neighbors', () => {
  const { composerInsertionIndex: index } = api();
  assert.equal(typeof index, 'function');
  assert.equal(index(['a', 'b', 'c'], 'a', 'c', true), 2);
  assert.equal(index(['a', 'b', 'c'], 'a', 'b', false), 0);
  assert.equal(index(['a', 'b', 'c'], 'c', 'a', false), 0);
  assert.equal(index(['a', 'b', 'c'], 'outside', 'b', true), 2);
  assert.equal(index(['a', 'b', 'c'], 'a', null, true), 2);
  assert.equal(index([], 'outside', null, true), 0);
});

test('composer overlay follows world geometry and exposes page, column and empty-column controls', () => {
  const { default: Component } = api();
  assert.equal(typeof Component, 'function');
  const { createElement } = require('react'),
    { renderToStaticMarkup } = require('react-dom/server');
  const object = {
    id: 'composer',
    type: 'frame',
    x: 100,
    y: 200,
    width: 640,
    height: 480,
    z: 1,
    text: 'PDF pages',
    pdfComposer: {
      sources: [{ id: 's', assetId: 'a', name: 'Source.pdf', kind: 'pdf', pageCount: 1 }],
      columns: [
        {
          id: 'one',
          name: 'Source.pdf',
          pages: [{ id: 'p', sourceId: 's', pageIndex: 0, rotation: 90 }],
        },
        { id: 'empty', name: 'New PDF', pages: [] },
      ],
    },
  };
  const html = renderToStaticMarkup(
    createElement(Component, {
      objects: [object],
      camera: { x: 10, y: 20, zoom: 2 },
      selectedIds: ['composer'],
      editingId: null,
      onEdit() {},
      onSelect() {},
      onUpdate() {},
      onPointerDown() {},
      async onFiles() {},
      async onExport() {},
      onUndo() {},
      onRedo() {},
      onError() {},
    }),
  );
  assert.match(html, /data-composer-id="composer"/);
  assert.match(html, /left:210px/);
  assert.match(html, /top:420px/);
  assert.match(html, /scale\(2\)/);
  assert.match(html, /data-page-id="p"/);
  assert.match(html, /data-column-id="empty"/);
  assert.match(html, /aria-label="Export Source.pdf as PDF"/);
  assert.match(html, /aria-label="New PDF column"/);
  assert.match(
    html,
    /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown Alt\+ArrowLeft Alt\+ArrowRight"/,
  );
});

function motionFixture() {
  const animations = [];
  const root = {
    dataset: {},
    parentElement: null,
    children: [],
    querySelectorAll: () => root.children,
    append(node) {
      node.parentElement = root;
    },
  };
  function node(kind, id, x, y, column) {
    const value = {
      dataset: kind === 'column' ? { columnId: id } : { pageId: id },
      offsetLeft: x,
      offsetTop: y,
      offsetWidth: kind === 'column' ? 192 : 162,
      offsetHeight: 202,
      offsetParent: root,
      parentElement: root,
      style: {},
      className: kind === 'column' ? 'pdf-composer-column' : 'pdf-composer-page',
      closest: () => column || value,
      querySelectorAll: () => [],
      setAttribute() {},
      removeAttribute() {},
      remove() {
        value.removed = true;
      },
      cloneNode() {
        return node('page', id, x, y, column);
      },
      animate(frames, options) {
        let resolve;
        const animation = {
          frames,
          options,
          node: value,
          finished: new Promise((done) => {
            resolve = done;
          }),
          cancelled: false,
          cancel() {
            this.cancelled = true;
            resolve();
          },
        };
        animations.push(animation);
        return animation;
      },
    };
    return value;
  }
  const a = node('column', 'a', 0, 0),
    b = node('column', 'b', 206, 0);
  const p = node('page', 'p', 10, 60, a),
    q = node('page', 'q', 10, 136, a);
  root.children = [a, p, q, b];
  return { root, node, a, b, p, q, animations };
}

test('composer layout motion animates moved columns once without double-transforming their pages', () => {
  const { ComposerLayoutMotion } = api();
  assert.equal(typeof ComposerLayoutMotion, 'function');
  const f = motionFixture(),
    motion = new ComposerLayoutMotion();
  motion.update(f.root, false);
  f.a.offsetLeft = 206;
  f.b.offsetLeft = 0;
  f.p.offsetLeft += 206;
  f.q.offsetLeft += 206;
  motion.update(f.root, false);
  assert.equal(f.animations.length, 2);
  assert.ok(f.animations.every((animation) => animation.node.dataset.columnId));
  assert.equal(f.animations[0].frames[0].transform, 'translate(-206px, 0px)');
  assert.equal(f.root.dataset.layoutAnimating, 'true');
  motion.finish();
  assert.ok(f.animations.every((animation) => animation.cancelled));
  assert.equal(f.root.dataset.layoutAnimating, undefined);
  assert.equal(f.a.dataset.layoutMotion, undefined);
});

test('cross-column movement keeps one global page identity and animates an unclipped preview', () => {
  const { ComposerLayoutMotion } = api();
  assert.equal(typeof ComposerLayoutMotion, 'function');
  const f = motionFixture(),
    motion = new ComposerLayoutMotion();
  motion.update(f.root, false);
  const moved = f.node('page', 'p', 216, 60, f.b);
  f.root.children = [f.a, f.q, f.b, moved];
  motion.update(f.root, false);
  const flight = f.animations.find((animation) => animation.node.dataset.motionPageId === 'p');
  assert.ok(flight);
  assert.equal(flight.node.dataset.pageId, undefined, 'DOM page identity remains unique');
  assert.equal(
    flight.node.parentElement,
    f.root,
    'the moving preview is outside both scroll clips',
  );
  assert.equal(flight.frames[0].transform, 'translate(-206px, 0px)');
  assert.equal(moved.dataset.motionHidden, 'true');
  motion.finish();
  assert.equal(moved.dataset.motionHidden, undefined);
  assert.equal(flight.node.removed, true);
});

test('new pages enter softly while reduced motion and a new gesture settle all layout effects', () => {
  const { ComposerLayoutMotion } = api();
  assert.equal(typeof ComposerLayoutMotion, 'function');
  const f = motionFixture(),
    motion = new ComposerLayoutMotion();
  motion.update(f.root, false);
  const added = f.node('page', 'added', 216, 60, f.b);
  f.root.children.push(added);
  motion.update(f.root, false);
  assert.equal(f.animations.length, 1);
  assert.equal(f.animations[0].frames[0].opacity, 0);
  motion.capture(f.root);
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.root.dataset.layoutAnimating, undefined);
  f.p.offsetTop = 136;
  f.q.offsetTop = 60;
  motion.update(f.root, true);
  assert.equal(f.animations.length, 1, 'reduced motion applies final geometry immediately');
});
