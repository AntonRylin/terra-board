import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { textAppearance } from '../src/canvas/text-style.ts';
import { textPlacement } from '../src/canvas/text-alignment.ts';
import { resizeObject } from '../src/canvas/resize.ts';
import { localToWorld } from '../src/canvas/transform.ts';

const require = createRequire(import.meta.url);
const documentObject = {
  id: 'document',
  type: 'document',
  x: 100,
  y: 100,
  width: 320,
  height: 400,
  z: 1,
  assetId: 'a'.repeat(64),
  text: 'project-report.pdf',
  documentTitle: 'Project report',
  documentMime: 'application/pdf',
  documentBytes: 2048,
};

test('document corner resizing preserves its aspect and rotated opposite anchor; edges and Shift resize freely', () => {
  const original = { ...documentObject, rotation: 35 };
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const opposite = { x: corner.includes('w') ? 320 : 0, y: corner.includes('n') ? 400 : 0 };
    const anchor = localToWorld(original, opposite);
    const resized = resizeObject(original, corner, 80, 20, false);
    assert.ok(Math.abs(resized.width / resized.height - 0.8) < 1e-9);
    const after = localToWorld(resized, {
      x: corner.includes('w') ? resized.width : 0,
      y: corner.includes('n') ? resized.height : 0,
    });
    assert.ok(Math.hypot(after.x - anchor.x, after.y - anchor.y) < 1e-8);
  }
  const free = resizeObject(documentObject, 'se', 80, 20, true);
  assert.equal(free.width, 400);
  assert.equal(free.height, 420);
  const edge = resizeObject(documentObject, 'e', 80, 100, false);
  assert.equal(edge.width, 400);
  assert.equal(edge.height, 400);
});

test('document titles stay above the card with image styling and never replace its filename', () => {
  const appearance = textAppearance(documentObject);
  assert.equal(appearance.fontSize, 12);
  assert.equal(appearance.padding, 0);
  const placement = textPlacement(
    { ...documentObject, centerX: true, centerY: true },
    { ...appearance, wrapWidth: 320 },
    2,
  );
  assert.equal(placement.left, 0);
  assert.equal(placement.top + placement.height, -8);
  const f = fixture();
  const fitted = f
    .load('../src/canvas/text-layout.ts')
    .fitTextObject(documentObject, 'Renamed title');
  assert.equal(fitted.documentTitle, 'Renamed title');
  assert.equal(fitted.text, 'project-report.pdf');
  assert.equal(fitted.width, 320);
  assert.equal(fitted.height, 400);
  const { visualBounds, hitsFrameLabel } = f.load('../src/canvas/frame-label.ts');
  assert.ok(visualBounds(documentObject).y < documentObject.y);
  assert.equal(hitsFrameLabel(documentObject, { x: 20, y: -15 }), true);
  assert.equal(hitsFrameLabel({ ...documentObject, documentTitle: '' }, { x: 20, y: -15 }), false);
  assert.ok(visualBounds({ ...documentObject, documentTitle: '' }, true).y < documentObject.y);
});

test('document single clicks select and move while double click opens the reader', () => {
  const f = fixture();
  f.engine.apply({ upserts: [documentObject], deleted: [] });
  for (let i = 0; i < 2; i++) {
    f.engine.down(f.event(180, 180));
    f.engine.up(f.event(180, 180));
  }
  assert.deepEqual([...f.engine.selection], ['document']);
  assert.equal(f.activations.length, 0);
  f.engine.doubleClick(f.event(180, 180));
  assert.deepEqual(f.activations, ['document']);
});

