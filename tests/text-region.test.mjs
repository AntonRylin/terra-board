import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { localViewport } from '../src/canvas/transform.ts';

function textRegion(dpr = 1.5) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../src/canvas/text-rendering.ts', import.meta.url), 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
    ).outputText,
    {
      exports,
      devicePixelRatio: dpr,
      require: (id) =>
        id === './transform'
          ? { localViewport }
          : id === './frame-label'
            ? { hasExternalLabel: () => false, frameLabel: () => ({ top: 0 }) }
            : {},
    },
  );
  return exports.textRegion;
}
const viewport = { width: 1600, height: 900 };
const visible = (o, c) => ({
  left: Math.max(0, -c.x / c.zoom - o.x),
  right: Math.min(o.width, (viewport.width - c.x) / c.zoom - o.x),
  top: Math.max(0, -c.y / c.zoom - o.y),
  bottom: Math.min(o.height, (viewport.height - c.y) / c.zoom - o.y),
});
const covers = (region, o, c) => {
  const v = visible(o, c);
  return (
    region.x <= v.left &&
    region.y <= v.top &&
    region.x + region.width >= v.right &&
    region.y + region.height >= v.bottom
  );
};

test('text crossing the viewport edge keeps one raster region while the board pans', () => {
  const region = textRegion();
  // A wide text box that stays cut by the left and top edges for the whole pan.
  const o = { id: 'text', type: 'text', x: -900, y: -500, width: 2400, height: 1400 };
  for (const zoom of [0.5, 1, 1.7]) {
    const regions = new Set();
    for (let pan = 0; pan < 240; pan++) {
      const c = { x: -pan, y: -pan / 2, zoom };
      const r = region(o, c, viewport.width, viewport.height, zoom);
      assert.ok(covers(r, o, c), 'everything on screen is rasterised');
      regions.add(JSON.stringify(r));
    }
    assert.ok(regions.size <= 6, `240 pan frames at ${zoom}x used ${regions.size} regions`);
  }
});

test('an object smaller than the snapping cell is rasterised whole', () => {
  const region = textRegion();
  const o = { id: 'note', type: 'note', x: -60, y: 820, width: 110, height: 100 };
  for (let pan = 0; pan < 40; pan++)
    assert.deepEqual(
      { ...region(o, { x: -pan, y: pan, zoom: 1 }, viewport.width, viewport.height, 1) },
      { x: 0, y: 0, width: 110, height: 100 },
    );
});

test('exports keep the exact clip, and a snapped region never needs a larger bitmap than allowed', () => {
  const region = textRegion();
  const o = { id: 'text', type: 'text', x: -900, y: -500, width: 2400, height: 1400 };
  const c = { x: -37, y: -11, zoom: 1 };
  assert.deepEqual(
    { ...region(o, c, viewport.width, viewport.height) },
    { x: 873, y: 447, width: 1527, height: 953 },
  );
  // At 800% on a large screen the grid would exceed the bitmap limit: fall back to the clip.
  const big = { id: 'big', type: 'text', x: -4000, y: -4000, width: 9000, height: 9000 };
  for (const zoom of [3.9, 8]) {
    const camera = { x: -13, y: -7, zoom };
    const r = region(big, camera, 3840, 2160, zoom);
    const resolution = 2 ** Math.ceil(Math.log2(zoom * 1.5));
    const exact = region(big, camera, 3840, 2160);
    assert.ok(
      r.width * resolution <= 8192 + resolution || r.width === exact.width,
      `${zoom}x requests ${r.width * resolution}px`,
    );
    assert.ok(r.x <= exact.x && r.x + r.width >= exact.x + exact.width);
  }
});
