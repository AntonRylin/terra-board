import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportPlan, exportResolution } from '../src/canvas/export-plan.ts';
import { imagePdf, encodeExport } from '../src/canvas/export-format.ts';
import { deflateSync, inflateSync } from 'node:zlib';

const a = { id: 'a', type: 'rect', x: 100, y: 200, width: 80, height: 40, z: 2 };
const b = { ...a, id: 'b', x: 120, z: 1 };
const camera = { x: -50, y: -100, zoom: 2 };
const viewport = { width: 800, height: 600 };
test('higher PDF resolution keeps physical page dimensions unchanged', () => {
  const pdf = Buffer.from(
    imagePdf(new Uint8Array([1, 2, 3]), 4096, 2048, true, { width: 600, height: 300 }),
  ).toString('latin1');
  assert.ok(pdf.includes('/Width 4096 /Height 2048'));
  assert.ok(pdf.includes('/MediaBox [0 0 600 300]'));
});
test('2K and 4K rerender at the requested longest edge, preserving portrait and landscape aspect ratios', () => {
  const landscape = exportResolution({ width: 800, height: 400 }, '2k');
  assert.deepEqual([landscape.width, landscape.height], [2048, 1024]);
  const portrait = exportResolution({ width: 400, height: 800 }, '4k');
  assert.deepEqual([portrait.width, portrait.height], [2048, 4096]);
});
test('Full quality follows original image density, independently of screen zoom, within safe limits', () => {
  const full = exportResolution({ width: 500, height: 250 }, 'full', 8);
  assert.deepEqual([full.width, full.height], [4000, 2000]);
  const huge = exportResolution({ width: 1000, height: 1000 }, 'full', 100);
  assert.ok(huge.width <= 8192 && huge.width * huge.height <= 32_000_000);
  assert.ok(huge.limited);
});
test('selected export isolates selected objects even when other objects overlap', () => {
  const plan = exportPlan([a, b], ['a'], 'selection', camera, viewport);
  assert.deepEqual(
    plan.objects.map((o) => o.id),
    ['a'],
  );
  assert.deepEqual(plan.bounds, { x: 100, y: 200, width: 80, height: 40 });
  assert.equal(plan.width, 80);
  assert.equal(plan.height, 40);
});
test('viewport exports use the exact camera rectangle and exclude offscreen objects', () => {
  const plan = exportPlan([a, b, { ...a, id: 'far', x: 9999 }], [], 'visible', camera, viewport);
  assert.deepEqual(plan.bounds, { x: 25, y: 50, width: 400, height: 300 });
  assert.deepEqual(
    plan.objects.map((o) => o.id),
    ['b', 'a'],
  );
  assert.equal(plan.width, 800);
  assert.equal(plan.height, 600);
});
test('gallery selection exports its members and keeps offscreen selection', () => {
  const gallery = { ...a, id: 'g', gallery: {}, x: 9999 };
  const child = { ...b, type: 'image', galleryId: 'g', x: 10000 };
  assert.deepEqual(
    exportPlan([gallery, child, a], ['g'], 'selection', camera, viewport).objects.map((o) => o.id),
    ['b', 'g'],
  );
});

test('frame export includes contained items once and excludes outside or partial items', () => {
  const frame = { id: 'frame', type: 'frame', x: 0, y: 0, width: 500, height: 400, z: -2 };
  const nested = { ...frame, id: 'nested', x: 50, y: 50, width: 150, height: 100, z: -1 };
  const note = { ...a, id: 'note', type: 'note', x: 70, y: 70, z: 1 };
  const photo = { ...a, id: 'photo', type: 'image', x: 200, y: 200, z: 2 };
  const arrow = { ...a, id: 'arrow', type: 'arrow', x: 300, y: 100, z: 3 };
  const edge = { ...a, id: 'edge', x: 420, y: 360, z: 4 };
  const partial = { ...a, id: 'partial', x: 480 };
  const outside = { ...a, id: 'outside', x: 600 };
  const all = [outside, note, photo, frame, nested, arrow, partial, edge];
  const plan = exportPlan(all, ['frame', 'nested', 'note'], 'selection', camera, viewport);
  assert.deepEqual(
    plan.objects.map((o) => o.id),
    ['frame', 'nested', 'note', 'photo', 'arrow', 'edge'],
  );
  assert.deepEqual(plan.bounds, { x: 0, y: 0, width: 500, height: 400 });
  assert.equal(all[0].id, 'outside', 'planning does not reorder the board');
});