test('document hydration preserves live gestures, persists committed geometry, and survives undo and redo without an extra history step', () => {
  const f = fixture();
  assert.equal(typeof f.engine.hydrateDocument, 'function');
  f.engine.apply({ upserts: [documentObject], deleted: [] });
  f.engine.down(f.event(180, 180));
  f.engine.move({ ...f.event(220, 210), altKey: true });
  f.engine.hydrateDocument('document', documentObject.assetId, {
    documentPreviewId: 'b'.repeat(64),
    documentPageCount: 4,
  });
  assert.equal(f.engine.objects.get('document').x, 140);
  assert.equal(f.edits.at(-1).upserts[0].x, 100);
  f.engine.move({ ...f.event(230, 220), altKey: true });
  assert.equal(f.engine.objects.get('document').documentPageCount, 4);
  f.engine.up(f.event(230, 220));
  f.engine.undo();
  assert.equal(f.engine.objects.get('document').x, 100);
  assert.equal(f.engine.objects.get('document').documentPreviewId, 'b'.repeat(64));
  f.engine.redo();
  assert.equal(f.engine.objects.get('document').x, 150);
  f.engine.undo();
  f.engine.undo();
  assert.equal(f.engine.objects.has('document'), false);
});

test('document hydration ignores deleted objects and replaced assets, and keeps a title edit preview', () => {
  const f = fixture();
  assert.equal(typeof f.engine.hydrateDocument, 'function');
  f.engine.apply({ upserts: [documentObject], deleted: [] });
  f.engine.setEditingPreview({ ...documentObject, documentTitle: 'Draft title' });
  f.engine.hydrateDocument('document', documentObject.assetId, { documentExcerpt: 'Page content' });
  assert.equal(f.engine.editingPreview.documentTitle, 'Draft title');
  assert.equal(f.engine.editingPreview.documentExcerpt, 'Page content');
  f.engine.apply({ upserts: [{ ...documentObject, assetId: 'c'.repeat(64) }], deleted: [] });
  const edits = f.edits.length;
  f.engine.hydrateDocument('document', documentObject.assetId, { documentExcerpt: 'Stale' });
  assert.equal(f.edits.length, edits);
  assert.equal(f.engine.objects.get('document').documentExcerpt, undefined);
  f.engine.apply({ upserts: [], deleted: ['document'] });
  const deletedEdits = f.edits.length;
  f.engine.hydrateDocument('document', 'c'.repeat(64), { documentExcerpt: 'Deleted' });
  assert.equal(f.edits.length, deletedEdits);
  f.engine.undo();
  assert.equal(f.engine.objects.get('document').documentExcerpt, undefined);
});

test('document cards render a separate filename and metadata footer with a bounded excerpt', () => {
  const f = fixture();
  f.engine.makeView(
    { ...documentObject, documentExcerpt: 'W'.repeat(10000), documentPageCount: 4 },
    null,
    true,
    1,
    { x: 0, y: -40, width: 320, height: 440 },
  );
  const draws = f.raster.flatMap((canvas) => canvas.draws);
  assert.ok(draws.some((line) => line.value === 'project-report.pdf' && line.y > 334));
  assert.ok(draws.some((line) => line.value === 'PDF · 2 KB · 4 pages'));
  assert.ok(draws.some((line) => line.value === 'Project report' && line.y < 0));
  const excerpt = draws.filter((line) => line.value.startsWith('W'));
  assert.ok(excerpt.length > 1 && excerpt.length <= 14);
  assert.ok(excerpt.every((line) => line.value.length * 6 <= 260 && line.y < 320));
  assert.ok(excerpt.at(-1).value.endsWith('…'));
});

test('document rendering requests only its preview image, never original bytes or detail tiles', () => {
  const f = fixture();
  const previewId = 'b'.repeat(64);
  f.engine.apply({
    upserts: [{ ...documentObject, x: 0, y: 0, documentPreviewId: previewId }],
    deleted: [],
  });
  f.engine.camera.zoom = 8;
  f.engine.draw();
  assert.deepEqual(f.requested.at(-1), [previewId + '/preview']);
  f.engine.apply({ upserts: [{ ...documentObject, x: 0, y: 0 }], deleted: [] });
  f.engine.draw();
  assert.deepEqual(f.requested.at(-1), []);
});

