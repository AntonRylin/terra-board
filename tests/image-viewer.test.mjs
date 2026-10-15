import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const filename = new URL('../src/components/ImageViewer.tsx', import.meta.url);
const api = loadViewer();

function loadViewer() {
  if (!existsSync(filename)) return {};
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    document: { body: {} },
    require(id) {
      if (id.endsWith('.css')) return {};
      if (id === '../bridge') return { mediaUrl: (asset, variant) => `/asset/${asset}/${variant}` };
      if (id === 'react-dom') return { createPortal: (content) => content };
      if (id === '../canvas/page-text')
        return { canRecognizeText: () => false, imageAssetText: async () => ({ lines: [] }) };
      if (id === '../canvas/recognized-text') return { recognizedString: () => '' };
      if (id === './TextLayer')
        return {
          default: () => null,
          selectedLayerText: () => null,
          selectLayerText: () => false,
          startsTextSelection: () => false,
        };
      return require(id);
    },
  });
  return module.exports;
}
function helper(name) {
  assert.equal(typeof api[name], 'function', `${name} is implemented`);
  return api[name];
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('image fit uses intrinsic dimensions, keeps small images at native size, and fits huge images', () => {
  const fit = helper('fitImageZoom');
  assert.equal(fit({ width: 4000, height: 2000 }, { width: 1000, height: 700 }), 0.238);
  assert.equal(fit({ width: 2000, height: 4000 }, { width: 1000, height: 700 }), 0.163);
  assert.equal(fit({ width: 100, height: 80 }, { width: 1000, height: 700 }), 1);
  assert.equal(fit({ width: 100000, height: 100000 }, { width: 200, height: 160 }), 0.00112);
  assert.equal(fit({ width: 0, height: 0 }, { width: 1000, height: 700 }), 1);
});

test('image pan bounds keep a zoomed image covering the viewport and center fitting axes', () => {
  const clamp = helper('clampImageView');
  assert.deepEqual(
    plain(
      clamp(
        { zoom: 50, x: 99999, y: -99999 },
        { width: 2000, height: 1000 },
        { width: 1000, height: 600 },
      ),
    ),
    { zoom: 8, x: 7500, y: -3700 },
  );
  assert.deepEqual(
    plain(
      clamp(
        { zoom: 1, x: 500, y: 500 },
        { width: 1200, height: 200 },
        { width: 1000, height: 600 },
      ),
    ),
    { zoom: 1, x: 100, y: 0 },
  );
  assert.deepEqual(
    plain(
      clamp(
        { zoom: 0, x: 500, y: -500 },
        { width: 100000, height: 100000 },
        { width: 200, height: 160 },
      ),
    ),
    { zoom: 0.00112, x: 0, y: 0 },
  );
});

test('wheel zoom keeps the image pixel beneath the cursor fixed and round-trips without drift', () => {
  const zoom = helper('zoomImageView');
  const size = { width: 3000, height: 2400 },
    viewport = { width: 1000, height: 800 };
  const initial = { zoom: 1, x: 80, y: -30 },
    cursor = { x: 700, y: 250 };
  const enlarged = zoom(initial, 2, cursor, size, viewport);
  assert.deepEqual(plain(enlarged), { zoom: 2, x: -40, y: 90 });
  assert.deepEqual(plain(zoom(enlarged, 1, cursor, size, viewport)), initial);
  assert.equal(zoom(initial, 100, cursor, size, viewport).zoom, 8);
});

test('viewer requests the export asset and keeps original download and close controls during loading', () => {
  const Viewer = helper('default');
  const { createElement } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const object = Object.freeze({
    id: 'photo',
    type: 'image',
    assetId: 'original-image',
    text: 'mountain.tiff',
    imageTitle: 'Mountain',
    x: 10,
    y: 20,
    width: 120,
    height: 80,
    z: 1,
    rotation: 45,
    crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
  });
  const html = renderToStaticMarkup(
    createElement(Viewer, { object, onClose() {}, async onDownload() {} }),
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="Image preview"/);
  assert.match(html, /data-image-id="photo"/);
  assert.match(html, /src="\/asset\/original-image\/export"/);
  assert.match(html, /draggable="false"/);
  for (const label of ['Close image preview', 'Download image']) {
    const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
    assert.ok(button, label);
    assert.doesNotMatch(button, /disabled/);
  }
  assert.doesNotMatch(html, /rotate\(45/);
  assert.equal(object.crop.width, 0.5);
});