test('frame export uses rotated geometry and current placement', () => {
  const frame = {
    id: 'frame',
    type: 'frame',
    x: 100,
    y: 100,
    width: 400,
    height: 200,
    rotation: 90,
    z: -1,
  };
  const inside = { ...a, id: 'inside', x: 250, y: 150, width: 40, height: 40, rotation: 45 };
  const outside = { ...inside, id: 'outside', x: 110, y: 110 };
  const ids = (items) =>
    exportPlan(items, ['frame'], 'selection', camera, viewport).objects.map((o) => o.id);
  assert.deepEqual(ids([frame, inside, outside]), ['frame', 'inside']);
  assert.deepEqual(ids([frame, { ...inside, x: 700 }, outside]), ['frame']);
});

test('frame export expands contained galleries while galleries retain explicit membership', () => {
  const frame = { id: 'frame', type: 'frame', x: 0, y: 0, width: 500, height: 400, z: -2 };
  const gallery = {
    ...frame,
    id: 'gallery',
    x: 50,
    y: 50,
    width: 200,
    height: 200,
    z: -1,
    gallery: {},
  };
  const member = { ...a, id: 'member', type: 'image', galleryId: 'gallery', x: 600 };
  const loose = { ...a, id: 'loose', x: 80, y: 80, z: 3 };
  const all = [frame, gallery, member, loose];
  assert.deepEqual(
    exportPlan(all, ['frame'], 'selection', camera, viewport).objects.map((o) => o.id),
    ['frame', 'gallery', 'member', 'loose'],
  );
  assert.deepEqual(
    exportPlan(all, ['gallery'], 'selection', camera, viewport).objects.map((o) => o.id),
    ['gallery', 'member'],
  );
});
test('empty selections fail and huge outputs scale proportionally within the pixel budget', () => {
  assert.throws(() => exportPlan([a], [], 'selection', camera, viewport), /select/i);
  const plan = exportPlan(
    [{ ...a, width: 100000, height: 100000 }],
    ['a'],
    'selection',
    camera,
    viewport,
  );
  assert.ok(plan.width <= 8192 && plan.width * plan.height <= 32_000_000);
  assert.equal(plan.width, plan.height);
});
test('PDF embeds JPEG bytes unchanged and has correct object and cross-reference offsets', () => {
  const jpeg = new Uint8Array([255, 216, 0, 10, 255, 217]);
  const pdf = Buffer.from(imagePdf(jpeg, 800, 600));
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.includes('/MediaBox [0 0 600 450]'));
  assert.ok(text.includes('/Width 800 /Height 600'));
  assert.ok(pdf.includes(jpeg));
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(xref, xref + 4), 'xref');
  const entries = text.slice(xref).split('\n').slice(3, 8);
  entries.forEach((entry, i) =>
    assert.ok(text.slice(Number(entry.slice(0, 10))).startsWith(`${i + 1} 0 obj`)),
  );
});
test('lossless PDF preserves exact RGB bytes without JPEG encoding', () => {
  const pixels = Buffer.from([1, 17, 253, 254, 9, 32]);
  const compressed = deflateSync(pixels);
  const pdf = Buffer.from(imagePdf(compressed, 2, 1, true));
  assert.ok(pdf.includes(Buffer.from('/FlateDecode')));
  assert.ok(!pdf.includes(Buffer.from('/DCTDecode')));
  const start = pdf.indexOf(Buffer.from('stream\n')) + 7;
  assert.deepEqual(inflateSync(pdf.subarray(start, start + compressed.length)), pixels);
});
test('PDF encoder preserves canvas RGB pixels exactly', async () => {
  const canvas = {
    width: 2,
    height: 1,
    getContext: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray([1, 17, 253, 255, 254, 9, 32, 255]) }),
    }),
  };
  const pdf = Buffer.from(await (await encodeExport(canvas, 'pdf')).arrayBuffer());
  const length = Number(pdf.toString('latin1').match(/\/Filter \/FlateDecode \/Length (\d+)/)[1]);
  const start = pdf.indexOf(Buffer.from('stream\n')) + 7;
  assert.deepEqual(
    inflateSync(pdf.subarray(start, start + length)),
    Buffer.from([1, 17, 253, 254, 9, 32]),
  );
});