test('document metadata and zoom changes redraw body text during title editing', () => {
  const f = fixture();
  f.engine.apply({ upserts: [documentObject], deleted: [] });
  f.engine.setEditing('document');
  f.engine.draw();
  const first = f.raster.length;
  f.engine.hydrateDocument('document', documentObject.assetId, { documentExcerpt: 'New text' });
  f.engine.draw();
  assert.ok(f.raster.length > first);
  assert.ok(f.raster.flatMap((canvas) => canvas.draws).some((line) => line.value === 'New text'));
  const second = f.raster.length;
  f.engine.camera.zoom = 2;
  f.engine.draw();
  assert.ok(f.raster.length > second, 'body captions remain sharp while the title editor is open');
});

test('document body rasterization scales with the object and only allocates its visible region', () => {
  const f = fixture();
  f.engine.makeView(
    { ...documentObject, width: 32000, height: 40000, documentTitle: '' },
    null,
    true,
    2,
    { x: 300, y: 400, width: 600, height: 500 },
  );
  assert.equal(f.raster.length, 1);
  assert.equal(f.raster[0].width, 1200);
  assert.equal(f.raster[0].height, 1000);
});

test('document export renders cards and loads preview pixels without decoding their binary originals', async () => {
  const f = fixture(),
    loads = [],
    dimensions = [];
  const previewId = 'b'.repeat(64);
  f.engine.apply({
    upserts: [
      { ...documentObject, documentPreviewId: previewId },
      {
        ...documentObject,
        id: 'text-file',
        x: 450,
        text: 'notes.txt',
        documentMime: 'text/plain',
        documentExcerpt: 'Exported content',
      },
    ],
    deleted: [],
  });
  f.engine.setSelection(['document', 'text-file']);
  await f.engine.exportCanvas(
    'selection',
    () => {},
    (id, variant) => {
      loads.push([id, variant]);
      return 'asset://' + id + '/' + variant;
    },
    'full',
    async (id) => {
      dimensions.push(id);
      return { width: 1000, height: 1400 };
    },
  );
  assert.deepEqual(dimensions, [previewId]);
  assert.deepEqual(loads, [[previewId, 'original']]);
  const captions = f.raster.flatMap((canvas) => canvas.draws).map((line) => line.value);
  assert.ok(captions.includes('project-report.pdf'));
  assert.ok(captions.includes('notes.txt'));
  assert.ok(captions.includes('Exported content'));
});

test('unavailable document preview pixels fall back to an exportable file card', async () => {
  const f = fixture({ unavailableImages: true }),
    loads = [];
  const previewId = 'b'.repeat(64);
  f.engine.apply({
    upserts: [
      { ...documentObject, documentPreviewId: previewId, documentExcerpt: 'Fallback text' },
    ],
    deleted: [],
  });
  f.engine.setSelection(['document']);
  await assert.doesNotReject(() =>
    f.engine.exportCanvas(
      'selection',
      () => {},
      (id, variant) => {
        loads.push([id, variant]);
        return 'asset://' + id + '/' + variant;
      },
      'full',
      async () => {
        throw Error('Preview unavailable');
      },
    ),
  );
  assert.deepEqual(loads, [
    [previewId, 'original'],
    [previewId, 'export'],
  ]);
  assert.ok(
    f.raster.flatMap((canvas) => canvas.draws).some((line) => line.value === 'Fallback text'),
  );
});

// Real canvas state, transforms, layout, history and render orchestration run in
// this fixture. Only browser font/raster and GPU boundaries are deterministic.
function fixture({ unavailableImages = false } = {}) {
  const modules = new Map(),
    edits = [],
    activations = [],
    raster = [],
    requested = [];
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
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
    }
    setChildIndex() {}
    getChildByLabel(label) {
      return this.children.find((child) => child.label === label);
    }
    destroy() {}
  }
  class Graphics extends Container {}
  for (const method of [
    'rect',
    'roundRect',
    'fill',
    'stroke',
    'poly',
    'circle',
    'moveTo',
    'lineTo',
    'arc',
    'save',
    'restore',
    'setTransform',
    'clear',
  ])
    Graphics.prototype[method] = function () {
      return this;
    };
  class Texture {
    constructor({ source }) {
      this.source = source;
      this.width = source.resource.width;
      this.height = source.resource.height;
    }
    static from(resource) {
      return new Texture({ source: { resource } });
    }
    destroy() {}
  }
  class Sprite extends Container {
    constructor(texture) {
      super();
      this.texture = texture;
      this.width = texture.width;
      this.height = texture.height;
    }
    once() {}
  }
  const canvas = { setAttribute() {} };
  class Application {
    canvas = canvas;
    stage = new Container();
    renderer = {
      resolution: 1,
      width: 1000,
      height: 700,
      extract: { canvas: () => ({ width: 10, height: 10 }) },
    };
    init() {
      return Promise.resolve();
    }
    render() {}
    destroy() {}
  }
  const pixi = {
    Application,
    Container,
    Graphics,
    Texture,
    Sprite,
    CanvasSource: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    Rectangle: class {
      constructor(x, y, width, height) {
        Object.assign(this, { x, y, width, height });
      }
    },
    TextStyle: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    CanvasTextMetrics: {
      measureText(text, style) {
        const lines = text.split('\n'),
          maxLineWidth = Math.min(
            style.wordWrapWidth,
            Math.max(...lines.map((line) => line.length * style.fontSize * 0.6)),
          );
        return {
          lines,
          maxLineWidth,
          width: maxLineWidth,
          height: lines.length * style.lineHeight,
        };
      },
    },
  };
  const context = {
    document: {
      documentElement: { dataset: { theme: 'light' } },
      createElement() {
        const draws = [];
        const ctx = {
          scale() {},
          translate() {},
          save() {},
          restore() {},
          beginPath() {},
          closePath() {},
          rect() {},
          roundRect() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          fill() {},
          clip() {},
          fillRect() {},
          drawImage() {},
          measureText: (value) => ({
            width: value.length * 6,
            fontBoundingBoxAscent: 10,
            fontBoundingBoxDescent: 3,
          }),
          fillText(value, x, y) {
            draws.push({ value, x, y });
          },
        };
        const result = { width: 0, height: 0, getContext: () => ctx, draws };
        raster.push(result);
        return result;
      },
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: true }),
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    devicePixelRatio: 1,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    performance: { now: () => 0 },
    crypto,
    setTimeout,
    clearTimeout,
    structuredClone,
    Image: class {
      crossOrigin = '';
      naturalWidth = 300;
      naturalHeight = 400;
      async decode() {
        if (unavailableImages) throw Error('Preview unavailable');
      }
    },
    createImageBitmap: async (_image, { resizeWidth, resizeHeight }) => ({
      width: resizeWidth,
      height: resizeHeight,
      close() {},
    }),
  };
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
  function load(path) {
    const filename = resolve(sourceRoot, path);
    if (modules.has(filename)) return modules.get(filename);
    const exports = {};
    modules.set(filename, exports);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInNewContext(code, {
      ...context,
      exports,
      require(id) {
        if (id === 'pixi.js/unsafe-eval') return {};
        if (id === 'pixi.js') return pixi;
        if (id === './night-lighting')
          return {
            NightLighting: class {
              draw() {}
              destroy() {}
            },
          };
        if (id === './textures')
          return {
            TextureCache: class {
              begin(keys) {
                requested.push([...keys]);
              }
              get() {
                return null;
              }
              failed() {
                return false;
              }
              destroy() {}
            },
          };
        if (id.startsWith('.'))
          return load(resolve(dirname(filename), id + (id.endsWith('.ts') ? '' : '.ts')));
        return require(id);
      },
    });
    return exports;
  }
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
  const engine = new (load('../src/canvas/engine.ts').Engine)(
    host,
    [],
    { x: 0, y: 0, zoom: 1 },
    {
      edit: (edit) => edits.push(edit),
      camera() {},
      selection() {},
      activate: (object) => activations.push(object.id),
      create() {},
      context() {},
      ready() {},
      error: (message) => {
        throw Error(message);
      },
    },
  );
  const event = (x, y) => ({
    target: canvas,
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    preventDefault() {},
  });
  return { engine, load, event, edits, activations, raster, requested };
}
